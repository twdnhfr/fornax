#!/usr/bin/env bun
import { commands, describeCommand, GLOBAL_OPTIONS, helpText, humanOutput, jsonRequested, parseInput, resolve, type CommandDef, type Context, type Result } from "./core/command.ts";
import { asFornaxError, FornaxError } from "./core/errors.ts";
import "./commands/index.ts";

import { BUILD, VERSION } from "./core/version.ts";

/**
 * Commands under a group ("server", "site", …): what `fornax server --help` lists. Not exact: the
 * longest part of `words` that is a group (for the hint after a mistyped subcommand).
 */
function subcommands(words: string[], exact = false): CommandDef[] {
  for (let n = words.length; n > (exact ? words.length - 1 : 0); n--) {
    const prefix = words.slice(0, n).join(" ") + " ";
    const subs = commands().filter((c) => !c.internal && c.name.startsWith(prefix));
    if (subs.length) return subs;
  }
  return [];
}

function overview(list: readonly CommandDef[], group?: string): string {
  const width = Math.max(...list.map((c) => c.name.length));
  return [
    group ? `fornax ${group} — commands:` : `fornax ${VERSION} — provision and run PHP/Laravel servers\n\ncommands:`,
    ...list.map((c) => `  ${c.name.padEnd(width)}  ${`[${c.tier}]`.padEnd(9)} ${c.summary}`),
    "",
    "`fornax <command> --help` for details, `fornax agent-context` for everything an agent needs.",
  ].join("\n");
}

/** Help for a command, a group of commands, or all of them; as JSON with --json. */
function help(words: string[], json: boolean): void {
  const found = words.length ? resolve(words) : undefined;
  if (found) {
    process.stdout.write(json ? JSON.stringify(describeCommand(found.def), null, 2) + "\n" : helpText(found.def) + "\n");
    return;
  }
  const list = words.length ? subcommands(words, true) : commands().filter((c) => !c.internal);
  if (!list.length) unknownCommand(words);
  const group = words.length ? words.join(" ") : undefined;
  if (json) {
    const data = { version: VERSION, ...(group ? { group } : {}), global_options: Object.keys(GLOBAL_OPTIONS).map((k) => `--${k}`), commands: list.map(describeCommand) };
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else process.stdout.write(overview(list, group) + "\n");
}

function unknownCommand(words: string[]): never {
  const subs = subcommands(words);
  const name = words.join(" ");
  if (subs.length) {
    const group = subs[0]!.name.split(" ").slice(0, -1).join(" ");
    throw new FornaxError("unknown_command", group === name ? `"${name}" needs a subcommand` : `unknown command "${name}"`, `one of: ${subs.map((c) => `fornax ${c.name}`).join(", ")}`, `fornax help ${group}`);
  }
  throw new FornaxError("unknown_command", name ? `unknown command "${name}"` : "no command given", undefined, "fornax help");
}

/**
 * Global options may come before the command (`fornax --json server list`): they are moved behind
 * it, but never past `--`, where they would become part of `fornax run`'s command.
 */
export function hoistOptions(argv: string[]): string[] {
  const lead: string[] = [];
  let i = 0;
  while (i < argv.length && argv[i]!.startsWith("-") && argv[i] !== "--") {
    lead.push(argv[i]!);
    if (argv[i] === "--fleet" && i + 1 < argv.length) lead.push(argv[++i]!);
    i++;
  }
  const rest = argv.slice(i);
  const dashes = rest.indexOf("--");
  return dashes < 0 ? [...rest, ...lead] : [...rest.slice(0, dashes), ...lead, ...rest.slice(dashes)];
}

function print(result: Result, json: boolean) {
  if (json) {
    process.stdout.write(JSON.stringify(result.data, null, 2) + "\n");
  } else {
    const text = humanOutput(result);
    if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  }
}

export async function main(rawArgv: string[]): Promise<number> {
  const argv = hoistOptions(rawArgv);
  const wantsJson = jsonRequested(argv);
  try {
    const dashes = argv.indexOf("--");
    const options = dashes < 0 ? argv : argv.slice(0, dashes);
    // the command path: everything before the first option
    const firstOption = argv.findIndex((a) => a.startsWith("-"));
    const words = firstOption < 0 ? argv : argv.slice(0, firstOption);
    const helpWanted = options.includes("--help") || options.includes("-h");
    if (argv[0] === "version" || (!words.length && options.includes("--version"))) {
      process.stdout.write(wantsJson ? JSON.stringify({ version: VERSION, build: BUILD ?? null }) + "\n" : `fornax ${VERSION}${BUILD ? ` (build ${BUILD})` : ""}\n`);
      return 0;
    }
    if (argv[0] === "help") {
      help(words.slice(1), wantsJson);
      return 0;
    }
    if (!words.length) {
      const stray = options.find((o, i) => o.startsWith("-") && options[i - 1] !== "--fleet" && !/^--(json|no-json|verbose|help|fleet)(=|$)|^-h$/.test(o));
      if (stray) throw new FornaxError("unknown_option", `unknown option ${stray}`, undefined, "fornax help");
      help([], wantsJson);
      return 0;
    }
    const found = resolve(argv);
    if (!found) {
      if (helpWanted && subcommands(words, true).length) {
        help(words, wantsJson);
        return 0;
      }
      unknownCommand(words);
    }
    const input = parseInput(found!.def, found!.rest);
    if (input.help) {
      help(found!.def.name.split(" "), wantsJson);
      return 0;
    }
    const ctx: Context = {
      json: Boolean(input.json),
      verbose: Boolean(input.verbose),
      cwd: process.cwd(),
      fleetDir: input.fleet as string | undefined,
      tier: found.def.tier,
      log: (line) => process.stderr.write(line + "\n"),
    };
    const result = await found!.def.run(input, ctx);
    print(result, ctx.json);
    return result.exitCode ?? 0;
  } catch (e) {
    const err = asFornaxError(e);
    if (wantsJson) process.stdout.write(JSON.stringify(err.toJSON(), null, 2) + "\n");
    else {
      process.stderr.write(`error [${err.code}]: ${err.message}\n`);
      if (err.hint) process.stderr.write(`hint: ${err.hint}\n`);
      if (err.next) process.stderr.write(`next: ${err.next}\n`);
    }
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
