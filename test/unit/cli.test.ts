import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hoistOptions, main } from "../../src/cli.ts";
import { commands } from "../../src/core/command.ts";

// never the fleet of whoever runs the tests: an empty home and working directory
const saved = { home: process.env.HOME, fleet: process.env.FORNAX_FLEET, cwd: process.cwd() };
beforeAll(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "fornax-cli-home-"));
  delete process.env.FORNAX_FLEET;
  process.chdir(process.env.HOME);
});
afterAll(() => {
  process.env.HOME = saved.home;
  if (saved.fleet !== undefined) process.env.FORNAX_FLEET = saved.fleet;
  process.chdir(saved.cwd);
});

/** Runs the CLI in-process: exit code, stdout and stderr. */
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const write = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    return { code: await main(argv), out, err };
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
  }
}

describe("help", () => {
  test("--help and -h exit 0 for every command, with or without its arguments", async () => {
    for (const c of commands()) {
      for (const flag of ["--help", "-h"]) {
        const r = await cli(...c.name.split(" "), flag);
        expect({ command: c.name, code: r.code }).toEqual({ command: c.name, code: 0 });
      }
    }
    expect((await cli("deploy", "a.example.com", "b", "c", "--help")).code).toBe(0);
  });

  test("fornax help <command> is the command's help; an unknown one is an error", async () => {
    const r = await cli("help", "site", "add");
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("fornax site add <server> [domain]");
    const bad = await cli("help", "nosuch", "--json");
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out).code).toBe("unknown_command");
  });

  test("--help --json describes the command", async () => {
    const r = await cli("site", "add", "--help", "--json");
    const d = JSON.parse(r.out);
    expect(d.command).toBe("fornax site add");
    expect(d.tier).toBe("write");
    expect(d.args[0]).toEqual({ name: "server", required: true, variadic: false, help: "server name" });
  });

  test("a group lists its commands; without a subcommand it is an error that names them", async () => {
    const r = await cli("server", "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("server destroy");
    expect(r.out).not.toContain("site add");
    const e = await cli("server", "--json");
    expect(e.code).toBe(1);
    const err = JSON.parse(e.out);
    expect(err.code).toBe("unknown_command");
    expect(err.hint).toContain("fornax server list");
    expect(err.next).toBe("fornax help server");
  });

  test("no command: the overview, as JSON with --json", async () => {
    expect((await cli()).out).toContain("commands:");
    const r = await cli("--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).commands.length).toBe(commands().filter((c) => !c.internal).length);
  });
});

describe("output and exit codes", () => {
  test("--version, also as JSON and after other global options", async () => {
    expect((await cli("--version")).out).toStartWith("fornax ");
    expect(JSON.parse((await cli("--json", "--version")).out)).toHaveProperty("version");
    expect(JSON.parse((await cli("version", "--json")).out)).toHaveProperty("build");
  });

  test("errors: exit 1, JSON on stdout with --json, text on stderr without", async () => {
    const j = await cli("site", "add", "--json");
    expect(j.code).toBe(1);
    expect(j.err).toBe("");
    expect(JSON.parse(j.out)).toMatchObject({ code: "missing_argument", next: "fornax site add --help" });
    const t = await cli("site", "add");
    expect(t.code).toBe(1);
    expect(t.out).toBe("");
    expect(t.err).toStartWith("error [missing_argument]");
  });

  test("global options may come before the command", async () => {
    const r = await cli("--json", "site", "add");
    expect(JSON.parse(r.out).code).toBe("missing_argument");
    expect(hoistOptions(["--fleet", "f", "--json", "server", "list"])).toEqual(["server", "list", "--fleet", "f", "--json"]);
    // never past --: there they would be part of `fornax run`'s command
    expect(hoistOptions(["--json", "run", "s", "--", "ls", "-l"])).toEqual(["run", "s", "--json", "--", "ls", "-l"]);
  });

  test("--json after -- belongs to the command, not to fornax", async () => {
    const r = await cli("run", "--", "x", "--json");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toStartWith("error [");
  });

  test("an invalid server name is an argument error, not a config error", async () => {
    const r = await cli("server", "add", "Web_1", "--host", "203.0.113.10", "--json");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).code).toBe("invalid_argument");
  });
});
