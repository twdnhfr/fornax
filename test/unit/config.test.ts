import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_VERSION } from "../../src/core/config-version.ts";
import { FornaxError } from "../../src/core/errors.ts";
import { loadFleet } from "../../src/core/fleet.ts";
import { main } from "../../src/cli.ts";

function fleet(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fornax-cfg-"));
  mkdirSync(join(dir, "servers"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
const server = "server: web-1\nhost: 203.0.113.10\nsites:\n  shop.example.com:\n    repo: acme/shop\n";
const loadError = (dir: string) => {
  try {
    loadFleet({ cwd: dir });
  } catch (e) {
    return e as FornaxError;
  }
  throw new Error("expected loadFleet to fail");
};

describe("fleet config", () => {
  test("a typo in a field name is an error, not silently ignored", () => {
    const dir = fleet({ "fornax.yaml": `version: ${CONFIG_VERSION}\nfleet: t\n`, "servers/web-1.yaml": server.replace("repo: acme/shop", "repo: acme/shop\n    helth_check: /up") });
    const e = loadError(dir);
    expect(e.code).toBe("config_invalid");
    expect(e.message).toContain("helth_check");
  });

  // fleet values reach root's shell, cron, supervisor and nginx: the config refuses what could break out
  const site = (yaml: string, domain = "shop.example.com") => fleet({ "fornax.yaml": "version: 1\nfleet: t\n", "servers/web-1.yaml": `server: web-1\nhost: 203.0.113.10\nsites:\n  ${domain}:\n    repo: acme/shop\n${yaml}` });
  test.each([
    ["a cron line break", '    cron: [{ at: "* * * * *", cmd: "true\\n* * * * * root id" }]', "cron.0.cmd"],
    ["a cron time that is not one", '    cron: [{ at: "* * * * * root", cmd: "true" }]', "cron.0.at"],
    ["a supervisor program name with a quote", "    daemons: [{ cmd: php artisan horizon, program: \"x';id;'\" }]", "program"],
    ["a branch that is an option", "    branch: --upload-pack=id", "branch"],
    ["a shared path leaving the site", "    shared: [../../etc]", "shared"],
    ["an alias with a space", '    aliases: ["a.example.com b.example.com"]', "aliases"],
    ["a body size with nginx syntax", '    nginx: { client_max_body_size: "1m; return 200" }', "client_max_body_size"],
  ])("rejects %s", (_name, yaml, field) => {
    const e = loadError(site(yaml));
    expect(e.code).toBe("config_invalid");
    expect(e.message).toContain(field);
  });
  test("rejects a site domain that is not a host name", () => {
    expect(loadError(site("", "'evil.com; id #'")).code).toBe("config_invalid");
  });
  test("rejects a site that would run as a system or the admin account", () => {
    expect(loadError(site("", "backup.example.com")).message).toContain("system or admin account");
    expect(loadError(site("    user: postgres")).message).toContain("system or admin account");
  });
  test("a site taken over from Forge may keep running as forge, but is never purged", () => {
    expect(() => loadFleet({ cwd: site("    user: forge\n    adopted: true") })).not.toThrow();
    expect(loadError(site("    user: forge\n    adopted: true\n    state: absent\n    purge: true")).message).toContain("delete the admin account");
  });
  test("two sites share a user only when one moved away (absent, not purged)", () => {
    const two = (old: string) => fleet({ "fornax.yaml": "version: 1\nfleet: t\n", "servers/web-1.yaml": `server: web-1\nhost: 203.0.113.10\nsites:\n  new.example.com:\n    repo: acme/shop\n    user: shop\n  old.example.com:\n    repo: acme/shop\n    user: shop\n${old}` });
    expect(loadError(two("")).message).toContain('both use Linux user "shop"');
    expect(() => loadFleet({ cwd: two("    state: absent\n") })).not.toThrow();
    expect(loadError(two("    state: absent\n    purge: true\n")).message).toContain('both use Linux user "shop"');
  });
  test("rejects two sites on one database", () => {
    const dir = fleet({
      "fornax.yaml": "version: 1\nfleet: t\n",
      "servers/web-1.yaml": "server: web-1\nhost: 203.0.113.10\nsites:\n  x.example.com:\n    user: a-b\n    db: { engine: mysql }\n  y.example.com:\n    user: a_b\n    db: { engine: mysql }\n",
    });
    expect(loadError(dir).message).toContain("mysql database a_b");
  });

  test("version 1 → 2: the renamed fields move, the rest of the file stays as written", async () => {
    const dir = fleet({
      "fornax.yaml": "version: 1\nfleet: t\nnotify:\n  url: https://hooks.example.com/x   # team channel\n",
      "servers/web-1.yaml": "server: web-1\nhost: 203.0.113.10\nhook_domain: hook.example.com   # GitHub calls this\nhook_port: 9400\nsites:\n  shop.example.com:\n    repo: acme/shop\n    keep_releases: 3\n  blog.example.com:\n    keep_releases: 2\n    deploy: { mode: in_place }\n",
    });
    const before = loadFleet({ cwd: dir });
    expect(before.servers.get("web-1")!.webhook).toEqual({ domain: "hook.example.com", port: 9400 });
    expect(await main(["fleet", "upgrade", "--fleet", dir, "--json"])).toBe(0);
    expect(readFileSync(join(dir, "fornax.yaml"), "utf8")).toBe(`version: ${CONFIG_VERSION}\nfleet: t\nnotify:\n  webhook: https://hooks.example.com/x # team channel\n`);
    const server = readFileSync(join(dir, "servers/web-1.yaml"), "utf8");
    expect(server).toStartWith("server: web-1\nhost: 203.0.113.10\nwebhook:\n");
    expect(server).not.toContain("hook_domain");
    const after = loadFleet({ cwd: dir });
    const web = after.servers.get("web-1")!;
    expect(web.webhook).toEqual({ domain: "hook.example.com", port: 9400 });
    expect(web.sites["shop.example.com"]!.deploy.keep_releases).toBe(3);
    expect(web.sites["blog.example.com"]!.deploy).toMatchObject({ mode: "in_place", keep_releases: 2 });
    expect(after.config.notify.webhook).toBe("https://hooks.example.com/x");
  });

  test("a config newer than this fornax is refused", () => {
    expect(loadError(fleet({ "fornax.yaml": "version: 99\nfleet: t\n" })).code).toBe("config_too_new");
  });

  test("a config from before versions (and the rename) loads, and fleet upgrade writes it — comments kept", async () => {
    const dir = fleet({ "anvil.yaml": "# our private fleet\nfleet: t\nssh:\n  user: root      # aligned comment\n", "servers/web-1.yaml": server });
    expect(loadFleet({ cwd: dir }).config.version).toBe(CONFIG_VERSION);
    const code = await main(["fleet", "upgrade", "--fleet", dir, "--json"]);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "anvil.yaml"))).toBe(false);
    expect(readFileSync(join(dir, "fornax.yaml"), "utf8")).toBe(`# our private fleet\nversion: ${CONFIG_VERSION}\nfleet: t\nssh:\n  user: root      # aligned comment\n`);
    expect(readFileSync(join(dir, "servers/web-1.yaml"), "utf8")).toBe(server);
  });
});

describe("preview names", () => {
  const preview = () => fleet({ "fornax.yaml": "version: 2\nfleet: t\npreview_domain: preview.example.com\n", "servers/web-1.yaml": "server: web-1\nhost: 203.0.113.10\nsites:\n  shop.example.com:\n    repo: acme/shop\n" });
  test("site add --preview names the site under preview_domain", async () => {
    const dir = preview();
    expect(await main(["site", "add", "web-1", "--preview", "--repo", "acme/demo", "--fleet", dir, "--json"])).toBe(0);
    const names = Object.keys(loadFleet({ cwd: dir }).servers.get("web-1")!.sites);
    expect(names.find((n) => n !== "shop.example.com")).toMatch(/^[a-z]+-[a-z]+\.preview\.example\.com$/);
  });
  test("site alias --preview adds one to an existing site; a name in use is refused", async () => {
    const dir = preview();
    expect(await main(["site", "alias", "shop.example.com", "--preview", "--fleet", dir, "--json"])).toBe(0);
    const aliases = loadFleet({ cwd: dir }).servers.get("web-1")!.sites["shop.example.com"]!.aliases;
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatch(/\.preview\.example\.com$/);
    expect(await main(["site", "alias", "shop.example.com", "--add", aliases[0]!, "--fleet", dir, "--json"])).toBe(1);
    expect(await main(["site", "alias", "shop.example.com", "--remove", aliases[0]!, "--fleet", dir, "--json"])).toBe(0);
    expect(loadFleet({ cwd: dir }).servers.get("web-1")!.sites["shop.example.com"]!.aliases).toEqual([]);
  });
  test("without preview_domain, --preview says what to set", async () => {
    const dir = fleet({ "fornax.yaml": "version: 2\nfleet: t\n", "servers/web-1.yaml": server });
    expect(await main(["site", "add", "web-1", "--preview", "--fleet", dir, "--json"])).toBe(1);
  });
});
