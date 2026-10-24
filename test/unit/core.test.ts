import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand, jsonRequested, parseInput, resolve } from "../../src/core/command.ts";
import { FornaxError } from "../../src/core/errors.ts";
import { findFleetDir, loadFleet, policyViolations, repoOwner, resolveSite } from "../../src/core/fleet.ts";
import { scrubUrl } from "../../src/core/probe.ts";
import { q } from "../../src/core/shell.ts";

const demo = defineCommand({
  name: "test demo",
  summary: "x",
  tier: "read",
  args: [{ name: "site", help: "", required: true }],
  options: { lines: { type: "number", help: "", default: 10 }, tag: { type: "list", help: "" }, force: { type: "boolean", help: "" } },
  run: async () => ({ data: null }),
});

describe("argument parsing", () => {
  test("positionals, numbers, lists, booleans", () => {
    const i = parseInput(demo, ["a.example.com", "--lines", "5", "--tag=x,y", "--tag", "z", "--force"]);
    expect(i.site).toBe("a.example.com");
    expect(i.lines).toBe(5);
    expect(i.tag).toEqual(["x", "y", "z"]);
    expect(i.force).toBe(true);
  });
  test("defaults and --no-", () => {
    const i = parseInput(demo, ["s", "--no-force"]);
    expect(i.lines).toBe(10);
    expect(i.force).toBe(false);
  });
  test("unknown options are errors with a next step", () => {
    try {
      parseInput(demo, ["s", "--nope"]);
      throw new Error("should fail");
    } catch (e) {
      expect(e).toBeInstanceOf(FornaxError);
      expect((e as FornaxError).code).toBe("unknown_option");
      expect((e as FornaxError).next).toBe("fornax test demo --help");
    }
  });
  test("missing required argument", () => {
    expect(() => parseInput(demo, [])).toThrow(/missing argument <site>/);
  });
  test("-h is --help, and help skips the argument checks", () => {
    expect(parseInput(demo, ["-h"]).help).toBe(true);
    expect(parseInput(demo, ["a", "b", "c", "--help"]).help).toBe(true);
  });
  test("other short flags are unknown options, not positionals", () => {
    expect(() => parseInput(demo, ["-f"])).toThrow(/unknown option -f/);
    const run = defineCommand({ name: "test variadic", summary: "x", tier: "read", args: [{ name: "cmd", help: "", variadic: true }], run: async () => ({ data: null }) });
    expect(parseInput(run, ["ls", "-la"]).cmd).toEqual(["ls", "-la"]);
  });
  test("switches take only true/false values, numbers are never empty", () => {
    expect(parseInput(demo, ["s", "--force=no"]).force).toBe(false);
    expect(parseInput(demo, ["s", "--force=TRUE"]).force).toBe(true);
    expect(() => parseInput(demo, ["s", "--force=maybe"])).toThrow(/is a switch/);
    expect(() => parseInput(demo, ["s", "--lines="])).toThrow(/must be a number/);
  });
  test("--json is read before parsing, and not after --", () => {
    expect(jsonRequested(["x", "--json"])).toBe(true);
    expect(jsonRequested(["x", "--json=false"])).toBe(false);
    expect(jsonRequested(["x", "--json", "--no-json"])).toBe(false);
    expect(jsonRequested(["run", "s", "--", "cmd", "--json"])).toBe(false);
  });
  test("longest command prefix wins", () => {
    expect(resolve(["test", "demo", "x"])?.def.name).toBe("test demo");
  });
});

describe("fleet", () => {
  const dir = mkdtempSync(join(tmpdir(), "fornax-"));
  mkdirSync(join(dir, "servers"));
  mkdirSync(join(dir, "deep", "er"), { recursive: true });
  writeFileSync(join(dir, "fornax.yaml"), "fleet: t\npolicies:\n  allowed_repo_owners: [acme]\n");
  writeFileSync(
    join(dir, "servers", "web-1.yaml"),
    `server: web-1
host: 10.0.0.1
php: ["8.4", "8.5"]
sites:
  shop.example.com:
    repo: acme/shop
    db: { engine: postgres }
  blog.example.com:
    repo: git@github.com:other/blog.git
    preset: static
    php: "8.4"
`,
  );

  test("found from a subdirectory", () => {
    expect(findFleetDir(join(dir, "deep", "er"))).toBe(dir);
  });

  test("defaults are derived", () => {
    const f = loadFleet({ cwd: dir });
    const s = resolveSite(f, f.servers.get("web-1")!, "shop.example.com");
    expect(s.user).toBe("shop");
    expect(s.php).toBe("8.5");
    expect(s.root).toBe("/home/shop/shop.example.com");
    expect(s.webRoot).toBe("/home/shop/shop.example.com/current/public");
    expect(s.shared).toEqual(["storage"]);
    expect(s.db).toEqual({ engine: "postgres", name: "shop", user: "shop", extensions: [], manage: true });
    const b = resolveSite(f, f.servers.get("web-1")!, "blog.example.com");
    expect(b.webRoot).toBe("/home/blog/blog.example.com/current");
  });

  test("policy: foreign repo owners are reported", () => {
    const f = loadFleet({ cwd: dir });
    const v = policyViolations(f, f.servers.get("web-1")!);
    expect(v.map((x) => x.site)).toEqual(["blog.example.com"]);
  });

  test("invalid config names the field", () => {
    const bad = mkdtempSync(join(tmpdir(), "fornax-"));
    writeFileSync(join(bad, "fornax.yaml"), "fleet: t\naccess: carrier-pigeon\n");
    expect(() => loadFleet({ cwd: bad })).toThrow(/access/);
  });

  test("no fleet → hint to init", () => {
    // the machine running the tests may keep a fleet in ~/.config/fornax/fleet: point the default elsewhere
    const before = process.env.FORNAX_FLEET;
    process.env.FORNAX_FLEET = tmpdir() + "/no-fleet-here";
    expect(() => loadFleet({ cwd: tmpdir() + "/definitely/not/here" })).toThrow();
    try {
      loadFleet({ cwd: tmpdir() + "/definitely/not/here" });
    } catch (e) {
      expect((e as FornaxError).code).toBe("no_fleet");
      expect((e as FornaxError).next).toContain("fornax init");
    } finally {
      if (before === undefined) delete process.env.FORNAX_FLEET;
      else process.env.FORNAX_FLEET = before;
    }
  });
  test("outside any fleet repo, $FORNAX_FLEET is the fleet", () => {
    const before = process.env.FORNAX_FLEET;
    process.env.FORNAX_FLEET = dir;
    try {
      expect(loadFleet({ cwd: tmpdir() + "/definitely/not/here" }).dir).toBe(dir);
    } finally {
      if (before === undefined) delete process.env.FORNAX_FLEET;
      else process.env.FORNAX_FLEET = before;
    }
  });
});

describe("helpers", () => {
  test("repo owners", () => {
    expect(repoOwner("acme/shop")).toBe("acme");
    expect(repoOwner("git@github.com:acme/shop.git")).toBe("acme");
    expect(repoOwner("https://github.com/acme/shop")).toBe("acme");
    expect(repoOwner("https://oauth2:tok@github.com/acme/shop.git")).toBe("acme");
    expect(repoOwner("file:///srv/git/shop.git")).toBeUndefined();
  });
  test("tokens are scrubbed from remotes", () => {
    expect(scrubUrl("https://oauth2:gho_secret@github.com/acme/shop.git")).toBe("https://github.com/acme/shop.git");
    expect(scrubUrl("git@github.com:acme/shop.git")).toBe("git@github.com:acme/shop.git");
  });
  test("shell quoting", () => {
    expect(q("it's")).toBe(`'it'\\''s'`);
  });
});

describe("maintenance window", async () => {
  const { checkWindow } = await import("../../src/core/plan.ts");
  const { resolve: resolveCmd } = await import("../../src/core/command.ts");
  await import("../../src/commands/index.ts");
  const h = (n: number) => String((new Date().getUTCHours() + n) % 24).padStart(2, "0") + ":00";
  const fleetWith = (window: string) => ({ config: { policies: { maintenance_window: window } } }) as any;

  test("server changes are refused outside the window, allowed inside or when forced", () => {
    expect(() => checkWindow(fleetWith(`${h(2)}-${h(3)}`), false)).toThrow(/only allows server changes/);
    expect(() => checkWindow(fleetWith(`${h(2)}-${h(3)}`), true)).not.toThrow();
    expect(() => checkWindow(fleetWith(`${h(0)}-${h(1)}`), false)).not.toThrow();
    expect(() => checkWindow(fleetWith(`${h(23)}-${h(1)}`), false)).not.toThrow(); // across midnight
  });
  test("app deploys are not restricted by the window", () => {
    const deploy = resolveCmd(["deploy", "x.example.com"])!.def;
    expect(Object.keys(deploy.options ?? {})).not.toContain("outside-window");
    expect(Object.keys(resolveCmd(["apply", "id"])!.def.options ?? {})).toContain("outside-window");
  });
});
