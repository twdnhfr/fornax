/**
 * `fornax server convert`: hand a taken-over server's own configuration to fornax, module by module.
 * The server is read first (read-only) and what fornax's modules would otherwise change without
 * being asked — time zone, reboots, PHP's default and php.ini, tools, firewall rules, Redis — goes
 * into the fleet repo as it is; then the module is switched on. The plan that follows shows only
 * what fornax changes on purpose (e.g. MySQL and Redis on 127.0.0.1) — review it, then apply.
 */
import type { Fleet } from "../core/fleet.ts";
import { all, FACT_FN, one, parseFacts } from "../core/probe.ts";
import { MODULES, type Server } from "../core/schema.ts";
import { runnerFor } from "../core/ssh.ts";
import { PHP_INI_DEFAULTS } from "../modules/server.ts";

export const SERVER_AREAS = MODULES;
export type ServerArea = (typeof MODULES)[number];

/** Directives fornax's nginx.conf sets in `http {}`: a taken-over conf.d file that sets one too makes `nginx -t` fail. */
const NGINX_HTTP = new Set(["sendfile", "tcp_nopush", "types_hash_max_size", "server_names_hash_bucket_size", "server_tokens", "default_type", "log_format", "access_log", "gzip", "gzip_comp_level", "gzip_min_length", "gzip_proxied", "gzip_vary", "gzip_types", "gzip_http_version", "client_max_body_size", "fastcgi_read_timeout"]);

const PROBE = `${FACT_FN}
fact tz "$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone)"
r=$(grep -rhs '^Unattended-Upgrade::Automatic-Reboot ' /etc/apt/apt.conf.d/ | tail -1)
t=$(grep -rhs '^Unattended-Upgrade::Automatic-Reboot-Time' /etc/apt/apt.conf.d/ | tail -1 | sed -n 's/.*"\\(.*\\)".*/\\1/p')
case "$r" in *true*) fact reboot "\${t:-02:00}";; *) fact reboot false;; esac
ufw show added 2>/dev/null | sed -n 's/^ufw //p' | while read -r l; do fact ufw "$l"; done
fact php_default "$(readlink -f /usr/bin/php 2>/dev/null | sed 's#^/usr/bin/php##')"
[ -x /usr/local/bin/composer ] && fact tool composer
[ -x /usr/local/bin/bun ] && fact tool bun
ls /etc/apt/sources.list.d/ 2>/dev/null | grep -q nodesource && dpkg -s nodejs >/dev/null 2>&1 && fact tool node
v=$(readlink -f /usr/bin/php 2>/dev/null | sed 's#^/usr/bin/php##')
if [ -n "$v" ] && [ -f /etc/php/$v/fpm/php.ini ]; then
  PHP_INI_SCAN_DIR=/etc/php/$v/fpm/conf.d php$v -c /etc/php/$v/fpm/php.ini -r 'foreach ($argv as $i => $k) { if ($i) echo "ini\\t", $k, "=", ini_get($k), "\\n"; }' ${Object.keys(PHP_INI_DEFAULTS).join(" ")} 2>/dev/null
fi
grep -qsE '^\\s*requirepass ' /etc/redis/redis.conf /etc/redis/*.conf && fact redis_password yes || fact redis_password no
apt-cache policy redis-server 2>/dev/null | grep -q packages.redis.io && fact redis_source official
for f in /etc/nginx/conf.d/*.conf; do
  [ -f "$f" ] || continue; case "$f" in */fornax-*) continue;; esac
  # the first word of each statement (a statement may span lines, as gzip_types does)
  fact confd "$f $(sed 's/#.*//' "$f" | tr '\\n' ' ' | tr ';' '\\n' | awk 'NF {print $1}' | sort -u | tr '\\n' ',')"
done
true`;

export interface ServerFacts {
  timezone?: string;
  autoReboot: string | false;
  ufw: string[];
  phpDefault?: string;
  tools: string[];
  ini: Record<string, string>;
  redisPassword: boolean;
  redisOfficial: boolean;
  confd: { path: string; directives: string[] }[];
}

export async function readServer(fleet: Fleet, server: Server): Promise<ServerFacts> {
  const out = await runnerFor(fleet, server).run(PROBE, { timeoutMs: 120_000 });
  const f = parseFacts(out.stdout);
  const reboot = one(f, "reboot");
  return {
    timezone: one(f, "tz") || undefined,
    autoReboot: !reboot || reboot === "false" ? false : reboot,
    ufw: all(f, "ufw"),
    phpDefault: one(f, "php_default") || undefined,
    tools: all(f, "tool"),
    ini: Object.fromEntries(all(f, "ini").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])),
    redisPassword: one(f, "redis_password") === "yes",
    redisOfficial: one(f, "redis_source") === "official",
    confd: all(f, "confd").map((l) => ({ path: l.split(" ")[0]!, directives: (l.split(" ")[1] ?? "").split(",").filter(Boolean) })),
  };
}

/** php.ini as ini_get reports it ("" for Off, "1" for On) next to fornax's default: the same setting? */
function sameIni(key: string, server: string, ours: string): boolean {
  const norm = (v: string) => {
    const x = v.trim().toLowerCase();
    if (x === "" || x === "off" || x === "0" || x === "false") return "0";
    if (x === "on" || x === "1" || x === "true") return "1";
    return x;
  };
  return key === "expose_php" ? norm(server) === norm(ours) : server.trim().toLowerCase() === ours.trim().toLowerCase();
}

/** One ufw rule as `ufw show added` prints it → a firewall.allow entry; undefined when fornax writes it anyway. */
function ufwToAllow(rule: string, sshPort: number): Record<string, unknown> | "ssh" | undefined {
  if (/^allow (80|443)(\/tcp)?$/.test(rule)) return undefined;
  let m = rule.match(/^allow in on ([\w.-]+)(?: from (\S+))?(?: to any port (\d+(?::\d+)?) proto (tcp|udp))?$/);
  if (m) return { on: m[1], ...(m[2] ? { from: m[2] } : {}), ...(m[3] ? { port: /:/.test(m[3]) ? m[3] : Number(m[3]), proto: m[4] } : {}) };
  m = rule.match(/^allow from (\S+) to any port (\d+(?::\d+)?)(?: proto (tcp|udp))?$/);
  if (m) return Number(m[2]) === sshPort ? "ssh" : { port: /:/.test(m[2]!) ? m[2] : Number(m[2]), proto: m[3] ?? "tcp", from: m[1] };
  m = rule.match(/^allow (\d+(?::\d+)?)(?:\/(tcp|udp))?$/);
  if (m) return Number(m[1]) === sshPort ? "ssh" : { port: /:/.test(m[1]!) ? m[1] : Number(m[1]), proto: m[2] ?? "tcp" };
  return { unknown: rule };
}

export interface ServerConversion {
  /** YAML keys to set on the server, by path. */
  set: [string[], unknown][];
  changes: string[];
  warnings: string[];
}

/** What the server file needs so that switching these modules on changes only what fornax changes on purpose. */
export function planConversion(fleet: Fleet, server: Server, facts: ServerFacts, areas: ServerArea[]): ServerConversion {
  const set: [string[], unknown][] = [];
  const changes: string[] = [];
  const warnings: string[] = [];
  if (areas.includes("base")) {
    if (facts.timezone && facts.timezone !== server.timezone) {
      set.push([["timezone"], facts.timezone]);
      changes.push(`timezone: ${facts.timezone} (as on the server)`);
    }
    if (facts.autoReboot !== server.auto_reboot) {
      set.push([["auto_reboot"], facts.autoReboot]);
      changes.push(`auto_reboot: ${facts.autoReboot === false ? "false (it does not reboot by itself today)" : facts.autoReboot}`);
    }
  }
  if (areas.includes("access")) {
    const allow: Record<string, unknown>[] = [];
    for (const rule of facts.ufw) {
      const a = ufwToAllow(rule, server.ssh?.port ?? fleet.config.ssh.port);
      if (a === undefined) continue;
      if (a === "ssh") {
        warnings.push(`firewall rule "${rule}" goes: SSH is opened the fleet's way (${fleet.config.access === "tailscale" ? "on tailscale0" : `firewall.ssh_from: ${server.firewall.ssh_from.join(", ")}`})`);
        continue;
      }
      if ("unknown" in a) {
        warnings.push(`firewall rule "${rule}" is not understood and would be removed — add it to firewall.allow by hand before applying`);
        continue;
      }
      // with access tailscale fornax opens 22 on tailscale0 itself
      if (a.on === "tailscale0" && a.port === 22 && fleet.config.access === "tailscale") continue;
      allow.push(a);
    }
    const known = new Set(server.firewall.allow.map((x) => JSON.stringify(x)));
    const fresh = allow.filter((x) => !known.has(JSON.stringify({ proto: "tcp", ...x })) && !known.has(JSON.stringify(x)));
    if (fresh.length) {
      set.push([["firewall", "allow"], [...server.firewall.allow, ...fresh]]);
      for (const x of fresh) changes.push(`firewall.allow: ${JSON.stringify(x)}`);
    }
  }
  if (areas.includes("web")) {
    const retire = [...server.retire];
    for (const c of facts.confd) {
      const clash = c.directives.filter((d) => NGINX_HTTP.has(d));
      if (!clash.length) continue;
      if (clash.length === c.directives.length) {
        if (!retire.includes(c.path)) {
          retire.push(c.path);
          changes.push(`retire: ${c.path} (${clash.join(", ")} — fornax's nginx.conf sets these)`);
        }
      } else {
        warnings.push(`${c.path} sets ${clash.join(", ")} (also in fornax's nginx.conf) next to other directives — nginx -t would fail; move the rest into a file of its own, then convert again`);
      }
    }
    if (retire.length !== server.retire.length) set.push([["retire"], retire]);
  }
  if (areas.includes("php")) {
    const def = server.php_default ?? server.php[server.php.length - 1];
    if (facts.phpDefault && facts.phpDefault !== def) {
      set.push([["php_default"], facts.phpDefault]);
      changes.push(`php_default: ${facts.phpDefault} (the CLI's php today)`);
    }
    // a tool the server does not have yet would be installed: only what is there stays
    const keep = server.tools.filter((t) => facts.tools.includes(t));
    if (keep.length !== server.tools.length) {
      set.push([["tools"], keep]);
      changes.push(`tools: [${keep.join(", ")}] (what is installed — nothing new)`);
    }
    const ini: Record<string, string> = { ...server.php_ini };
    for (const [k, v] of Object.entries(facts.ini)) {
      const ours = server.php_ini[k] ?? PHP_INI_DEFAULTS[k];
      if (ours === undefined || sameIni(k, v, ours)) continue;
      ini[k] = v === "" ? "Off" : v;
      changes.push(`php_ini: ${k} = ${ini[k]} (fornax's default: ${PHP_INI_DEFAULTS[k]})`);
    }
    if (Object.keys(ini).length !== Object.keys(server.php_ini).length) set.push([["php_ini"], ini]);
  }
  if (areas.includes("data") && server.services.includes("redis")) {
    if (!facts.redisPassword && server.redis.password) {
      set.push([["redis", "password"], false]);
      changes.push("redis.password: false (the apps' .env has none today; set it later together with REDIS_PASSWORD)");
    }
    if (facts.redisOfficial && server.redis.source !== "official") {
      set.push([["redis", "source"], "official"]);
      changes.push("redis.source: official (installed from packages.redis.io)");
    }
  }
  return { set, changes, warnings };
}
