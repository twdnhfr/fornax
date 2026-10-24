import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_VERSION } from "../../src/core/config-version.ts";
import { FornaxError } from "../../src/core/errors.ts";
import { loadFleet, resolveSite } from "../../src/core/fleet.ts";
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

  test("commands that edit an older config work on it as written, without upgrading it", async () => {
    const dir = fleet({ "fornax.yaml": "version: 1\nfleet: t\n", "servers/web-1.yaml": "server: web-1\nhost: 203.0.113.10\nhook_domain: hook.example.com\nsites: {}\n" });
    expect(await main(["site", "add", "web-1", "shop.example.com", "--fleet", dir, "--json"])).toBe(0);
    const text = readFileSync(join(dir, "servers/web-1.yaml"), "utf8");
    expect(text).toContain("hook_domain: hook.example.com");
    expect(text).toContain("shop.example.com");
    expect(loadFleet({ cwd: dir }).servers.get("web-1")!.webhook).toMatchObject({ domain: "hook.example.com" });
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
    expect(await main(["site", "add", "web-1", "--preview", "--repo", "acme/demo", "--preset", "static", "--fleet", dir, "--json"])).toBe(0);
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
  test("without preview_domain, --preview names the site after the server's IP (sslip.io)", async () => {
    const dir = fleet({ "fornax.yaml": "version: 2\nfleet: t\n", "servers/web-1.yaml": server });
    expect(await main(["site", "add", "web-1", "--preview", "--preset", "static", "--fleet", dir, "--json"])).toBe(0);
    const names = Object.keys(loadFleet({ cwd: dir }).servers.get("web-1")!.sites);
    expect(names.find((n) => n !== "shop.example.com")).toMatch(/^[a-z]+-[a-z]+\.203-0-113-10\.sslip\.io$/);
  });
  test("without preview_domain or an IPv4 address, --preview says what to set", async () => {
    const dir = fleet({ "fornax.yaml": "version: 2\nfleet: t\n", "servers/web-1.yaml": server.replace("203.0.113.10", "web-1.example.com") });
    expect(await main(["site", "add", "web-1", "--preview", "--fleet", dir, "--json"])).toBe(1);
  });

});

describe("sites without a domain of their own", () => {
  const plain = () => fleet({ "fornax.yaml": "version: 2\nfleet: t\n", "servers/web-1.yaml": "server: web-1\nhost: 192.168.139.130\nsites: {}\n" });
  const added = (dir: string, domain: string) => loadFleet({ cwd: dir }).servers.get("web-1")!.sites[domain]!;
  test("an IP address is no site name: refused, with the sslip.io name for it", async () => {
    const dir = plain();
    expect(await main(["site", "add", "web-1", "192.168.139.130", "--preset", "static", "--fleet", dir, "--json"])).toBe(1);
    const yaml = "server: web-1\nhost: 192.168.139.130\nsites:\n  192.168.139.130:\n    preset: static\n";
    expect(loadError(fleet({ "fornax.yaml": "version: 2\nfleet: t\n", "servers/web-1.yaml": yaml })).hint).toContain("192-168-139-130.sslip.io");
  });
  test("names without public DNS get a self-signed certificate; public ones the fleet's issuer", async () => {
    const dir = plain();
    expect(await main(["site", "add", "web-1", "192-168-139-130.sslip.io", "--preset", "static", "--fleet", dir, "--json"])).toBe(0);
    expect(added(dir, "192-168-139-130.sslip.io").tls.issuer).toBe("selfsigned");
    expect(await main(["site", "add", "web-1", "app.test", "--preset", "static", "--fleet", dir, "--json"])).toBe(0);
    expect(added(dir, "app.test").tls.issuer).toBe("selfsigned");
    expect(await main(["site", "add", "web-1", "shop.example.com", "--preset", "static", "--fleet", dir, "--json"])).toBe(0);
    expect(added(dir, "shop.example.com").tls.issuer).toBeUndefined();
    expect(await main(["site", "add", "web-1", "own.test", "--preset", "static", "--tls", "none", "--fleet", dir, "--json"])).toBe(0);
    expect(added(dir, "own.test").tls.issuer).toBe("none");
  });
  const phpRepo = () => {
    const repo = mkdtempSync(join(tmpdir(), "fornax-repo-"));
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "index.php"), "<?php echo 1;\n");
    git("add", ".");
    git("commit", "-qm", "x");
    return repo;
  };
  test("a branch the repo does not have is refused when the site is added", async () => {
    const repo = phpRepo();
    const dir = plain();
    expect(await main(["site", "add", "web-1", "app.example.com", "--repo", `file://${repo}`, "--branch", "master", "--fleet", dir, "--json"])).toBe(1);
    expect(loadFleet({ cwd: dir }).servers.get("web-1")!.sites["app.example.com"]).toBeUndefined();
  });
  test("the first site says which databases provision would install for nobody", async () => {
    const dir = plain();
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
    try {
      expect(await main(["site", "add", "web-1", "app.example.com", "--preset", "php", "--db", "postgres", "--fleet", dir, "--json"])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    const notes = JSON.parse(out.join("")).notes as string[];
    expect(notes.find((n) => n.includes("provision would also install"))).toContain("mysql, which no site uses — leave it out: fornax server set web-1 --services postgres,redis,supervisor,fail2ban");
  });
  test("site add reads the preset off the repo", async () => {
    const repo = phpRepo();
    const dir = plain();
    expect(await main(["site", "add", "web-1", "app.example.com", "--repo", `file://${repo}`, "--fleet", dir, "--json"])).toBe(0);
    expect(added(dir, "app.example.com")).toMatchObject({ preset: "php", web_dir: "." });
  });
});

describe("site set", () => {
  const dir = () => fleet({ "fornax.yaml": "version: 2\nfleet: t\n", "servers/web-1.yaml": server });
  const spec = (d: string) => loadFleet({ cwd: d }).servers.get("web-1")!.sites["shop.example.com"]!;
  test("changes settings the CLI way (tls is a word, not the YAML's map)", async () => {
    const d = dir();
    expect(await main(["site", "set", "shop.example.com", "--preset", "static", "--web-dir", "dist", "--tls", "none", "--www", "--fleet", d, "--json"])).toBe(0);
    expect(spec(d)).toMatchObject({ preset: "static", web_dir: "dist", tls: { issuer: "none" }, www_redirect: true });
    expect(await main(["site", "set", "shop.example.com", "--no-www", "--fleet", d, "--json"])).toBe(0);
    expect(spec(d).www_redirect).toBe(false);
  });
  test("preset node needs a start command; leaving node drops it", async () => {
    const d = dir();
    expect(await main(["site", "set", "shop.example.com", "--preset", "node", "--fleet", d, "--json"])).toBe(1);
    expect(await main(["site", "set", "shop.example.com", "--preset", "node", "--start", "bun run start", "--fleet", d, "--json"])).toBe(0);
    expect(spec(d).node?.start).toBe("bun run start");
    expect(await main(["site", "set", "shop.example.com", "--preset", "php", "--fleet", d, "--json"])).toBe(0);
    expect(spec(d).node).toBeUndefined();
  });
  test("a change the fleet refuses as a whole is undone", async () => {
    const d = dir();
    const before = readFileSync(join(d, "servers/web-1.yaml"), "utf8");
    expect(await main(["site", "set", "shop.example.com", "--php", "7.0", "--fleet", d, "--json"])).toBe(1);
    expect(readFileSync(join(d, "servers/web-1.yaml"), "utf8")).toBe(before);
    expect(await main(["site", "set", "shop.example.com", "--fleet", d, "--json"])).toBe(1);
  });
});

describe("server set and the login", () => {
  const dir = () => fleet({ "fornax.yaml": "version: 2\nfleet: t\n", "servers/web-1.yaml": server });
  test("server add names the login and takes --ssh-user/--ssh-port", async () => {
    const d = dir();
    expect(await main(["server", "add", "web-2", "--host", "203.0.113.11", "--ssh-user", "ubuntu", "--ssh-port", "2222", "--fleet", d, "--json"])).toBe(0);
    expect(loadFleet({ cwd: d }).servers.get("web-2")!.ssh).toEqual({ user: "ubuntu", port: 2222 });
  });
  test("server set changes services and PHP; a change the fleet refuses is undone", async () => {
    const d = dir();
    expect(await main(["server", "set", "web-1", "--services", "redis,supervisor", "--php", "8.4,8.5", "--fleet", d, "--json"])).toBe(0);
    expect(loadFleet({ cwd: d }).servers.get("web-1")!).toMatchObject({ services: ["redis", "supervisor"], php: ["8.4", "8.5"] });
    // a site pinned to PHP 8.4 keeps the server from dropping it
    expect(await main(["site", "set", "shop.example.com", "--php", "8.4", "--fleet", d, "--json"])).toBe(0);
    const before = readFileSync(join(d, "servers/web-1.yaml"), "utf8");
    expect(await main(["server", "set", "web-1", "--php", "8.5", "--fleet", d, "--json"])).toBe(1);
    expect(readFileSync(join(d, "servers/web-1.yaml"), "utf8")).toBe(before);
    expect(await main(["server", "set", "web-1", "--services", "nginx", "--fleet", d, "--json"])).toBe(1);
  });
});

describe("redis and the next step", () => {
  const dir = () => fleet({ "fornax.yaml": "version: 2\nfleet: t\n", "servers/web-1.yaml": "server: web-1\nhost: 203.0.113.10\nsites: {}\n" });
  test("laravel sites get their own Redis, the other presets none unless asked", async () => {
    const d = dir();
    for (const [domain, preset, extra] of [["a.example.com", "laravel", []], ["b.example.com", "php", []], ["c.example.com", "php", ["--redis", "own"]]] as const) {
      expect(await main(["site", "add", "web-1", domain, "--preset", preset, ...extra, "--fleet", d, "--json"])).toBe(0);
    }
    const f = loadFleet({ cwd: d });
    const s = f.servers.get("web-1")!;
    expect(["a.example.com", "b.example.com", "c.example.com"].map((x) => resolveSite(f, s, x).redis)).toEqual(["own", "none", "own"]);
    expect(await main(["site", "set", "c.example.com", "--redis", "none", "--fleet", d, "--json"])).toBe(0);
    expect(await main(["site", "set", "c.example.com", "--redis", "lots", "--fleet", d, "--json"])).toBe(1);
  });
  test("a server this fleet repo never planned as a whole is provisioned next, not planned", async () => {
    const d = dir();
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
    try {
      expect(await main(["server", "set", "web-1", "--services", "redis,supervisor", "--fleet", d, "--json"])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(JSON.parse(out.join("")).next).toBe("fornax server provision web-1");
  });
});
