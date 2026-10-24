import YAML from "yaml";
import { FornaxError, fail } from "./errors.ts";

/**
 * Permission tier of a command. Agents (and Claude Code allowlists) key off this:
 * - read:    never changes a server or remote API; may write local plan/cache files
 * - write:   changes servers, remote APIs or the fleet config
 * - destroy: deletes something; always needs --confirm=<name>
 */
export type Tier = "read" | "write" | "destroy";

export type OptionType = "string" | "number" | "boolean" | "list";

export interface OptionSpec {
  type: OptionType;
  help: string;
  default?: string | number | boolean | string[];
}

export interface ArgSpec {
  name: string;
  help: string;
  required?: boolean;
  /** Last positional may swallow the rest of argv. */
  variadic?: boolean;
  /** A command line (like ssh's): from its first word on, flags fornax does not know belong to it (`df -h`). */
  command?: boolean;
}

export interface Context {
  json: boolean;
  verbose: boolean;
  cwd: string;
  fleetDir?: string;
  /** Tier of the running command: write and destroy commands need a fleet named on purpose (loadFleet). */
  tier?: Tier;
  /** Progress output. Goes to stderr so stdout stays parseable. */
  log(line: string): void;
}

export interface Result {
  /** Structured result, printed as JSON with --json. */
  data: unknown;
  /** Optional human rendering; falls back to YAML of `data`. */
  human?: string;
  /** Exit code (default 0). Non-zero without throwing, e.g. "diff found changes". */
  exitCode?: number;
}

/** What a human sees of a result: its own rendering, else the data as YAML. */
export function humanOutput(result: Result): string {
  if (result.human !== undefined) return result.human;
  if (result.data === undefined || result.data === null) return "";
  return typeof result.data === "string" ? result.data : YAML.stringify(result.data);
}

export type Input = Record<string, unknown> & { _: string[] };

export interface CommandDef {
  /** Space-separated path, e.g. "server status". */
  name: string;
  summary: string;
  tier: Tier;
  args?: ArgSpec[];
  options?: Record<string, OptionSpec>;
  /** Runs on the server only (deploy machinery); hidden from agent-context lists. */
  internal?: boolean;
  /** For people at a keyboard (e.g. the dashboard): left out of agent-context, agents use the commands. */
  humanOnly?: boolean;
  /** Example invocations for help and agent-context. */
  examples?: string[];
  run(input: Input, ctx: Context): Promise<Result>;
}

const registry: CommandDef[] = [];

export function defineCommand(def: CommandDef): CommandDef {
  if (def.tier === "destroy") {
    def.options = {
      ...def.options,
      confirm: { type: "string", help: "must equal the name of the thing being destroyed" },
    };
  }
  registry.push(def);
  return def;
}

export const commands = (): readonly CommandDef[] => registry;

/** Longest command name that prefixes argv. */
export function resolve(argv: string[]): { def: CommandDef; rest: string[] } | undefined {
  let best: { def: CommandDef; rest: string[] } | undefined;
  for (const def of registry) {
    const parts = def.name.split(" ");
    if (parts.every((p, i) => argv[i] === p) && (!best || parts.length > best.def.name.split(" ").length)) {
      best = { def, rest: argv.slice(parts.length) };
    }
  }
  return best;
}

export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: "boolean", help: "print the result as JSON on stdout" },
  verbose: { type: "boolean", help: "include full output instead of a summary" },
  fleet: { type: "string", help: "fleet directory (default: nearest fornax.yaml upwards from cwd)" },
  help: { type: "boolean", help: "show help for this command" },
};

/** Parse argv against a command's spec. Unknown options are an error, never ignored. */
export function parseInput(def: CommandDef, argv: string[]): Input {
  const specs: Record<string, OptionSpec> = { ...GLOBAL_OPTIONS, ...def.options };
  const input: Input = { _: [] };
  for (const [k, s] of Object.entries(specs)) if (s.default !== undefined) input[camel(k)] = s.default;

  const variadic = (def.args ?? []).some((a) => a.variadic);
  const commandAt = (def.args ?? []).findIndex((a) => a.command);
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (commandAt >= 0 && positionals.length > commandAt && tok.startsWith("-") && !(tok.startsWith("--") && splitOnce(tok.slice(2), "=")[0] in specs)) {
      positionals.push(tok);
      continue;
    }
    if (tok === "-h") {
      input.help = true;
      continue;
    }
    // short flags do not exist: "-f" would otherwise land as a site or server name
    if (/^-[^-\d]/.test(tok) && !variadic) {
      fail("unknown_option", `unknown option ${tok} for "${def.name}"`, "fornax has long options only (-h is the one exception)", `fornax ${def.name} --help`);
    }
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }
    let [key, value] = splitOnce(tok.slice(2), "=");
    let negate = false;
    // list options are named in the singular (--module web,php); the plural is understood as well
    if (!(key in specs) && key.endsWith("s") && specs[key.slice(0, -1)]?.type === "list") key = key.slice(0, -1);
    if (!(key in specs) && key.startsWith("no-") && specs[key.slice(3)]?.type === "boolean") {
      key = key.slice(3);
      negate = true;
    }
    const spec = specs[key];
    if (!spec) {
      fail("unknown_option", `unknown option --${key} for "${def.name}"`, undefined, `fornax ${def.name} --help`);
    }
    if (spec!.type === "boolean") {
      input[camel(key)] = negate ? false : value === undefined ? true : bool(key, value);
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) fail("missing_value", `option --${key} needs a value`);
    }
    if (spec!.type === "number") {
      const n = value!.trim() === "" ? NaN : Number(value);
      if (!Number.isFinite(n)) fail("invalid_option", `--${key} must be a number, got "${value}"`);
      input[camel(key)] = n;
    } else if (spec!.type === "list") {
      const prev = (input[camel(key)] as string[] | undefined) ?? [];
      input[camel(key)] = [...(prev === spec!.default ? [] : prev), ...value!.split(",").filter(Boolean)];
    } else {
      input[camel(key)] = value;
    }
  }

  input._ = positionals;
  // with --help nothing else is checked: help never fails on the arguments around it
  if (input.help) return input;
  const args = def.args ?? [];
  args.forEach((a, idx) => {
    if (a.variadic) {
      input[camel(a.name)] = positionals.slice(idx);
    } else if (positionals[idx] !== undefined) {
      input[camel(a.name)] = positionals[idx];
    } else if (a.required) {
      fail("missing_argument", `missing argument <${a.name}> for "${def.name}"`, a.help, `fornax ${def.name} --help`);
    }
  });
  const max = args.some((a) => a.variadic) ? Infinity : args.length;
  if (positionals.length > max) {
    fail("unexpected_argument", `unexpected argument "${positionals[max]}" for "${def.name}"`, undefined, `fornax ${def.name} --help`);
  }
  return input;
}

function bool(key: string, value: string): boolean {
  const v = value.toLowerCase();
  if (["1", "true", "yes"].includes(v)) return true;
  if (["0", "false", "no"].includes(v)) return false;
  return fail("invalid_option", `--${key} is a switch: --${key}, --no-${key} or --${key}=true|false, got "${value}"`);
}

/**
 * Whether argv asks for JSON — decided before parsing, so that errors in parsing come out as JSON
 * too. Only options before `--` count (after it they belong to `fornax run`'s command).
 */
export function jsonRequested(argv: string[]): boolean {
  let json = false;
  for (const tok of argv) {
    if (tok === "--") break;
    if (tok === "--json") json = true;
    else if (tok === "--no-json") json = false;
    else if (tok.startsWith("--json=")) json = ["1", "true", "yes"].includes(tok.slice(7).toLowerCase());
  }
  return json;
}

/** A command as data: `--help --json`, `fornax help --json` and agent-context. */
export function describeCommand(def: CommandDef) {
  return {
    command: `fornax ${def.name}`,
    tier: def.tier,
    summary: def.summary,
    args: (def.args ?? []).map((a) => ({ name: a.name, required: Boolean(a.required), variadic: Boolean(a.variadic), help: a.help })),
    options: Object.entries(def.options ?? {}).map(([k, s]) => ({ name: `--${k}`, type: s.type, help: s.help, ...(s.default !== undefined ? { default: s.default } : {}) })),
    examples: def.examples ?? [],
  };
}

/** Destroy-tier commands call this with the name of what they are about to delete. */
export function requireConfirm(input: Input, expected: string): void {
  if (input.confirm !== expected) {
    throw new FornaxError(
      "confirmation_required",
      `this deletes "${expected}" — repeat the name with --confirm=${expected}`,
      "destroy-tier commands never run without an exact confirmation",
    );
  }
}

const splitOnce = (s: string, sep: string): [string, string | undefined] => {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
};

export const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export function helpText(def: CommandDef): string {
  const args = (def.args ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`) + (a.variadic ? "..." : ""));
  const lines = [`fornax ${def.name} ${args.join(" ")}`.trimEnd(), "", def.summary, "", `tier: ${def.tier}`];
  if (def.args?.length) {
    lines.push("", "arguments:");
    for (const a of def.args) lines.push(`  ${a.name.padEnd(18)} ${a.help}`);
  }
  const opts = { ...def.options, ...GLOBAL_OPTIONS };
  lines.push("", "options:");
  for (const [k, s] of Object.entries(opts)) {
    const v = s.type === "boolean" ? "" : ` <${s.type}>`;
    lines.push(`  --${(k + v).padEnd(22)} ${s.help}${s.default !== undefined ? ` (default: ${s.default})` : ""}`);
  }
  if (def.examples?.length) lines.push("", "examples:", ...def.examples.map((e) => `  ${e}`));
  return lines.join("\n");
}
