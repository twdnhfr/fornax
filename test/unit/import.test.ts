import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectLocal, collectSpec, fromForgeDump, translate } from "../../src/forge/import.ts";
import { ServerSchema } from "../../src/core/schema.ts";

const FIX = join(import.meta.dir, "..", "fixtures", "forge");

describe("Forge import (offline, fixtures)", async () => {
  const data = await fromForgeDump(join(FIX, "api"), "100");
  const collected = collectLocal(join(FIX, "files"), collectSpec(data));
  const plan = translate(data, collected, { name: "old", date: "2026-01-01" });
  const server = ServerSchema.parse(plan.server);

  test("server is adopted: no modules, provider and PHP detected", () => {
    expect(server.modules).toEqual([]);
    expect(server.provider).toEqual({ type: "hetzner-cloud", id: "55501" });
    expect(server.php).toEqual(["8.4"]);
    expect(server.files.map((f) => f.path)).toEqual(["/etc/crontab"]);
  });

  test("laravel site keeps Forge's files, names and daemons", () => {
    const s = server.sites["shop.example.com"]!;
    expect(s.adopted).toBe(true);
    expect(s.repo).toBe("acme/shop");
    expect(s.aliases).toEqual(["shop.example.net"]);
    expect(s.tls).toEqual({ issuer: "existing", cert: "/etc/nginx/ssl/domains/600/700/server.crt", key: "/etc/nginx/ssl/domains/600/700/server.key" });
    expect(s.daemons[0]!.program).toBe("daemon-300");
    expect(s.deploy.enabled).toBe(false);
    expect(s.files.map((f) => f.path).sort()).toEqual(
      [
        "/etc/logrotate.d/forge-200",
        "/etc/nginx/forge-conf/200/server/headers.conf",
        "/etc/nginx/forge-conf/200/shop.example.com/before/ssl_redirect.conf",
        "/etc/nginx/forge-conf/200/site.conf",
        "/etc/nginx/sites-available/shop.example.com",
        "/etc/php/8.4/fpm/pool.d/www-shop-ab12cd34.conf",
        "/etc/supervisor/conf.d/daemon-300.conf",
      ].sort(),
    );
  });

  test("password files never reach the fleet repo", () => {
    const all = [...plan.files.keys()].join("\n");
    expect(all).not.toContain("htpasswd");
    for (const c of plan.files.values()) expect(c.toString()).not.toContain("$apr1$");
    expect(plan.warnings.some((w) => w.includes(".htpasswd-1"))).toBe(true);
  });

  test("in-place Forge sites keep deploying in place, served from the site directory", () => {
    const docs = server.sites["docs.example.com"]!;
    expect(docs.preset).toBe("static");
    expect(docs.deploy.mode).toBe("in_place");
    expect(docs.web_dir).toBe("dist");
    expect(server.sites["shop.example.com"]!.deploy.mode).toBe("releases");
  });

  test("adopted files are byte-identical copies", () => {
    const vhost = plan.files.get("adopted/old/etc/nginx/sites-available/shop.example.com")!;
    expect(vhost.equals(collected.files.get("/etc/nginx/sites-available/shop.example.com")!.content)).toBe(true);
  });
});
