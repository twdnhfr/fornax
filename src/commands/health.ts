/**
 * `fornax health` — one verdict per server, on demand: is it healthy? Read-only, nothing runs on the
 * servers between calls. Exit code 0 healthy, 1 a warning or worse, 2 an error (usable from cron or CI).
 */
import { connect } from "node:net";
import { defineCommand } from "../core/command.ts";
import { behindApp, getServer, loadFleet, onePassword, sites, type Fleet } from "../core/fleet.ts";
import { daysUntil, expiryNote } from "../core/onepassword.ts";
import { all, FACT_FN, parseFacts } from "../core/probe.ts";
import type { Server } from "../core/schema.ts";
import { q } from "../core/shell.ts";
import { runnerFor, sshSettings } from "../core/ssh.ts";
import { backupEnabled } from "../modules/backup.ts";
import { serverStatus, SSL_SCRIPT } from "./observe.ts";
import { tailnetPlan } from "./tailnet.ts";

type Level = "ok" | "warn" | "crit";
interface Check {
  check: string;
  level: Level;
  detail: string;
}

const RANK: Record<Level, number> = { ok: 0, warn: 1, crit: 2 };
const ICON: Record<Level, string> = { ok: "✓", warn: "⚠", crit: "✗" };
const worst = (levels: Level[]): Level => levels.reduce<Level>((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");

/** Sites answer through the server's own nginx; backups and certbot from their state on disk. */
function extraScript(fleet: Fleet, server: Server): string {
  const live = sites(fleet, server).filter((s) => s.spec.state === "present");
  const probes = live.map((s) => {
    const https = s.tlsIssuer !== "none";
    const port = https ? 443 : 80;
    const path = s.spec.health_check ?? "/";
    const url = `${https ? "https" : "http"}://${s.domain}${path.startsWith("/") ? "" : "/"}${path}`;
    return `fact site "${s.domain} $(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve ${q(`${s.domain}:${port}:127.0.0.1`)} ${q(url)})"`;
  });
  return `${FACT_FN}
${probes.join("\n")}
[ -f /var/lib/fornax/backup-status.json ] && fact backup_status "$(tr -d '\\n' < /var/lib/fornax/backup-status.json)"
systemctl list-unit-files certbot.timer >/dev/null 2>&1 && fact certbot_timer "$(systemctl is-active certbot.timer 2>/dev/null)"
ss -tulpnH 2>/dev/null | while read -r proto _ _ _ local _ proc; do fact listen "$proto $local $(printf '%s' "$proc" | sed -n 's/.*(("\\([^"]*\\)".*/\\1/p')"; done
for v in 4 6; do t=iptables; [ $v = 6 ] && t=ip6tables; command -v $t >/dev/null && $t -w -t nat -S DOCKER 2>/dev/null | grep -- '-j DNAT' | while read -r l; do fact docker_nat "$v $l"; done; done
true`;
}

/** What may listen beyond the machine itself: the web server, SSH, Tailscale, DHCP and NTP. */
const EXPECTED = (p: Listener, sshPort: number) =>
  !p.docker &&
  ((p.proc === "nginx" && (p.port === 80 || p.port === 443)) ||
    ((p.proc === "sshd" || p.proc === "systemd") && p.port === sshPort) ||
    p.proc === "tailscaled" ||
    (p.proto === "udp" && (p.port === 68 || p.port === 123)));

export interface Listener {
  proto: string;
  address: string;
  port: number;
  /** Last port of a range Docker publishes (2456:2457). */
  last?: number;
  proc: string;
  /** Published by Docker, whose own iptables rules come before ufw's. */
  docker: boolean;
}

/** An entry of `firewall.allow` (proto defaults to tcp). */
export type AllowRule = { port?: number | string; proto?: "tcp" | "udp"; on?: string };

/** `proto address:port process` lines, as the health script collects them from `ss -tulpnH`. */
export function parseListeners(lines: string[]): Listener[] {
  return lines
    .map((l) => {
      const [proto = "", local = "", proc = "?"] = l.split(" ");
      const i = local.lastIndexOf(":");
      return { proto, address: local.slice(0, i), port: Number(local.slice(i + 1)), proc: proc || "?", docker: proc === "docker-proxy" };
    })
    .filter((p) => p.port > 0);
}

/**
 * Ports Docker forwards to containers: the DNAT rules of its nat chain DOCKER (`<4|6> <rule>` from
 * `iptables -t nat -S DOCKER`), also there when Docker runs without its userland proxy and nothing
 * shows up in ss.
 */
export function dockerPublished(rules: string[]): Listener[] {
  return rules.flatMap((r) => {
    const proto = r.match(/ -p (tcp|udp)\b/)?.[1];
    const port = r.match(/ --dport (\d+)(?::(\d+))?/);
    if (!proto || !port) return [];
    const v6 = r.startsWith("6 ");
    const dest = r.match(/ -d ([\da-fA-F.:]+)\/\d+/)?.[1];
    const address = dest ? (v6 ? `[${dest}]` : dest) : v6 ? "[::]" : "0.0.0.0";
    return [{ proto, address, port: Number(port[1]), ...(port[2] ? { last: Number(port[2]) } : {}), proc: "docker", docker: true }];
  });
}

/** Whether a port (or a range) is opened on purpose in `firewall.allow`, for the same protocol. */
export function allowedBy(l: Pick<Listener, "proto" | "port" | "last">, allow: AllowRule[]): boolean {
  return allow.some((a) => {
    // a whole interface (on: tailscale0) says who may come in, not that this service should listen beyond localhost
    if (a.port === undefined || (a.proto ?? "tcp") !== l.proto) return false;
    const [from, to = from] = String(a.port).split(":").map(Number) as [number, number?];
    return from! <= l.port && (l.last ?? l.port) <= to!;
  });
}

const LOCAL_ONLY = (p: Listener) =>
  /^(127\.|\[::1\]|\[::ffff:127\.|\[fe80:)/.test(p.address) || /%(lo|tailscale\d*)$/.test(p.address) || /^(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[fd7a:115c:a1e0:)/.test(p.address);

/**
 * Sockets listening on more than loopback or the tailnet (which tailscaled owns) that are neither
 * the usual ones nor opened on purpose in `firewall.allow`, each port once. Ports Docker publishes
 * (docker-proxy in ss, or a DNAT rule of its DOCKER chain) are marked: ufw does not filter them.
 */
export function unusualListeners(lines: string[], opts: { allow?: AllowRule[]; sshPort?: number; dockerRules?: string[] } = {}): Listener[] {
  const nat = dockerPublished(opts.dockerRules ?? []).filter((d) => !LOCAL_ONLY(d));
  const covers = (d: Listener, p: Listener) => d.proto === p.proto && d.port <= p.port && p.port <= (d.last ?? d.port);
  const listening = parseListeners(lines).map((p) => (p.docker || nat.some((d) => covers(d, p)) ? { ...p, docker: true } : p));
  // a rule with nothing in ss: Docker runs without its userland proxy
  const unseen = nat.filter((d) => !listening.some((p) => covers(d, p)));
  return [...listening, ...unseen]
    .filter((p) => !LOCAL_ONLY(p))
    .filter((p) => !EXPECTED(p, opts.sshPort ?? 22) && !allowedBy(p, opts.allow ?? []))
    .filter((p, i, all) => all.findIndex((q) => q.port === p.port && q.proto === p.proto) === i);
}

const where = (u: Listener) => `${u.proc} ${u.address}:${u.port}${u.last ? `-${u.last}` : ""}/${u.proto}`;

/** Ports a scan of the server's public addresses finds open, from where fornax runs (TCP, 80/443 aside). */
async function publiclyOpen(addresses: string[], ports: number[]): Promise<string[]> {
  const probe = (host: string, port: number) =>
    new Promise<boolean>((resolve) => {
      const s = connect({ host, port, timeout: 2500 });
      const done = (open: boolean) => {
        s.destroy();
        resolve(open);
      };
      s.once("connect", () => done(true));
      s.once("timeout", () => done(false));
      s.once("error", () => done(false));
    });
  const results = await Promise.all(addresses.flatMap((a) => ports.map(async (p) => ((await probe(a, p)) ? `${a.includes(":") ? `[${a}]` : a}:${p}` : null))));
  return results.filter((x): x is string => x !== null);
}

export async function serverHealth(fleet: Fleet, server: Server): Promise<{ server: string; status: Level; checks: Check[] }> {
  const checks: Check[] = [];
  const add = (check: string, level: Level, detail: string) => checks.push({ check, level, detail });
  const runner = runnerFor(fleet, server);
  let s: Awaited<ReturnType<typeof serverStatus>>;
  try {
    s = await serverStatus(fleet, server);
  } catch (e) {
    return { server: server.server, status: "crit", checks: [{ check: "reachable", level: "crit", detail: (e as Error).message.split("\n")[0]! }] };
  }
  add("reachable", "ok", `${s.os}, up ${s.uptime_days}d`);

  // resources
  const pct = s.disk_used_pct ?? 0;
  add("disk", pct >= 95 ? "crit" : pct >= 85 ? "warn" : "ok", `${pct}% used, ${s.disk_gb.free} GB free`);
  const memPct = s.memory_gb.total ? Math.round(((s.memory_gb.available ?? 0) / s.memory_gb.total) * 100) : 100;
  add("memory", memPct < 5 ? "crit" : memPct < 10 ? "warn" : "ok", `${s.memory_gb.available} of ${s.memory_gb.total} GB available`);
  if (s.swap_gb.total) {
    const swapPct = Math.round(((s.swap_gb.used ?? 0) / s.swap_gb.total) * 100);
    add("swap", swapPct >= 80 ? "warn" : "ok", `${swapPct}% of ${s.swap_gb.total} GB used`);
  }
  const load15 = Number((s.load ?? "0 0 0").split(" ")[2]);
  const perCpu = s.cpus ? load15 / s.cpus : 0;
  add("load", perCpu >= 3 ? "crit" : perCpu >= 1.5 ? "warn" : "ok", `${load15} over 15 min on ${s.cpus} cpus`);

  // services and programs
  const down = s.services.filter((u) => u.enabled === "enabled" && u.active !== "active");
  add("services", down.length ? "crit" : "ok", down.length ? `down: ${down.map((u) => `${u.name} (${u.active})`).join(", ")}` : `${s.services.filter((u) => u.active === "active").length} running`);
  const deployFails = s.failed_units.filter((u) => u.startsWith("fornax-deploy@"));
  const otherFails = s.failed_units.filter((u) => !u.startsWith("fornax-deploy@"));
  if (otherFails.length) add("failed units", "crit", otherFails.join(", "));
  if (deployFails.length) add("last deploys", "warn", `failed: ${deployFails.map((u) => u.replace(/^fornax-deploy@|\.service$/g, "")).join(", ")} (the live release was kept)`);
  if (s.supervisor.length) {
    const bad = s.supervisor.filter((p) => p.state !== "RUNNING");
    add("daemons", bad.length ? "crit" : "ok", bad.length ? bad.map((p) => `${p.name} ${p.state}`).join(", ") : `${s.supervisor.length} running`);
  }

  // sites, certificates, backups
  const [extra, ssl] = await Promise.all([runner.run(extraScript(fleet, server)), runner.run(SSL_SCRIPT)]);
  const f = parseFacts(extra.stdout);
  const siteCodes = all(f, "site").map((l) => l.split(" ") as [string, string]);
  const broken = siteCodes.filter(([, code]) => code === "000" || Number(code) >= 500);
  if (siteCodes.length) add("sites", broken.length ? "crit" : "ok", broken.length ? broken.map(([d, c]) => `${d} → ${c === "000" ? "no answer" : `HTTP ${c}`}`).join(", ") : `${siteCodes.length} answering`);

  const certs = all(parseFacts(ssl.stdout), "cert")
    .map((l) => l.split("|"))
    .filter((c) => (c[5] ?? "").split(",").filter(Boolean).length) // only certificates a vhost uses
    .map((c) => ({ name: c[1] || c[0]!, days: Number(c[3]) }));
  if (certs.length) {
    const soon = certs.filter((c) => c.days < 14).sort((a, b) => a.days - b.days);
    const min = Math.min(...certs.map((c) => c.days));
    add("certificates", soon.some((c) => c.days < 3) ? "crit" : soon.length ? "warn" : "ok", soon.length ? soon.map((c) => `${c.name} in ${c.days}d`).join(", ") : `${certs.length} valid, next expiry in ${min}d`);
  }
  const timer = all(f, "certbot_timer")[0];
  if (timer && timer !== "active") add("certbot", "warn", `certbot.timer is ${timer} — Let's Encrypt certificates are not renewed`);

  if (backupEnabled({ fleet, server, sites: sites(fleet, server) })) {
    const raw = all(f, "backup_status")[0];
    if (!raw) add("backups", "warn", "set up, but no run yet");
    else {
      const st = JSON.parse(raw) as { sites: Record<string, { ok: boolean; at: string; error?: string }> };
      const entries = Object.entries(st.sites);
      const failed = entries.filter(([, b]) => !b.ok);
      const hours = (at: string) => Math.round((Date.now() - Date.parse(at)) / 3_600_000);
      const stale = entries.filter(([, b]) => b.ok && hours(b.at) > 36);
      const newest = entries.length ? Math.min(...entries.map(([, b]) => hours(b.at))) : 0;
      add(
        "backups",
        failed.length ? "crit" : stale.length || !entries.length ? "warn" : "ok",
        failed.length ? `failed: ${failed.map(([d, b]) => `${d} (${b.error})`).join(", ")}` : stale.length ? `older than 36h: ${stale.map(([d, b]) => `${d} (${hours(b.at)}h)`).join(", ")}` : `${entries.length} sites, last run ${newest}h ago`,
      );
    }
  }

  // network: what listens beyond the machine, and what of it the internet actually reaches
  const unusual = unusualListeners(all(f, "listen"), { allow: server.firewall.allow, sshPort: sshSettings(fleet, server).port, dockerRules: all(f, "docker_nat") });
  const docker = unusual.filter((u) => u.docker);
  const blocked = unusual.filter((u) => !u.docker);
  add("listening", blocked.length ? "warn" : "ok", blocked.length ? `beyond localhost — the firewall keeps the internet out (see "exposed"), but machines the tailnet policy lets in reach them: ${blocked.map(where).join(", ")}` : "beyond localhost only nginx (80/443), SSH, Tailscale and what firewall.allow opens");
  if (docker.length) add("docker", "crit", `published by Docker, which ufw does not filter — open to the internet unless bound to 127.0.0.1 (or listed in firewall.allow on purpose): ${docker.map(where).join(", ")}`);
  const publicAddrs = [server.public_ipv4, server.public_ipv6].filter((a): a is string => Boolean(a));
  if (publicAddrs.length) {
    const ports = [...new Set([22, 3306, 5432, 6379, 11211, 33060, ...unusual.filter((u) => u.proto === "tcp").map((u) => u.port)])].filter((p) => !server.firewall.allow.some((a) => String(a.port) === String(p)));
    const open = await publiclyOpen(publicAddrs, ports);
    add("exposed", open.length ? "crit" : "ok", open.length ? `reachable from the internet: ${open.join(", ")}` : `from here only 80/443 answer on ${publicAddrs.join(", ")} (checked: ${ports.join(", ")})`);
  }

  // maintenance
  if (s.reboot_required) add("reboot", "warn", "required after updates");
  add("updates", "ok", `${s.upgradable_packages} packages upgradable`);
  return { server: server.server, status: worst(checks.map((c) => c.level)), checks };
}

/** Every op:// reference in the fleet config, one per item. */
function itemRefs(fleet: Fleet): string[] {
  const refs = new Map<string, string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string" && v.startsWith("op://")) refs.set(v.split("/").slice(2, 4).join("/"), v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(fleet.config);
  for (const s of fleet.servers.values()) walk(s);
  return [...refs.values()];
}

/** Credentials of the fleet that expire soon or have expired (the expiry date on their 1Password item). */
async function credentialsCheck(fleet: Fleet): Promise<Check | null> {
  const refs = itemRefs(fleet);
  if (!refs.length) return null;
  const op = await onePassword(fleet);
  const warnDays = fleet.config.onepassword?.warn_expiry_days ?? 14;
  const dated = (await Promise.all(refs.map((r) => op.expiry(r).catch(() => null)))).filter((e): e is NonNullable<typeof e> => e !== null);
  const due = dated.filter((e) => daysUntil(e.date) <= warnDays).sort((a, b) => a.date.getTime() - b.date.getTime());
  if (!due.length) {
    const next = dated.sort((a, b) => a.date.getTime() - b.date.getTime())[0];
    return { check: "credentials", level: "ok", detail: next ? `next to expire: "${next.title}" in ${daysUntil(next.date)} days` : `${refs.length} in 1Password, none with an expiry date` };
  }
  return { check: "credentials", level: due.some((e) => daysUntil(e.date) < 0) ? "crit" : "warn", detail: due.map((e) => expiryNote(e.title, e.vault, e.date)).join("; ") };
}

/**
 * The tailnet as the fleet wants it (fleets reached through Tailscale, with an API token): a server
 * not carrying its tag has the rights of your own devices — critical; a policy that differs, a warning.
 */
async function tailnetCheck(fleet: Fleet): Promise<Check | null> {
  if (fleet.config.access !== "tailscale" || !fleet.config.tailscale?.api_token) return null;
  // health runs often and unattended: it does not ask for Touch ID
  if (behindApp(fleet, fleet.config.tailscale.api_token)) return { check: "tailnet", level: "ok", detail: "not checked here (the Tailscale token is behind Touch ID) — fornax tailnet status" };
  const p = await tailnetPlan(fleet);
  const servers = new Set([...fleet.servers.values()].map((s) => s.host.split(".")[0]!));
  const untagged = p.tags.filter((t) => servers.has(t.machine) && !t.missing);
  if (untagged.length) return { check: "tailnet", level: "crit", detail: `servers without their tag (they have the rights of your own devices): ${untagged.map((t) => t.machine).join(", ")} — fornax tailnet sync` };
  if (p.changed || p.tags.length) return { check: "tailnet", level: "warn", detail: "the tailnet policy or tags differ from the fleet's — fornax tailnet status" };
  const allow = fleet.config.tailscale.allow.length;
  return { check: "tailnet", level: "ok", detail: `servers reach only DNS${allow ? ` and ${allow} allowed service(s)` : ""} in the tailnet; policy and tags as the fleet wants` };
}

defineCommand({
  name: "health",
  summary: "is a server healthy? disk, memory, load, services, daemons, sites, certificates, backups, what listens beyond localhost — one verdict per server (exit 0 ok, 1 warning or critical)",
  tier: "read",
  args: [{ name: "server", help: "only this server (default: all)" }],
  options: { all: { type: "boolean", help: "list every check, not only the ones that are not ok" } },
  examples: ["fornax health", "fornax health web-1 --all", "fornax health --json"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const servers = input.server ? [getServer(fleet, String(input.server))] : [...fleet.servers.values()];
    const [results, credentials, tailnet] = await Promise.all([
      Promise.all(servers.map((s) => serverHealth(fleet, s))),
      credentialsCheck(fleet).catch(() => null),
      tailnetCheck(fleet).catch((e): Check => ({ check: "tailnet", level: "warn", detail: `could not check the tailnet policy: ${(e as Error).message}` })),
    ]);
    const fleetChecks = [credentials, tailnet].filter((c): c is Check => c !== null);
    const status = worst([...results.map((r) => r.status), ...fleetChecks.map((c) => c.level)]);
    const fleetLines = fleetChecks.filter((c) => input.all || c.level !== "ok").map((c) => `${ICON[c.level]} fleet: ${c.check} — ${c.detail}`);
    const human = [...fleetLines, ...results
      .map((r) => {
        const shown = input.all ? r.checks : r.checks.filter((c) => c.level !== "ok");
        const head = `${ICON[r.status]} ${r.server}: ${r.status === "ok" ? "healthy" : r.status === "warn" ? "warning" : "CRITICAL"}`;
        return [head, ...shown.map((c) => `   ${ICON[c.level]} ${c.check.padEnd(13)} ${c.detail}`)].join("\n");
      })]
      .join("\n");
    return { data: { status, servers: results, credentials, tailnet }, human, exitCode: status === "ok" ? 0 : 1 };
  },
});
