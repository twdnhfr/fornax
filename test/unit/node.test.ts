import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli.ts";
import { FornaxError } from "../../src/core/errors.ts";
import { loadFleet, nodePorts, resolveSite } from "../../src/core/fleet.ts";
import { handlerFor } from "../../src/core/resource.ts";
import { nodeSlots, siteRuntime } from "../../src/core/runtime.ts";
import { desired } from "../../src/modules/index.ts";
import { nodeUnitConf, vhostConf } from "../../src/modules/site.ts";

const facts = { arch: "arm64" as const, codename: "noble", version: "24.04", phpPpa: true };

function fleet(server: string, snippets: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "fornax-node-"));
  mkdirSync(join(dir, "servers"));
  writeFileSync(join(dir, "fornax.yaml"), "version: 2\nfleet: t\ntls: { issuer: letsencrypt }\n");
  writeFileSync(join(dir, "servers", "web-1.yaml"), server);
  for (const [name, text] of Object.entries(snippets)) writeFileSync(join(dir, name), text);
  return dir;
}

const head = (tools = "[node, bun]") => `server: web-1\nhost: 203.0.113.10\ntools: ${tools}\nsites:\n`;
const app = `  app.example.com:
    repo: acme/app
    preset: node
    node: { start: bun run start -H 127.0.0.1, port: 3100 }
    aliases: [app.example.net]
    www_redirect: true
    nginx: { server: [auth.conf] }
`;

const load = (server: string) => loadFleet({ cwd: fleet(server, { "auth.conf": 'auth_basic "x";\n' }) });
const loadError = (server: string) => {
  try {
    load(server);
  } catch (e) {
    return e as FornaxError;
  }
  throw new Error("expected loadFleet to fail");
};

describe("node preset: generated config", () => {
  const f = load(head() + app);
  const server = f.servers.get("web-1")!;
  const s = resolveSite(f, server, "app.example.com");

  test("nginx proxies the site's names to the upstream of the live slot; no PHP, no document root", () => {
    const v = vhostConf(s, 9300);
    expect(v).toContain("include /var/lib/fornax/nginx/app-example-com.conf;");
    expect(v).toContain("server_name app.example.com app.example.net;\n    ssl_certificate");
    expect(v).toContain("    location / {\n        proxy_pass http://fornax-node-app-example-com;");
    expect(v).toContain("proxy_set_header X-Forwarded-Proto $scheme;");
    expect(v).toContain("proxy_set_header Connection $fornax_connection;");
    expect(v).not.toContain("fastcgi_pass");
    expect(v).not.toContain("try_files");
    expect(v).not.toMatch(/^\s*root /m);
    // a node release is checked on its own port, not through the preview socket
    expect(v).not.toContain("listen unix:");
  });
  test("keeps what every site has: www redirect, snippets, the webhook past them, ACME, dotfiles", () => {
    const v = vhostConf(s, 9300);
    expect(v).toContain("server_name www.app.example.com;");
    expect(v).toContain("location / { return 301 https://app.example.com$request_uri; }");
    expect(v).toContain("include /etc/nginx/fornax/sites/app.example.com/auth.conf;");
    expect(v).toContain("location = /.well-known/fornax-hook {\n        auth_basic off;\n        allow all;");
    expect(v).toContain("include /etc/nginx/fornax/acme.conf;");
    expect(v).toContain("location ~ /\\.(?!well-known).* { deny all; }");
    // the hook comes before the app's catch-all location
    expect(v.indexOf("fornax-hook")).toBeLessThan(v.indexOf("proxy_pass http://fornax-node"));
  });
  test("two slots: units of the site user, one port each, started from the slot's release", () => {
    const n = nodeSlots(s, s.node!.ports);
    expect(n.slots.map((x) => [x.unit, x.port])).toEqual([
      ["fornax-node-app-example-com-a.service", 3100],
      ["fornax-node-app-example-com-b.service", 3101],
    ]);
    const u = nodeUnitConf(s, n.slots[1]!);
    expect(u.startsWith("# managed by fornax")).toBe(true);
    expect(u).toContain("User=app\nGroup=app\n");
    expect(u).toContain("WorkingDirectory=/home/app/app.example.com/slot-b\n");
    expect(u).toContain("PORT=3101 HOST=127.0.0.1 HOSTNAME=127.0.0.1");
    expect(u).toContain('ExecStart=/bin/bash -c "exec bun run start -H 127.0.0.1"\n');
    // root opens the log: outside the site's home
    expect(u).toContain("StandardOutput=append:/var/log/fornax-sites/app/app.log\n");
    expect(u).toContain("NoNewPrivileges=yes");
  });
  test("resources: units, upstream (before the vhost) and the websocket map — no PHP pool, no Redis", () => {
    const ids = desired(f, server, facts).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("file:/etc/systemd/system/fornax-node-app-example-com-a.service");
    expect(ids).toContain("file:/etc/systemd/system/fornax-node-app-example-com-b.service");
    expect(ids).toContain("file:/etc/nginx/conf.d/fornax-node.conf");
    expect(ids.indexOf("check:node-upstream:app.example.com")).toBeLessThan(ids.indexOf("file:/etc/nginx/sites-available/app.example.com"));
    expect(ids.some((i) => i.includes("/fpm/pool.d/"))).toBe(false);
    expect(ids.some((i) => i.includes("fornax-redis@app"))).toBe(false);
    const units = desired(f, server, facts).find((r) => r.id === "file:/etc/systemd/system/fornax-node-app-example-com-a.service")!;
    expect(units.handler).toBe("fornax-node@app.example.com");
  });
  test("a changed unit restarts the app through a slot switch, not in place", () => {
    const h = handlerFor("fornax-node@app.example.com").reload;
    expect(h).toContain("fornax release app.example.com --restart");
    expect(h).toContain("systemctl is-active -q fornax-node-app-example-com-a.service");
  });
  test("runtime on the server: slots and upstream, health check / by default, no preview socket", () => {
    const rt = siteRuntime(f, s, []);
    expect(rt.preset).toBe("node");
    expect(rt.node!.upstream).toEqual({ file: "/var/lib/fornax/nginx/app-example-com.conf", name: "fornax-node-app-example-com" });
    expect(rt.health_check).toEqual({ url: "https://app.example.com/", host: "app.example.com", https: true });
    expect(rt.preview_socket).toBeNull();
  });
  test("removing the site stops and removes its units once nginx no longer points at them", () => {
    const gone = load(head() + app + "    state: absent\n");
    const r = desired(gone, gone.servers.get("web-1")!, facts).find((x) => x.id === "check:node-off:app.example.com")!;
    expect(r.flushBefore).toBe(true);
    expect(r.apply).toContain("systemctl disable --now fornax-node-app-example-com-a.service fornax-node-app-example-com-b.service");
    const ids = desired(gone, gone.servers.get("web-1")!, facts).map((x) => x.id);
    expect(ids).toContain("absent:/etc/nginx/conf.d/fornax-node.conf");
    // another node app still needs the map
    const other = load(head() + app + "    state: absent\n" + '  b.example.com:\n    preset: node\n    node: { start: "node server.js" }\n');
    expect(desired(other, other.servers.get("web-1")!, facts).map((x) => x.id)).toContain("file:/etc/nginx/conf.d/fornax-node.conf");
  });
});

describe("node preset: what other sites keep", () => {
  test("laravel, php and static sites get no node config, and keep their preview socket", () => {
    const f = loadFleet({ cwd: join(import.meta.dir, "..", "..", "examples", "fleet") });
    const server = f.servers.get("web-1")!;
    const shop = resolveSite(f, server, "shop.example.com");
    expect(shop.node).toBeUndefined();
    const rt = siteRuntime(f, shop, []);
    expect("node" in rt).toBe(false);
    expect(rt.preview_socket).toBe("/run/fornax-nginx/shop-example-com.sock");
    expect(desired(f, server, facts).some((r) => r.id.includes("fornax-node"))).toBe(false);
  });
});

describe("node preset: validation", () => {
  test("ports: derived from the domain, the same every time, in 20000–27999; or node.port and the next", () => {
    const [p, q] = nodePorts("app.example.com");
    expect(nodePorts("app.example.com")).toEqual([p, q]);
    expect(q).toBe(p + 1);
    expect(p).toBeGreaterThanOrEqual(20000);
    expect(q).toBeLessThanOrEqual(27999);
    expect(nodePorts("app.example.com", 3100)).toEqual([3100, 3101]);
  });
  test.each([
    ["no start command", "  a.example.com:\n    preset: node\n", "needs node.start"],
    ["a start command with shell syntax", '  a.example.com:\n    preset: node\n    node: { start: "node server.js; id" }\n', "node.start"],
    ["node: on a PHP site", '  a.example.com:\n    preset: php\n    node: { start: "node server.js" }\n', "is for preset node"],
    ["in-place deploys", '  a.example.com:\n    preset: node\n    node: { start: "node server.js" }\n    deploy: { mode: in_place }\n', "in_place"],
  ])("rejects %s", (_name, site, message) => {
    const e = loadError(head() + site);
    expect(e.code).toBe("config_invalid");
    expect(e.message).toContain(message);
  });
  test("the runtime the start command needs must be on the server", () => {
    expect(loadError(head("[composer]") + '  a.example.com:\n    preset: node\n    node: { start: "node server.js" }\n').message).toContain("needs node on the server");
    expect(loadError(head("[node]") + '  a.example.com:\n    preset: node\n    node: { start: "bun run start" }\n').message).toContain("needs bun on the server");
    // a build that uses bun needs it too
    expect(loadError(head("[node]") + '  a.example.com:\n    preset: node\n    node: { start: "node server.js" }\n    deploy: { commands: "bun install && bun run build" }\n').message).toContain("needs bun");
    expect(() => load(head("[bun]") + '  a.example.com:\n    preset: node\n    node: { start: "bun server.ts" }\n')).not.toThrow();
  });
  test("ports are unique on a server: other node apps (both slots), proxies, the webhook", () => {
    const node = (d: string, port: number) => `  ${d}:\n    preset: node\n    node: { start: "node server.js", port: ${port} }\n`;
    expect(loadError(head() + node("a.example.com", 3100) + node("b.example.com", 3101)).message).toContain("port 3101");
    expect(loadError(head() + node("a.example.com", 9299)).message).toContain("the deploy webhook");
    expect(loadError(head() + node("a.example.com", 8080) + "  c.example.com:\n    proxies: [{ domain: ws.example.com, port: 8080 }]\n").message).toContain("the proxy ws.example.com");
    // an absent site's ports are free again
    expect(() => load(head() + node("a.example.com", 3100) + node("b.example.com", 3100) + "    state: absent\n")).not.toThrow();
  });
  test("site add --preset node needs --start and writes node.start", async () => {
    const dir = fleet("server: web-1\nhost: 203.0.113.10\ntools: [node, bun]\nsites: {}\n");
    expect(await main(["site", "add", "web-1", "app.example.com", "--preset", "node", "--fleet", dir, "--json"])).not.toBe(0);
    expect(await main(["site", "add", "web-1", "app.example.com", "--preset", "node", "--start", "bun run start", "--fleet", dir, "--json"])).toBe(0);
    expect(readFileSync(join(dir, "servers", "web-1.yaml"), "utf8")).toContain("start: bun run start");
  });
});
