import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadFleet, resolveSite, sites } from "../../src/core/fleet.ts";
import { applyScript, computeChanges, parseProbe, probeScript } from "../../src/core/plan.ts";
import { absent, file, packages } from "../../src/core/resource.ts";
import { assertOrder, desired } from "../../src/modules/index.ts";
import { cronConf, daemonConf, poolConf, vhostConf } from "../../src/modules/site.ts";
import { ufwRules } from "../../src/modules/server.ts";

const fleet = loadFleet({ cwd: join(import.meta.dir, "..", "..", "examples", "fleet") });
const server = fleet.servers.get("web-1")!;
const shop = resolveSite(fleet, server, "shop.example.com");
const docs = resolveSite(fleet, server, "docs.example.com");
const ctx = { fleet, server, sites: sites(fleet, server), facts: { arch: "arm64" as const, codename: "noble", version: "24.04", phpPpa: true }, admin: "fornax" };

describe("example fleet", () => {
  test("loads and resolves", () => {
    expect(shop.user).toBe("shop");
    expect(docs.webRoot).toBe("/home/docs/docs.example.com/current/dist");
  });
  test("desired state has unique resource ids and a sane order", () => {
    const r = desired(fleet, server, ctx.facts);
    const ids = r.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    // apt repo before its packages, cert before the vhost that uses it
    expect(ids.indexOf("file:/etc/apt/sources.list.d/nginx.list")).toBeLessThan(ids.indexOf("packages:nginx"));
    expect(ids.indexOf("check:tls:shop.example.com")).toBeLessThan(ids.indexOf("file:/etc/nginx/sites-available/shop.example.com"));
  });
});

describe("templates", () => {
  test("laravel vhost: https, www redirect, php socket, snippet", () => {
    const v = vhostConf(shop);
    expect(v).toContain("server_name shop.example.com shop.example.net www.shop.example.com;");
    expect(v).toContain("return 301 https://shop.example.com$request_uri;");
    expect(v).toContain("ssl_certificate /etc/letsencrypt/live/shop.example.com/fullchain.pem;");
    expect(v).toContain("fastcgi_pass unix:/run/php/php8.5-fpm-shop-example-com.sock;");
    expect(v).toContain("include /etc/nginx/fornax/sites/shop.example.com/cache-assets.conf;");
    expect(v).toContain("include /etc/nginx/fornax/acme.conf;");
    expect(v.startsWith("# managed by fornax")).toBe(true);
  });
  test("redirect names go straight to the domain over http and https, and are in the certificate", () => {
    const r = { ...shop, spec: { ...shop.spec, redirects: ["shop.example.org", "www.shop.example.org"] }, certNames: [...shop.certNames, "shop.example.org", "www.shop.example.org"] };
    const v = vhostConf(r);
    expect(v).toContain("server_name shop.example.org www.shop.example.org;\n    include /etc/nginx/fornax/acme.conf;\n    location / { return 301 https://shop.example.com$request_uri; }");
    expect(v).toContain("server_name www.shop.example.com shop.example.org www.shop.example.org;");
    // served names stay served: the app's server block does not answer for them
    expect(v).toContain("server_name shop.example.com shop.example.net;\n    ssl_certificate");
    const f = loadFleet({ cwd: join(import.meta.dir, "..", "..", "examples", "fleet") });
    f.servers.get("web-1")!.sites["shop.example.com"]!.redirects = ["shop.example.org"];
    expect(resolveSite(f, f.servers.get("web-1")!, "shop.example.com").certNames).toContain("shop.example.org");
  });
  test("push-to-deploy on the site's own domain: one hook location, past basic auth and IP rules", () => {
    const v = vhostConf(shop, 9300);
    expect(v).toContain("location = /.well-known/fornax-hook {\n        auth_basic off;\n        allow all;\n        proxy_pass http://127.0.0.1:9300/fornax/hook/shop.example.com;");
    // in the public server block only, not in the pre-activation one
    expect(v.split("location = /.well-known/fornax-hook").length).toBe(2);
    expect(vhostConf(shop)).not.toContain("fornax-hook");
  });
  test("site snippets (basic auth, IP gates) guard the public names, not the local pre-activation check", () => {
    const v = vhostConf(shop);
    const [publicPart, preview] = v.split(/server \{\n    listen unix:/);
    expect(publicPart).toContain("include /etc/nginx/fornax/sites/shop.example.com/cache-assets.conf;");
    expect(preview).not.toContain("/etc/nginx/fornax/sites/shop.example.com/");
  });
  test("static vhost has no PHP", () => {
    const v = vhostConf(docs);
    expect(v).not.toContain("fastcgi_pass");
    expect(v).toContain("try_files $uri $uri/ $uri.html =404;");
  });
  test("pool: ini comment, socket owned by the nginx user", () => {
    const p = poolConf(ctx, shop);
    expect(p.startsWith("; managed by fornax")).toBe(true);
    expect(p).toContain("listen.owner = fornax");
    expect(p).toContain("listen.mode = 0660");
  });
  test("daemon and cron", () => {
    expect(daemonConf(shop, shop.spec.daemons[0]!, 0)).toContain("[program:fornax-shop-example-com-horizon]");
    expect(daemonConf(shop, shop.spec.daemons[0]!, 0)).toContain("stopwaitsecs=3600");
    expect(cronConf(shop)).toContain("* * * * * shop cd /home/shop/shop.example.com/current && php8.5 artisan schedule:run");
    expect(cronConf(docs)).toBeUndefined();
  });
  test("firewall allows ssh from anywhere in ssh mode", () => {
    expect(ufwRules(ctx)).toEqual(["allow 80/tcp", "allow 443/tcp", "allow 22/tcp"]);
  });
});

describe("plan engine", () => {
  const rs = [file("/etc/x", "hello\n", { owner: "t" }), absent("/etc/old", { owner: "t" }), packages("p", ["b", "a"], { owner: "t" })];
  test("probe output parses even without trailing newlines", () => {
    const out = "\n@@0\nmissing\n@@1\npresent\n@@2\na\n@@end\n";
    const states = parseProbe(out, rs);
    expect(states).toEqual({ "file:/etc/x": "missing", "absent:/etc/old": "present", "packages:p": "a" });
    const { changes } = computeChanges(rs, states);
    expect(changes.map((c) => [c.action, c.summary])).toEqual([
      ["create", "/etc/x"],
      ["delete", "remove /etc/old"],
      ["install", "install b"],
    ]);
  });
  test("scripts are valid bash", () => {
    for (const script of [probeScript(rs), applyScript(rs, ["8.4"])]) {
      const p = Bun.spawnSync(["bash", "-n"], { stdin: new Blob([script]) });
      expect(p.stderr.toString()).toBe("");
      expect(p.exitCode).toBe(0);
    }
  });
});

describe("retired files", () => {
  test("a link in sites-enabled goes before the file it points to (each retire validates nginx first)", () => {
    const retire = ["/etc/nginx/sites-available/old.example.com", "/etc/nginx/sites-enabled/old.example.com"];
    const withRetire = { ...server, sites: { ...server.sites, "shop.example.com": { ...server.sites["shop.example.com"]!, retire } } };
    const ids = desired(fleet, withRetire, ctx.facts).map((x) => x.id);
    expect(ids.indexOf("absent:/etc/nginx/sites-enabled/old.example.com")).toBeLessThan(ids.indexOf("absent:/etc/nginx/sites-available/old.example.com"));
  });
});

describe("order of steps", () => {
  const facts = { ...ctx.facts };
  test("single sites on a server fornax never set up are refused, with provision next", () => {
    expect(() => assertOrder(server, facts, { modules: [], sites: ["shop.example.com"] })).toThrow("not set up yet");
    try {
      assertOrder(server, facts, { modules: [], sites: ["shop.example.com"] });
    } catch (e) {
      expect((e as { next?: string }).next).toBe("fornax server provision web-1");
    }
  });
  test("the whole server, its modules, a set-up server and servers without fornax's web stack pass", () => {
    expect(() => assertOrder(server, facts, { modules: [], sites: [] })).not.toThrow();
    expect(() => assertOrder(server, facts, { modules: ["base", "access"], sites: [] })).not.toThrow();
    expect(() => assertOrder(server, { ...facts, provisioned: true }, { modules: [], sites: ["shop.example.com"] })).not.toThrow();
    expect(() => assertOrder({ ...server, modules: [] }, facts, { modules: [], sites: ["shop.example.com"] })).not.toThrow();
  });
});
