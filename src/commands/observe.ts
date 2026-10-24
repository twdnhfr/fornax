import { defineCommand } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { findSite, getServer, siteRedis, loadFleet, policyViolations, sites, type Fleet, type ResolvedSite } from "../core/fleet.ts";
import { all, FACT_FN, num, one, parseFacts, scrubUrl } from "../core/probe.ts";
import type { Server } from "../core/schema.ts";
import { asUser, q } from "../core/shell.ts";
import { DEPLOY_LOG_DIR, nodeSlots, SITE_LOG_DIR } from "../core/runtime.ts";
import { runnerFor, tail } from "../core/ssh.ts";

const UNITS = ["nginx", "mysql", "postgresql", "redis-server", "memcached", "supervisor", "fail2ban", "crowdsec", "ufw", "tailscaled", "cron", "fornax-hook", "ssh"];

const STATUS_SCRIPT = `${FACT_FN}
. /etc/os-release; fact os "$PRETTY_NAME"; fact kernel "$(uname -r)"; fact arch "$(uname -m)"
fact uptime "$(cut -d. -f1 /proc/uptime)"; fact load "$(cut -d' ' -f1-3 /proc/loadavg)"; fact cpus "$(nproc)"
free -b | awk '/^Mem:/{print "mem_total\\t"$2"\\nmem_available\\t"$7} /^Swap:/{print "swap_total\\t"$2"\\nswap_used\\t"$3}'
df -B1 --output=size,used,avail / | awk 'NR==2{print "disk_total\\t"$1"\\ndisk_used\\t"$2"\\ndisk_free\\t"$3}'
[ -f /var/run/reboot-required ] && fact reboot_required yes || fact reboot_required no
fact upgradable "$(apt list --upgradable 2>/dev/null | grep -c upgradable || true)"
for u in ${UNITS.join(" ")} $(systemctl list-unit-files --no-legend 'php*-fpm.service' 2>/dev/null | awk '{print $1}' | sed 's/.service$//'); do
  systemctl cat "$u" >/dev/null 2>&1 || continue
  fact unit "$u $(systemctl is-active "$u" 2>/dev/null) $(systemctl is-enabled "$u" 2>/dev/null)"
done
systemctl --failed --no-legend --plain 2>/dev/null | awk '{print "failed\\t"$1}'
command -v supervisorctl >/dev/null && supervisorctl status 2>/dev/null | awk '{print "supervisor\\t"$1" "$2}'
ss -tlnH 2>/dev/null | awk '{print "listen\\t"$4}' | sort -u
[ -x /usr/local/bin/fornax ] && fact fornax_version "$(/usr/local/bin/fornax --version 2>/dev/null)"
true
`;

export async function serverStatus(fleet: Fleet, server: Server) {
  const out = await runnerFor(fleet, server).run(STATUS_SCRIPT);
  const f = parseFacts(out.stdout);
  const gb = (n?: number) => (n === undefined ? undefined : Math.round((n / 1e9) * 10) / 10);
  const units = all(f, "unit").map((l) => {
    const [name, active, enabled] = l.split(" ");
    return { name: name!, active: active!, enabled: enabled! };
  });
  const listen = all(f, "listen");
  const publicPorts = listen.filter((a) => /^(0\.0\.0\.0|\*|\[::\]):/.test(a)).map((a) => a.replace(/^.*:/, ""));
  const memTotal = num(f, "mem_total");
  const diskTotal = num(f, "disk_total");
  return {
    server: server.server,
    host: server.host,
    os: one(f, "os"),
    kernel: one(f, "kernel"),
    arch: one(f, "arch"),
    cpus: num(f, "cpus"),
    load: one(f, "load"),
    uptime_days: Math.floor((num(f, "uptime") ?? 0) / 86400),
    memory_gb: { total: gb(memTotal), available: gb(num(f, "mem_available")) },
    swap_gb: { total: gb(num(f, "swap_total")), used: gb(num(f, "swap_used")) },
    disk_gb: { total: gb(diskTotal), used: gb(num(f, "disk_used")), free: gb(num(f, "disk_free")) },
    disk_used_pct: diskTotal ? Math.round(((num(f, "disk_used") ?? 0) / diskTotal) * 100) : undefined,
    reboot_required: one(f, "reboot_required") === "yes",
    upgradable_packages: num(f, "upgradable") ?? 0,
    services: units,
    failed_units: all(f, "failed"),
    supervisor: all(f, "supervisor").map((l) => {
      const [name, state] = l.split(" ");
      return { name: name!, state: state! };
    }),
    public_ports: [...new Set(publicPorts)].sort((a, b) => Number(a) - Number(b)),
    fornax_on_server: one(f, "fornax_version") ?? null,
  };
}

function statusWarnings(s: Awaited<ReturnType<typeof serverStatus>>): string[] {
  const w: string[] = [];
  const deploys = s.failed_units.filter((u) => u.startsWith("fornax-deploy@"));
  const others = s.failed_units.filter((u) => !u.startsWith("fornax-deploy@"));
  for (const u of deploys) {
    const site = u.replace(/^fornax-deploy@/, "").replace(/\.service$/, "");
    w.push(`last deploy of ${site} failed — fornax logs ${site} deploy (clears with the next successful deploy)`);
  }
  if (others.length) w.push(`failed units: ${others.join(", ")}`);
  for (const u of s.services) if (u.enabled === "enabled" && u.active !== "active") w.push(`${u.name} is enabled but ${u.active}`);
  for (const p of s.supervisor) if (p.state !== "RUNNING") w.push(`supervisor ${p.name} is ${p.state}`);
  if ((s.disk_used_pct ?? 0) >= 85) w.push(`disk ${s.disk_used_pct}% full`);
  if (s.reboot_required) w.push("reboot required");
  return w;
}

defineCommand({
  name: "server status",
  summary: "health of a server: OS, load, memory, disk, services, updates, open ports",
  tier: "read",
  args: [{ name: "server", help: "server name", required: true }],
  examples: ["fornax server status web-1", "fornax server status web-1 --json"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const s = await serverStatus(fleet, getServer(fleet, String(input.server)));
    const warnings = statusWarnings(s);
    const human = [
      `${s.server} (${s.host}) — ${s.os}, ${s.arch}, up ${s.uptime_days}d, load ${s.load} on ${s.cpus} cpus`,
      `memory ${s.memory_gb.available}/${s.memory_gb.total} GB free · disk ${s.disk_gb.free} GB free (${s.disk_used_pct}% used) · ${s.upgradable_packages} upgradable${s.reboot_required ? " · REBOOT REQUIRED" : ""}`,
      `services: ${s.services.map((u) => `${u.name}${u.active === "active" ? "" : `(${u.active})`}`).join(" ")}`,
      s.supervisor.length ? `supervisor: ${s.supervisor.map((p) => `${p.name}=${p.state}`).join(" ")}` : "",
      `public ports: ${s.public_ports.join(" ") || "none"}`,
      warnings.length ? `warnings:\n${warnings.map((x) => `  - ${x}`).join("\n")}` : "ok — no warnings",
    ]
      .filter(Boolean)
      .join("\n");
    return { data: { ...s, warnings }, human };
  },
});

// ---- certificates --------------------------------------------------------------

export const SSL_SCRIPT = `${FACT_FN}
now=$(date +%s)
for c in /etc/letsencrypt/live/*/fullchain.pem /etc/fornax/tls/*/fullchain.pem $(find /etc/nginx/ssl -name '*.crt' 2>/dev/null); do
  [ -f "$c" ] || continue
  end=$(openssl x509 -in "$c" -noout -enddate 2>/dev/null | cut -d= -f2) || continue
  [ -n "$end" ] || continue
  endts=$(date -d "$end" +%s)
  cn=$(openssl x509 -in "$c" -noout -subject -nameopt multiline 2>/dev/null | awk -F' = ' '/commonName/{print $2}')
  issuer=$(openssl x509 -in "$c" -noout -issuer -nameopt multiline 2>/dev/null | awk -F' = ' '/organizationName/{o=$2} /commonName/{c=$2} END{print (o && c && o != c) ? o " / " c : (o ? o : c)}')
  sans=$(openssl x509 -in "$c" -noout -ext subjectAltName 2>/dev/null | grep -o 'DNS:[^,]*' | sed 's/DNS://' | tr '\\n' ',')
  # sites-enabled holds symlinks: pass them as file arguments (grep -r would skip them)
  real=$(readlink -f "$c")
  used=$( { grep -lsF -e "$c" -e "$real" /etc/nginx/sites-enabled/* 2>/dev/null | xargs -r -n1 basename
            grep -rlsF -e "$c" -e "$real" /etc/nginx/forge-conf/ 2>/dev/null | sed -E 's#/etc/nginx/forge-conf/([^/]+)/.*#forge-site-\\1#'; } | sort -u | tr '\\n' ',')
  printf 'cert\\t%s|%s|%s|%s|%s|%s\\n' "$c" "$cn" "$sans" "$(( (endts - now) / 86400 ))" "$issuer" "$used"
done
true
`;

defineCommand({
  name: "ssl status",
  summary: "all TLS certificates with expiry, issuer and the vhosts using them",
  tier: "read",
  args: [{ name: "server", help: "only this server (default: all)" }],
  options: { warn: { type: "number", help: "warn below this many days", default: 21 } },
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const servers = input.server ? [getServer(fleet, String(input.server))] : [...fleet.servers.values()];
    const certs: Array<Record<string, unknown>> = [];
    const errors: Array<{ server: string; error: string }> = [];
    await Promise.all(
      servers.map(async (srv) => {
        try {
          const out = await runnerFor(fleet, srv).run(SSL_SCRIPT);
          for (const line of all(parseFacts(out.stdout), "cert")) {
            const [path, cn, sans, days, issuer, used] = line.split("|");
            const usedBy = [...new Set((used ?? "").split(",").filter(Boolean))];
            const names = (sans ?? "").split(",").filter(Boolean);
            certs.push({ server: srv.server, path, name: cn || names[0] || "?", names, days_left: Number(days), issuer, used_by: usedBy });
          }
        } catch (e) {
          errors.push({ server: srv.server, error: (e as Error).message });
        }
      }),
    );
    certs.sort((a, b) => (a.days_left as number) - (b.days_left as number));
    const warnDays = Number(input.warn);
    const expiring = certs.filter((c) => (c.used_by as string[]).length && (c.days_left as number) < warnDays);
    const unused = certs.filter((c) => !(c.used_by as string[]).length);
    const human = [
      ...certs.map(
        (c) =>
          `${String(c.days_left).padStart(5)}d  ${String(c.server).padEnd(16)} ${String(c.name).padEnd(34)} ${(c.used_by as string[]).length ? `used by ${(c.used_by as string[]).join(",")}` : "UNUSED"}`,
      ),
      expiring.length ? `\n${expiring.length} certificate(s) in use expire within ${warnDays} days` : "",
      unused.length ? `${unused.length} certificate(s) are not referenced by any vhost (leftovers)` : "",
      ...errors.map((e) => `error on ${e.server}: ${e.error}`),
    ]
      .filter(Boolean)
      .join("\n");
    return { data: { certificates: certs, expiring: expiring.length, unused: unused.length, errors }, human: human || "no certificates found", exitCode: errors.length ? 1 : 0 };
  },
});

// ---- logs ---------------------------------------------------------------------

export const LOG_KINDS = ["nginx", "access", "laravel", "daemon", "deploy", "php", "app"] as const;

function logScript(site: ResolvedSite, kind: string, lines: number, grep?: string): string {
  const filter = grep ? `| grep -E -- ${q(grep)}` : "";
  const t = (path: string) => `tail -n ${lines} ${path} ${filter}`;
  const d = q(site.domain);
  switch (kind) {
    case "nginx":
      return `f=/var/log/nginx/${site.domain}-error.log
if [ ! -f "$f" ]; then
  v=/etc/nginx/sites-enabled/${site.domain}
  incs=$(grep -hoE 'include +[^;]+' "$v" 2>/dev/null | awk '{print $2}' | sed 's#^\\([^/]\\)#/etc/nginx/\\1#')
  f=$(cat "$v" $incs 2>/dev/null | grep -oE 'error_log +[^ ;]+' | awk '{print $2}' | head -1)
fi
[ -n "$f" ] && [ -f "$f" ] || { echo "no nginx error log found for ${site.domain}" >&2; exit 3; }
echo "# $f" >&2; ${t('"$f"')}`;
    case "access":
      return `f=/var/log/nginx/${site.domain}-access.log
if [ -f "$f" ]; then echo "# $f" >&2; ${t('"$f"')}; else echo "# /var/log/nginx/access.log (vhost format)" >&2; grep -E "^(${site.names.map((n) => n.replace(/\./g, "\\.")).join("|")}) " /var/log/nginx/access.log | tail -n ${lines} ${filter}; fi`;
    // files in the site's tree are read as the site user: a symlink there must not reach root's files
    case "laravel":
      return asUser(
        site.user,
        `cd ${q(site.current)}/storage/logs 2>/dev/null || cd ${q(site.root)}/storage/logs 2>/dev/null || { echo "no storage/logs for ${site.domain}" >&2; exit 3; }
f=$(ls -t laravel*.log 2>/dev/null | head -1); [ -n "$f" ] || { echo "no laravel log yet" >&2; exit 3; }
echo "# $PWD/$f" >&2; ${t('"$f"')}`,
      );
    case "daemon":
      return `found=0
for c in $(grep -lsE '^user=${site.user}$' /etc/supervisor/conf.d/*.conf); do
  lf=$(grep -E '^stdout_logfile=' "$c" | cut -d= -f2); [ -f "$lf" ] || continue
  found=1; echo "# $lf" >&2; ${t('"$lf"')}
done
[ $found = 1 ] || { echo "no supervisor programs for user ${site.user}" >&2; exit 3; }`;
    case "deploy":
      return `f=$(ls -t ${DEPLOY_LOG_DIR(site.user)}/*.log 2>/dev/null | head -1)
if [ -n "$f" ]; then echo "# $f" >&2; sed -e 's/\\x1b\\[[0-9;]*m//g' "$f" | tail -n ${lines} ${filter}; exit; fi
${asUser(
  site.user,
  `f=$(ls -t /home/${site.user}/.forge/provision-*.output 2>/dev/null | head -1)
[ -n "$f" ] || { echo "no deploy log for ${site.domain}" >&2; exit 3; }
echo "# $f" >&2; sed -e 's/\\x1b\\[[0-9;]*m//g' "$f" | tail -n ${lines} ${filter}`,
)}`;
    // a node app's output (root-owned, outside the home); its units' journal says why one did not start
    case "app": {
      if (!site.node) return fail("invalid_option", `${site.domain} is no node app (preset ${site.spec.preset})`, "app logs are for preset node; laravel has `fornax logs <site> laravel`");
      const units = nodeSlots(site, site.node.ports).slots.map((x) => `-u ${x.unit}`).join(" ");
      return `f=${SITE_LOG_DIR(site.user)}/app.log
if [ -f "$f" ]; then echo "# $f" >&2; ${t('"$f"')}; else echo "# journalctl ${units}" >&2; journalctl ${units} --no-pager -n ${lines} ${filter}; fi; true`;
    }
    case "php":
      return `echo "# journalctl -u php${site.php}-fpm" >&2; journalctl -u php${site.php}-fpm --no-pager -n ${lines} ${filter}; f=/var/log/php${site.php}-fpm.log; [ -f $f ] && { echo "# $f" >&2; ${t("$f")}; }; true`;
  }
  return fail("invalid_option", `unknown log kind "${kind}"`, `one of: ${LOG_KINDS.join(", ")}`);
}

defineCommand({
  name: "logs",
  summary: "tail a site's logs: nginx (errors), access, laravel, daemon, deploy, php, app (a node app's output)",
  tier: "read",
  args: [
    { name: "site", help: "site domain", required: true },
    { name: "kind", help: LOG_KINDS.join(" | ") + " (default: nginx)" },
  ],
  options: {
    lines: { type: "number", help: "number of lines", default: 100 },
    grep: { type: "string", help: "only lines matching this regex" },
  },
  examples: ["fornax logs shop.example.com laravel --lines 50", "fornax logs shop.example.com access --grep ' 5[0-9][0-9] '"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    const kind = String(input.kind ?? "nginx");
    if (!LOG_KINDS.includes(kind as (typeof LOG_KINDS)[number])) fail("invalid_option", `unknown log kind "${kind}"`, `one of: ${LOG_KINDS.join(", ")}`);
    const res = await runnerFor(fleet, server).run(logScript(site, kind, Number(input.lines), input.grep as string | undefined), { allowFail: true });
    const files = res.stderr.split("\n").filter((l) => l.startsWith("# ")).map((l) => l.slice(2));
    if (res.code === 3) fail("no_logs", res.stderr.trim().split("\n").pop()!, undefined, `fornax explain ${site.domain}`);
    if (res.code !== 0 && res.code !== 1) fail("remote_failed", `reading logs failed (exit ${res.code})`, tail(res.stderr, 10));
    const lines = res.stdout.split("\n").filter((l) => l !== "");
    return { data: { site: site.domain, server: server.server, kind, files, lines }, human: [...files.map((f) => `==> ${f}`), ...lines].join("\n") };
  },
});

// ---- explain ------------------------------------------------------------------

function siteProbe(site: ResolvedSite): string {
  return `${FACT_FN}
id -u ${site.user} >/dev/null 2>&1 && fact user_exists yes || fact user_exists no
if [ -L ${q(site.current)} ]; then
  r=$(readlink -f ${q(site.current)}); fact current "$r"; fact current_age_s "$(( $(date +%s) - $(stat -c %Y "$r") ))"
  [ -d "$r/.git" ] && { fact sha "$(git -c safe.directory='*' -C "$r" rev-parse HEAD 2>/dev/null)"; fact remote "$(git -c safe.directory='*' -C "$r" config --get remote.origin.url 2>/dev/null)"; }
fi
[ -d ${q(site.root)}/releases ] && fact releases "$(ls -1 ${q(site.root)}/releases | wc -l)"
[ -f ${q(site.root)}/.env ] && fact env yes || fact env no
[ -e /etc/nginx/sites-enabled/${site.domain} ] && fact vhost /etc/nginx/sites-enabled/${site.domain}
for f in /etc/php/${site.php}/fpm/pool.d/*.conf; do grep -qE "^user *= *${site.user}$" "$f" 2>/dev/null && { fact pool "$f"; fact socket "$(grep -E '^listen *=' "$f" | cut -d= -f2 | tr -d ' ')"; }; done
for c in $(grep -lsE '^user=${site.user}$' /etc/supervisor/conf.d/*.conf); do fact daemon_conf "$c"; done
command -v supervisorctl >/dev/null && for p in $(grep -hsE '^\\[program:' $(grep -lsE '^user=${site.user}$' /etc/supervisor/conf.d/*.conf) </dev/null | sed 's/\\[program:\\(.*\\)\\]/\\1/'); do fact daemon "$(supervisorctl status "$p:*" 2>/dev/null | awk '{print $1" "$2}' | tr '\\n' ';')"; done
${(site.node ? nodeSlots(site, site.node.ports).slots : []).map((x) => `e=$(systemctl is-enabled ${x.unit} 2>/dev/null || true); a=$(systemctl is-active ${x.unit} 2>/dev/null || true); fact node_slot "${x.name} ${x.port} \${e:-none} \${a:-none} $(readlink ${q(x.link)} 2>/dev/null)"\n`).join("")}grep -hsE "^[^#].*[[:space:]]${site.user}[[:space:]]" /etc/crontab /etc/cron.d/* | while read -r l; do fact cron "$l"; done
fact disk "$(du -sh /home/${site.user} 2>/dev/null | cut -f1)"
true
`;
}

defineCommand({
  name: "explain",
  summary: "facts about a site or server — config plus live state (paths, users, releases, logs, certs)",
  tier: "read",
  args: [{ name: "target", help: "site domain or server name", required: true }],
  options: { offline: { type: "boolean", help: "config only, do not connect to the server" } },
  examples: ["fornax explain shop.example.com", "fornax explain web-1 --json"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const target = String(input.target);
    if (fleet.servers.has(target)) {
      const server = getServer(fleet, target);
      const config = {
        server: server.server,
        host: server.host,
        provider: server.provider,
        modules: server.modules,
        php: server.php,
        services: server.services,
        webhook: server.webhook?.domain ?? null,
        sites: sites(fleet, server).map((s) => ({ site: s.domain, user: s.user, php: s.php, preset: s.spec.preset, state: s.spec.state })),
        policy_violations: policyViolations(fleet, server),
        notes: server.notes ?? null,
      };
      const live = input.offline ? null : await serverStatus(fleet, server);
      return { data: { kind: "server", config, live }, human: JSON.stringify({ config, live }, null, 2) };
    }
    const { server, site } = findSite(fleet, target);
    const config = {
      site: site.domain,
      server: server.server,
      names: site.names,
      user: site.user,
      php: site.php,
      preset: site.spec.preset,
      repo: site.spec.repo ?? null,
      branch: site.spec.branch,
      paths: { root: site.root, current: site.current, web_root: site.webRoot, env: `${site.root}/.env`, shared: site.shared.map((p) => `${site.root}/${p}`) },
      db: site.db ?? null,
      tls: site.tlsIssuer,
      daemons: site.spec.daemons,
      ...(site.node ? { node: { start: site.node.start, ports: site.node.ports, units: nodeSlots(site, site.node.ports).slots.map((x) => x.unit) } } : {}),
      redis: site.redis === "own" ? { instance: "own", socket: siteRedis(site.user).socket, unit: siteRedis(site.user).unit, maxmemory: site.spec.redis.maxmemory } : { instance: site.redis },
      schedule: site.spec.schedule,
      cron: site.spec.cron,
      deploy: site.spec.deploy,
      logs: {
        nginx: `fornax logs ${site.domain} nginx`,
        ...(site.node ? { app: `fornax logs ${site.domain} app` } : { laravel: `fornax logs ${site.domain} laravel` }),
        deploy: `fornax logs ${site.domain} deploy`,
      },
      notes: site.spec.notes ?? null,
    };
    let live: Record<string, unknown> | null = null;
    if (!input.offline) {
      const f = parseFacts((await runnerFor(fleet, server).run(siteProbe(site))).stdout);
      live = {
        user_exists: one(f, "user_exists") === "yes",
        current_release: one(f, "current") ?? null,
        current_age_hours: num(f, "current_age_s") !== undefined ? Math.round((num(f, "current_age_s")! / 3600) * 10) / 10 : null,
        commit: one(f, "sha") ?? null,
        remote: one(f, "remote") ? scrubUrl(one(f, "remote")!) : null,
        releases: num(f, "releases") ?? 0,
        env_file: one(f, "env") === "yes",
        vhost: one(f, "vhost") ?? null,
        fpm_pool: one(f, "pool") ?? null,
        fpm_socket: one(f, "socket") ?? null,
        daemon_configs: all(f, "daemon_conf"),
        daemons: all(f, "daemon").flatMap((d) => d.split(";").filter(Boolean)),
        ...(site.node
          ? {
              node_slots: all(f, "node_slot").map((l) => {
                const [slot, port, enabled, active, release] = l.split(" ");
                return { slot, port: Number(port), enabled: enabled === "enabled", active, release: release || null };
              }),
            }
          : {}),
        cron: all(f, "cron"),
        disk: one(f, "disk") ?? null,
      };
    }
    return { data: { kind: "site", config, live }, human: JSON.stringify({ config, live }, null, 2) };
  },
});
