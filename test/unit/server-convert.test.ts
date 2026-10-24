import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadFleet } from "../../src/core/fleet.ts";
import { planConversion, type ServerFacts } from "../../src/forge/server-convert.ts";
import { phpIni, ufwRules } from "../../src/modules/server.ts";

const fleet = loadFleet({ cwd: join(import.meta.dir, "..", "..", "examples", "fleet") });
const server = { ...fleet.servers.get("web-1")!, modules: [] as never[] };
// what red-star (a Forge server) looked like
const forge: ServerFacts = {
  timezone: "Europe/Berlin",
  autoReboot: "02:30",
  ufw: ["allow 80", "allow 443", "allow in on tailscale0", "allow from 127.0.0.1 to any port 22"],
  phpDefault: "8.4",
  tools: ["composer"],
  ini: { memory_limit: "512M", upload_max_filesize: "40M", post_max_size: "50M", max_execution_time: "0", expose_php: "", "opcache.enable": "1", "opcache.memory_consumption": "512", "opcache.max_accelerated_files": "30000", "opcache.validate_timestamps": "0", "opcache.revalidate_freq": "2" },
  redisPassword: false,
  redisOfficial: true,
  aptSources: [
    { path: "/etc/apt/sources.list.d/crowdsec_crowdsec.list", url: "https://packagecloud.io/crowdsec/crowdsec/any/" },
    { path: "/etc/apt/sources.list.d/nginx.list", url: "https://nginx.org/packages/mainline/ubuntu" },
  ],
  confd: [
    { path: "/etc/nginx/conf.d/cloudflare.conf", directives: ["real_ip_header", "set_real_ip_from"] },
    { path: "/etc/nginx/conf.d/gzip.conf", directives: ["gzip_comp_level", "gzip_min_length", "gzip_proxied", "gzip_types", "gzip_vary"] },
    { path: "/etc/nginx/conf.d/uploads.conf", directives: ["client_max_body_size"] },
    { path: "/etc/nginx/conf.d/mixed.conf", directives: ["client_max_body_size", "proxy_buffers"] },
  ],
};
const set = (areas: Parameters<typeof planConversion>[3]) => Object.fromEntries(planConversion(fleet, server, forge, areas).set.map(([p, v]) => [p.join("."), v]));

describe("server convert", () => {
  test("keeps what fornax would otherwise change unasked", () => {
    const s = set(["base", "access", "security", "web", "php", "data"]);
    expect(s.timezone).toBe("Europe/Berlin");
    expect(s.auto_reboot).toBeUndefined(); // 02:30 is fornax's default too
    expect(s.php_default).toBe("8.4");
    expect(s.tools).toEqual(["composer"]);
    expect(s.php_ini).toEqual({ upload_max_filesize: "40M", post_max_size: "50M", max_execution_time: "0", "opcache.memory_consumption": "512", "opcache.max_accelerated_files": "30000", "opcache.validate_timestamps": "0" });
    expect(s["redis.password"]).toBe(false);
    expect(s["redis.source"]).toBe("official");
    expect(s.retire).toEqual(["/etc/apt/sources.list.d/crowdsec_crowdsec.list", "/etc/nginx/conf.d/gzip.conf", "/etc/nginx/conf.d/uploads.conf"]);
  });
  test("a firewall rule on an interface stays; fornax's own and SSH's are left to fornax", () => {
    const c = planConversion(fleet, server, forge, ["access"]);
    expect(c.set).toEqual([[["firewall", "allow"], [{ on: "tailscale0" }]]]);
    expect(c.warnings.join("\n")).toContain("allow from 127.0.0.1 to any port 22");
    expect(ufwRules({ fleet, server: { ...server, firewall: { ...server.firewall, allow: [{ on: "tailscale0", proto: "tcp" }] } } } as never)).toContain("allow in on tailscale0");
  });
  test("a conf.d file with fornax's directives and others is a warning, not a retire", () => {
    expect(planConversion(fleet, server, forge, ["web"]).warnings.join("\n")).toContain("mixed.conf");
  });
  test("php_ini overrides fornax's defaults; the CLI keeps no time limit", () => {
    expect(phpIni("8.4", { max_execution_time: "0", "opcache.validate_timestamps": "0" })).toContain("opcache.validate_timestamps = 0");
    expect(phpIni("8.4", { max_execution_time: "300" }, "cli")).toContain("max_execution_time = 0");
    expect(phpIni("8.4")).toContain("max_execution_time = 60");
  });
});

describe("apt sources", () => {
  test("a repo fornax manages under another file name is retired with its module; the same file name is simply rewritten", () => {
    expect(set(["security"]).retire).toEqual(["/etc/apt/sources.list.d/crowdsec_crowdsec.list"]);
    expect(set(["web"]).retire).toEqual(["/etc/nginx/conf.d/gzip.conf", "/etc/nginx/conf.d/uploads.conf"]);
  });
});

describe("review fixes", () => {
  test("ufw opens the server's own SSH port", () => {
    const s = { ...server, ssh: { port: 2222 }, firewall: { ...server.firewall, ssh_from: ["any"] } };
    expect(ufwRules({ fleet, server: s } as never)).toContain("allow 2222/tcp");
  });
});
