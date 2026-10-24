/**
 * Take over a server that Laravel Forge provisioned — without moving a single site.
 * Every Forge-written file a site depends on (vhost, forge-conf includes, FPM pool,
 * supervisor program, logrotate, /etc/crontab) is copied byte for byte into the fleet repo
 * and becomes an fornax-managed file. Nothing is regenerated, so the first plan is empty.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail } from "../core/errors.ts";
import { FACT_FN, parseFacts } from "../core/probe.ts";
import type { Runner } from "../core/ssh.ts";
import { q } from "../core/shell.ts";

// ---- Forge data ------------------------------------------------------------------

interface Resource<A> {
  id: string;
  attributes: A;
}

export interface ForgeSite {
  name: string;
  user: string;
  web_directory: string;
  php_version: string;
  repository: { url: string | null; branch: string | null } | null;
  zero_downtime_deployments: boolean;
  deployment_retention?: number;
  app_type?: string;
  healthcheck_url?: string | null;
}

export interface ForgeData {
  server: { id: number; name: string; provider: string; identifier: string | null; ip_address: string; php_version: string };
  sites: Array<Resource<ForgeSite>>;
  scripts: Record<string, string>;
  domains: Record<string, Array<Resource<{ name: string; type: string; www_redirect_type?: string }>>>;
  daemons: Array<Resource<{ command: string; user: string; directory: string | null; processes: number }>>;
  jobs: Array<Resource<{ command: string; user: string; cron: string }>>;
}

/** Live Forge API (org-scoped v2). Token from FORGE_TOKEN or the Forge CLI's ~/.laravel-forge/config.json. */
export async function fromForgeApi(org: string, serverId: string): Promise<ForgeData> {
  let token = process.env.FORGE_TOKEN;
  const cfg = join(homedir(), ".laravel-forge", "config.json");
  if (!token && existsSync(cfg)) token = (JSON.parse(readFileSync(cfg, "utf8")) as { token?: string }).token;
  if (!token) fail("no_forge_token", "no Forge API token", "set FORGE_TOKEN or log in with the Forge CLI (`forge login`)");
  const base = `${process.env.FORNAX_FORGE_API ?? "https://forge.laravel.com/api"}/orgs/${org}/servers/${serverId}`;
  const get = async <T>(path: string): Promise<T> => {
    const all: unknown[] = [];
    let url: string | null = `${base}${path}`;
    let single: unknown;
    while (url) {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "fornax" } });
      if (!res.ok) fail("forge_error", `Forge GET ${path}: HTTP ${res.status}`, (await res.text()).slice(0, 200));
      const j = (await res.json()) as { data: unknown; links?: { next?: string | null } };
      if (!Array.isArray(j.data)) {
        single = j.data;
        break;
      }
      all.push(...j.data);
      url = j.links?.next ?? null;
      await Bun.sleep(600); // Forge rate-limits bursts
    }
    return (single ?? all) as T;
  };
  return collectForge(get);
}

/** A directory of saved API responses, named like `servers_<id>_sites_<site>_domains.json`. */
export async function fromForgeDump(dir: string, serverId: string): Promise<ForgeData> {
  const get = async <T>(path: string): Promise<T> => {
    const f = join(dir, `servers_${serverId}${path.replace(/\//g, "_")}.json`);
    if (!existsSync(f)) fail("dump_incomplete", `missing ${f}`);
    return (JSON.parse(readFileSync(f, "utf8")) as { data: T }).data;
  };
  return collectForge(get);
}

async function collectForge(get: <T>(path: string) => Promise<T>): Promise<ForgeData> {
  const server = (await get<Resource<ForgeData["server"]>>("")).attributes;
  const sites = await get<ForgeData["sites"]>("/sites");
  const scripts: ForgeData["scripts"] = {};
  const domains: ForgeData["domains"] = {};
  for (const s of sites) {
    scripts[s.id] = (await get<Resource<{ content: string }>>(`/sites/${s.id}/deployments/script`)).attributes.content;
    domains[s.id] = await get<ForgeData["domains"][string]>(`/sites/${s.id}/domains`);
  }
  return { server, sites, scripts, domains, daemons: await get("/background-processes"), jobs: await get("/scheduled-jobs") };
}

// ---- server files ---------------------------------------------------------------

export interface CollectedFile {
  path: string;
  mode: string;
  owner: string;
  content: Buffer;
}

export interface Collected {
  files: Map<string, CollectedFile>;
  php: string[];
  units: string[];
}

export interface CollectSpec {
  paths: string[];
  dirs: string[];
  poolUsers: string[];
}

/** Collect files over SSH from the real server. */
export async function collectRemote(runner: Runner, spec: CollectSpec): Promise<Collected> {
  const script = `${FACT_FN}
emit() { [ -f "$1" ] || return 0; printf '@@file\\t%s\\t%s\\t%s\\t' "$1" "$(stat -c %a "$1")" "$(stat -c %U:%G "$1")"; base64 -w0 "$1"; echo; }
for f in ${spec.paths.map(q).join(" ")}; do emit "$f"; done
for d in ${spec.dirs.map(q).join(" ")}; do [ -d "$d" ] && find "$d" -type f | sort | while read -r f; do emit "$f"; done; done
for u in ${spec.poolUsers.map(q).join(" ")}; do for f in $(grep -lE "^user *= *$u *$" /etc/php/*/fpm/pool.d/*.conf 2>/dev/null); do emit "$f"; done; done
for v in $(ls /etc/php 2>/dev/null); do [ -d /etc/php/$v/fpm ] && fact php "$v"; done
for u in mysql postgresql redis-server memcached supervisor fail2ban crowdsec; do systemctl cat "$u" >/dev/null 2>&1 && fact unit "$u"; done
true`;
  const out = (await runner.run(script)).stdout;
  const files = new Map<string, CollectedFile>();
  for (const line of out.split("\n")) {
    if (!line.startsWith("@@file\t")) continue;
    const [, path, mode, owner, data] = line.split("\t");
    files.set(path!, { path: path!, mode: mode!.padStart(4, "0"), owner: owner!, content: Buffer.from(data ?? "", "base64") });
  }
  const facts = parseFacts(out);
  return { files, php: facts.get("php") ?? [], units: facts.get("unit") ?? [] };
}

/** Collect files from a local directory that mirrors the server's filesystem (tests). */
export function collectLocal(root: string, spec: CollectSpec): Collected {
  const files = new Map<string, CollectedFile>();
  const add = (p: string) => {
    const local = join(root, p);
    if (!existsSync(local) || !statSync(local).isFile()) return;
    files.set(p, { path: p, mode: "0" + (statSync(local).mode & 0o777).toString(8), owner: "root:root", content: readFileSync(local) });
  };
  spec.paths.forEach(add);
  const walk = (p: string) => {
    const local = join(root, p);
    if (!existsSync(local)) return;
    for (const e of readdirSync(local, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(`${p}/${e.name}`);
      else add(`${p}/${e.name}`);
    }
  };
  spec.dirs.forEach(walk);
  const php = existsSync(join(root, "etc/php")) ? readdirSync(join(root, "etc/php")).sort() : [];
  for (const v of php) {
    const dir = `/etc/php/${v}/fpm/pool.d`;
    if (!existsSync(join(root, dir))) continue;
    for (const f of readdirSync(join(root, dir))) {
      const text = readFileSync(join(root, dir, f), "utf8");
      if (spec.poolUsers.some((u) => new RegExp(`^user *= *${u} *$`, "m").test(text))) add(`${dir}/${f}`);
    }
  }
  return { files, php, units: [] };
}

// ---- translation ------------------------------------------------------------------

export interface ImportPlan {
  server: Record<string, unknown>;
  /** Files to write into the fleet repo: path relative to the fleet dir → content. */
  files: Map<string, Buffer>;
  warnings: string[];
  sites: Array<{ site: string; preset: string; files: number; deploy_note: string }>;
}

const SENSITIVE = /(^|\/)\.htpasswd[^/]*$/;

export function collectSpec(data: ForgeData): CollectSpec {
  const paths = ["/etc/crontab"];
  const dirs: string[] = [];
  for (const s of data.sites) {
    const names = [s.attributes.name, ...(data.domains[s.id] ?? []).map((d) => d.attributes.name)];
    for (const n of new Set(names)) {
      paths.push(`/etc/nginx/sites-available/${n}`);
      dirs.push(`/etc/nginx/forge-conf/${n}`);
    }
    dirs.push(`/etc/nginx/forge-conf/${s.id}`);
    paths.push(`/etc/logrotate.d/forge-${s.id}`);
  }
  for (const d of data.daemons) paths.push(`/etc/supervisor/conf.d/daemon-${d.id}.conf`);
  return { paths: [...new Set(paths)], dirs: [...new Set(dirs)], poolUsers: [...new Set(data.sites.map((s) => s.attributes.user))] };
}

function presetOf(site: ForgeSite, script: string): "laravel" | "php" | "static" {
  if (site.app_type === "static-html") return "static";
  if (site.app_type === "laravel" || /\bartisan\b/.test(script)) return "laravel";
  return "php";
}

function repoOf(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const gh = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return gh ? gh[1] : url.replace(/^(\w+:\/\/)[^@/]+@/, "$1");
}

export function translate(data: ForgeData, collected: Collected, o: { name: string; host?: string; date: string }): ImportPlan {
  const warnings: string[] = [];
  const files = new Map<string, Buffer>();
  const adoptedDir = `adopted/${o.name}`;
  const taken = new Set<string>();
  const fileSpec = (f: CollectedFile) => {
    taken.add(f.path);
    const rel = `${adoptedDir}${f.path}`;
    files.set(rel, f.content);
    return { path: f.path, source: rel, mode: f.mode, owner: f.owner };
  };
  const filesUnder = (pred: (p: string) => boolean) => [...collected.files.values()].filter((f) => pred(f.path) && !taken.has(f.path));

  const sites: Record<string, unknown> = {};
  const summary: ImportPlan["sites"] = [];
  for (const s of data.sites) {
    const a = s.attributes;
    const domain = a.name;
    const names = [...new Set([domain, ...(data.domains[s.id] ?? []).map((d) => d.attributes.name)])];
    const script = data.scripts[s.id] ?? "";
    const preset = presetOf(a, script);
    const php = a.php_version.replace(/^PHP\s*/i, "").trim();
    const own = filesUnder(
      (p) =>
        names.some((n) => p === `/etc/nginx/sites-available/${n}` || p.startsWith(`/etc/nginx/forge-conf/${n}/`)) ||
        p.startsWith(`/etc/nginx/forge-conf/${s.id}/`) ||
        p === `/etc/logrotate.d/forge-${s.id}` ||
        new RegExp(`^/etc/php/[^/]+/fpm/pool.d/`).test(p) && new RegExp(`^user *= *${a.user} *$`, "m").test(collected.files.get(p)!.content.toString()) ||
        data.daemons.some((d) => d.attributes.user === a.user && p === `/etc/supervisor/conf.d/daemon-${d.id}.conf`),
    );
    const secret = own.filter((f) => SENSITIVE.test(f.path));
    for (const f of secret) {
      taken.add(f.path);
      warnings.push(`${domain}: ${f.path} holds password hashes — left on the server, not copied into the fleet repo (unmanaged)`);
    }
    const specs = own.filter((f) => !SENSITIVE.test(f.path)).map(fileSpec);

    // TLS paths from the vhost, so a later regeneration keeps using the same certificate
    const vhost = collected.files.get(`/etc/nginx/sites-available/${domain}`)?.content.toString() ?? "";
    const cert = vhost.match(/^\s*ssl_certificate\s+([^;\s]+);/m)?.[1];
    const key = vhost.match(/^\s*ssl_certificate_key\s+([^;\s]+);/m)?.[1];
    if (!vhost) warnings.push(`${domain}: no /etc/nginx/sites-available/${domain} found on the server`);

    const current = `/home/${a.user}/${domain}/current/`;
    // in-place sites serve straight from the site directory
    const base = a.zero_downtime_deployments ? current : `/home/${a.user}/${domain}/`;
    const webDir = `${a.web_directory}/`.startsWith(base) ? a.web_directory.slice(base.length).replace(/\/$/, "") || "." : undefined;
    const daemons = data.daemons
      .filter((d) => d.attributes.user === a.user)
      .map((d) => ({
        cmd: d.attributes.command,
        processes: d.attributes.processes,
        program: `daemon-${d.id}`,
        ...(d.attributes.directory && d.attributes.directory.replace(/\/$/, "") !== current.replace(/\/$/, "") ? { directory: d.attributes.directory } : {}),
      }));
    const jobs = data.jobs.filter((j) => j.attributes.user === a.user);
    // Forge's pool sizing, so a later conversion keeps the load behaviour
    const poolText = specs.map((f) => collected.files.get(f.path)!).find((f) => /^\/etc\/php\/[^/]+\/fpm\/pool\.d\//.test(f.path))?.content.toString() ?? "";
    const num = (k: string) => {
      const m = poolText.match(new RegExp(`^${k.replace(/\./g, "\\.")}\\s*=\\s*(\\d+)`, "m"));
      return m ? Number(m[1]) : undefined;
    };
    const pool = Object.fromEntries(
      [
        ["max_children", num("pm.max_children")],
        ["start_servers", num("pm.start_servers")],
        ["min_spare_servers", num("pm.min_spare_servers")],
        ["max_spare_servers", num("pm.max_spare_servers")],
        ["max_requests", num("pm.max_requests")],
        ["request_terminate_timeout", num("request_terminate_timeout")],
      ].filter(([, v]) => v !== undefined),
    );
    const notes = [
      `Imported from Forge site ${s.id} (${a.app_type ?? preset}${a.zero_downtime_deployments ? ", zero-downtime" : ", deploys in place"}) on ${o.date}.`,
      `Forge deploy script: ${adoptedDir}/forge/${domain}.deploy.sh.`,
      jobs.length ? `Cron (in /etc/crontab, adopted at server level): ${jobs.map((j) => `${j.attributes.cron} ${j.attributes.command}`).join(" | ")}.` : "",
      !a.zero_downtime_deployments ? `Forge deploys this site in place (no releases/); fornax keeps it that way (deploy.mode: in_place).` : "",
    ]
      .filter(Boolean)
      .join(" ");
    files.set(`${adoptedDir}/forge/${domain}.deploy.sh`, Buffer.from(script));

    const site: Record<string, unknown> = {
      adopted: true,
      ...(repoOf(a.repository?.url) ? { repo: repoOf(a.repository?.url) } : {}),
      ...(a.repository?.branch && a.repository.branch !== "main" ? { branch: a.repository.branch } : {}),
      user: a.user,
      php,
      preset,
      ...(webDir && webDir !== (preset === "static" ? "." : "public") ? { web_dir: webDir } : {}),
      ...(names.length > 1 ? { aliases: names.slice(1) } : {}),
      tls: cert && key ? { issuer: "existing", cert, key } : { issuer: "none" },
      ...(a.healthcheck_url ? { health_check: new URL(a.healthcheck_url).pathname } : {}),
      deploy: { enabled: false, ...(a.zero_downtime_deployments ? {} : { mode: "in_place" }), ...(a.deployment_retention ? { keep_releases: Math.max(2, a.deployment_retention) } : {}) },
      generate: { vhost: false, pool: false, daemons: false, cron: false, logrotate: false },
      ...(daemons.length ? { daemons } : {}),
      ...(Object.keys(pool).length ? { pool } : {}),
      files: specs,
      origin: {
        tool: "forge",
        site_id: s.id,
        domain_ids: (data.domains[s.id] ?? []).map((d) => d.id),
        zero_downtime: a.zero_downtime_deployments,
        cron: jobs.map((j) => ({ at: j.attributes.cron, cmd: j.attributes.command })),
      },
      notes,
    };
    sites[domain] = site;
    summary.push({ site: domain, preset, files: specs.length, deploy_note: a.zero_downtime_deployments ? "deploy disabled until you switch it on" : "deploys in place — deploy disabled until you switch it on" });
  }

  const serverFiles = [...collected.files.values()].filter((f) => f.path === "/etc/crontab").map(fileSpec);
  const forgeJobs = data.jobs.filter((j) => !data.sites.some((s) => s.attributes.user === j.attributes.user));
  if (forgeJobs.length) warnings.push(`server-level Forge jobs kept in /etc/crontab: ${forgeJobs.map((j) => j.attributes.command).join("; ")}`);
  const unmatched = [...collected.files.keys()].filter((p) => !taken.has(p));
  if (unmatched.length) warnings.push(`collected but not assigned to a site (left unmanaged): ${unmatched.join(", ")}`);

  const services = collected.units
    .map((u) => ({ postgresql: "postgres", "redis-server": "redis" })[u as "postgresql"] ?? u)
    .filter((u) => ["mysql", "postgres", "redis", "memcached", "supervisor", "fail2ban", "crowdsec"].includes(u));
  const php = [...new Set([...collected.php, ...data.sites.map((s) => s.attributes.php_version.replace(/^PHP\s*/i, ""))])].sort();
  const server: Record<string, unknown> = {
    server: o.name,
    host: o.host ?? data.server.ip_address,
    public_ipv4: data.server.ip_address,
    provider: data.server.provider === "hetzner" ? { type: "hetzner-cloud", ...(data.server.identifier ? { id: data.server.identifier } : {}) } : { type: "manual" },
    modules: [],
    // Forge runs nginx as forge; fornax's FPM sockets must belong to the same user
    admin_user: "forge",
    php,
    ...(services.length ? { services } : {}),
    files: serverFiles,
    sites,
    notes: `Imported from Laravel Forge server ${data.server.id} (${data.server.name}) on ${o.date}. modules: [] — fornax manages only the adopted files until you opt in. While Forge is still connected, avoid changing these sites in Forge: it regenerates the same files.`,
  };
  return { server, files, warnings, sites: summary };
}
