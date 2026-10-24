#!/usr/bin/env bun
import YAML from "yaml";
import { commands, helpText, parseInput, resolve, type Context, type Result } from "./core/command.ts";
import { FornaxError } from "./core/errors.ts";
import "./commands/index.ts";

import { BUILD, VERSION } from "./core/version.ts";

function overview(): string {
  const visible = commands().filter((c) => !c.internal);
  const width = Math.max(...visible.map((c) => c.name.length));
  return [
    `fornax ${VERSION} — provision and run PHP/Laravel servers`,
    "",
    "commands:",
    ...visible.map((c) => `  ${c.name.padEnd(width)}  [${c.tier}]  ${c.summary}`),
    "",
    "`fornax <command> --help` for details, `fornax agent-context` for everything an agent needs.",
  ].join("\n");
}

function print(result: Result, json: boolean) {
  if (json) {
    process.stdout.write(JSON.stringify(result.data, null, 2) + "\n");
  } else if (result.human !== undefined) {
    if (result.human) process.stdout.write(result.human.endsWith("\n") ? result.human : result.human + "\n");
  } else if (result.data !== undefined && result.data !== null) {
    process.stdout.write(typeof result.data === "string" ? result.data + "\n" : YAML.stringify(result.data));
  }
}

export async function main(argv: string[]): Promise<number> {
  const wantsJson = argv.includes("--json");
  try {
    if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
      const target = argv[0] === "help" ? resolve(argv.slice(1)) : undefined;
      process.stdout.write((target ? helpText(target.def) : overview()) + "\n");
      return 0;
    }
    if (argv[0] === "--version" || argv[0] === "version") {
      process.stdout.write(wantsJson ? JSON.stringify({ version: VERSION, build: BUILD ?? null }) + "\n" : `fornax ${VERSION}${BUILD ? ` (build ${BUILD})` : ""}\n`);
      return 0;
    }
    const found = resolve(argv);
    if (!found) {
      throw new FornaxError("unknown_command", `unknown command "${argv.filter((a) => !a.startsWith("-")).join(" ")}"`, undefined, "fornax help");
    }
    const input = parseInput(found.def, found.rest);
    if (input.help) {
      process.stdout.write(helpText(found.def) + "\n");
      return 0;
    }
    const ctx: Context = {
      json: Boolean(input.json),
      verbose: Boolean(input.verbose),
      cwd: process.cwd(),
      fleetDir: input.fleet as string | undefined,
      log: (line) => process.stderr.write(line + "\n"),
    };
    const result = await found.def.run(input, ctx);
    print(result, ctx.json);
    return result.exitCode ?? 0;
  } catch (e) {
    const err =
      e instanceof FornaxError ? e : new FornaxError("internal_error", (e as Error)?.message ?? String(e), "this is a bug in fornax", undefined, { stack: (e as Error)?.stack });
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
