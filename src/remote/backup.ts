/**
 * `fornax backup-agent` — runs ON the server as root (fornax-backup.service or `fornax backup …`).
 * Per site: dump the database, then one restic snapshot of dump + shared paths + .env, tagged
 * site:<domain>. Afterwards forget/prune by the keep policy, write a status file, ping the heartbeat.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackupRuntime } from "../modules/backup.ts";
import { FornaxError } from "../core/errors.ts";

const CONFIG = "/etc/fornax/backup/config.json";
const STATUS = "/var/lib/fornax/backup-status.json";

export function loadBackupConfig(): BackupRuntime {
  if (!existsSync(CONFIG)) throw new FornaxError("backup_error", `no ${CONFIG} — backups are not set up on this server (fornax plan/apply)`);
  return JSON.parse(readFileSync(CONFIG, "utf8")) as BackupRuntime;
}

function sh(argv: string[], o: { stdoutFile?: string; stdinFile?: string; env?: Record<string, string> } = {}) {
  const out = o.stdoutFile ? openSync(o.stdoutFile, "w", 0o600) : undefined;
  const inp = o.stdinFile ? openSync(o.stdinFile, "r") : undefined;
  const p = Bun.spawnSync(argv, { stdout: out ?? "pipe", stderr: "pipe", stdin: inp ?? "ignore", env: { ...process.env, ...o.env } });
  if (out !== undefined) closeSync(out);
  if (inp !== undefined) closeSync(inp);
  return { code: p.exitCode ?? 1, out: out === undefined ? (p.stdout?.toString() ?? "") : "", err: p.stderr.toString() };
}

/** --host for every name the server had: snapshots keep the name they were made under (restic 0.16 cannot rewrite it). */
const hostArgs = (cfg: BackupRuntime) => (cfg.hosts ?? [cfg.server]).flatMap((h) => ["--host", h]);

function restic(cfg: BackupRuntime, args: string[]) {
  return sh(["restic", "-r", cfg.repository, "-o", `sftp.command=${cfg.sftp_command}`, ...args], { env: { RESTIC_PASSWORD_FILE: cfg.password_file } });
}

export interface SiteBackup {
  ok: boolean;
  at: string;
  snapshot?: string;
  files?: number;
  bytes_added?: number;
  seconds: number;
  error?: string;
}

function dump(site: BackupRuntime["sites"][number], stage: string): string | null {
  if (!site.db) return null;
  if (site.db.engine === "postgres") {
    const f = join(stage, "db.pgdump");
    const r = sh(["runuser", "-u", "postgres", "--", "pg_dump", "--format=custom", site.db.name], { stdoutFile: f });
    if (r.code !== 0) throw new FornaxError("backup_error", `pg_dump ${site.db.name}: ${r.err.trim()}`);
    return f;
  }
  const f = join(stage, "db.sql");
  const r = sh(["mysqldump", "--single-transaction", "--quick", "--routines", "--triggers", "--no-tablespaces", "--databases", site.db.name], { stdoutFile: f });
  if (r.code !== 0) throw new FornaxError("backup_error", `mysqldump ${site.db.name}: ${r.err.trim()}`);
  return f;
}

export async function runBackup(only?: string[], log: (l: string) => void = (l) => process.stdout.write(l + "\n")): Promise<{ ok: boolean; sites: Record<string, SiteBackup> }> {
  const cfg = loadBackupConfig();
  const status: Record<string, SiteBackup> = existsSync(STATUS) ? (JSON.parse(readFileSync(STATUS, "utf8")) as { sites: Record<string, SiteBackup> }).sites : {};
  const result: Record<string, SiteBackup> = {};
  for (const site of cfg.sites.filter((s) => !only?.length || only.includes(s.domain))) {
    const started = Date.now();
    const stage = join(cfg.staging, site.domain);
    try {
      rmSync(stage, { recursive: true, force: true });
      mkdirSync(stage, { recursive: true, mode: 0o700 });
      log(`=> ${site.domain}`);
      const db = dump(site, stage);
      if (db) log(`   dumped ${site.db!.engine} database ${site.db!.name}`);
      const paths = [stage, ...site.paths.filter((p) => existsSync(p))];
      const r = restic(cfg, ["backup", "--json", "--host", cfg.server, "--tag", "fornax", "--tag", `site:${site.domain}`, ...paths]);
      if (r.code !== 0) throw new FornaxError("backup_error", `restic backup: ${r.err.trim().split("\n").pop()}`);
      const summary = r.out
        .split("\n")
        .map((l) => {
          try {
            return JSON.parse(l) as { message_type?: string; snapshot_id?: string; total_files_processed?: number; data_added?: number };
          } catch {
            return {};
          }
        })
        .find((x) => x.message_type === "summary");
      result[site.domain] = { ok: true, at: new Date().toISOString(), snapshot: summary?.snapshot_id?.slice(0, 8), files: summary?.total_files_processed, bytes_added: summary?.data_added, seconds: Math.round((Date.now() - started) / 100) / 10 };
      log(`   snapshot ${summary?.snapshot_id?.slice(0, 8)} (${summary?.total_files_processed} files, +${summary?.data_added} bytes)`);
    } catch (e) {
      result[site.domain] = { ok: false, at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 100) / 10, error: (e as Error).message };
      log(`   FAILED: ${(e as Error).message}`);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    const keep = cfg.keep;
    const f = restic(cfg, ["forget", ...hostArgs(cfg), "--tag", `site:${site.domain}`, "--group-by", "tags", "--keep-daily", String(keep.daily), "--keep-weekly", String(keep.weekly), "--keep-monthly", String(keep.monthly), "--prune"]);
    if (f.code !== 0) log(`   forget/prune failed: ${f.err.trim().split("\n").pop()}`);
  }
  const all = { ...status, ...result };
  for (const d of Object.keys(all)) if (!cfg.sites.some((s) => s.domain === d)) delete all[d];
  const ok = Object.values(result).every((r) => r.ok);
  writeFileSync(STATUS + ".tmp", JSON.stringify({ updated: new Date().toISOString(), sites: all }, null, 2));
  renameSync(STATUS + ".tmp", STATUS);
  if (!ok && cfg.notify?.ntfy) await notifyFailure(cfg, result, log);
  if (cfg.heartbeat_file && existsSync(cfg.heartbeat_file) && !only?.length) {
    const url = readFileSync(cfg.heartbeat_file, "utf8").trim();
    try {
      const res = await fetch(ok ? url : `${url.replace(/\/$/, "")}/fail`, { method: "POST", body: JSON.stringify(result), signal: AbortSignal.timeout(15_000) });
      log(`=> heartbeat ${ok ? "ok" : "fail"}: HTTP ${res.status}`);
    } catch (e) {
      log(`=> heartbeat failed: ${(e as Error).message}`);
    }
  }
  return { ok, sites: result };
}

/** Failed sites go to the fleet's ntfy target: a push, and a mail when one is configured. */
export async function notifyFailure(cfg: BackupRuntime, result: Record<string, SiteBackup>, log: (l: string) => void) {
  const n = cfg.notify!.ntfy!;
  const failed = Object.entries(result).filter(([, r]) => !r.ok);
  const token = n.token_file && existsSync(n.token_file) ? readFileSync(n.token_file, "utf8").trim() : "";
  const send = (email?: string) =>
    fetch(n.url, {
      method: "POST",
      headers: {
        title: `${cfg.server}: backup FAILED (${failed.length} of ${Object.keys(result).length} sites)`,
        priority: "high",
        tags: "x",
        ...(email ? { email } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "user-agent": "fornax",
      },
      body: [...failed.map(([domain, r]) => `${domain}: ${r.error}`), `fornax backup status ${cfg.server}`].join("\n"),
      signal: AbortSignal.timeout(10_000),
    });
  try {
    let res = await send(n.email);
    if (!res.ok && n.email) {
      log(`=> ntfy refused the mail (HTTP ${res.status}) — sending the push without it`);
      res = await send();
    }
    log(`=> ntfy: HTTP ${res.status}`);
  } catch (e) {
    log(`=> ntfy failed: ${(e as Error).message}`);
  }
}

export interface Snapshot {
  id: string;
  time: string;
  site: string;
  paths: string[];
}

export function listSnapshots(site?: string): Snapshot[] {
  const cfg = loadBackupConfig();
  const r = restic(cfg, ["snapshots", "--json", ...hostArgs(cfg), ...(site ? ["--tag", `site:${site}`] : [])]);
  if (r.code !== 0) throw new FornaxError("backup_error", `restic snapshots: ${r.err.trim().split("\n").pop()}`);
  return (JSON.parse(r.out || "[]") as Array<{ short_id: string; time: string; tags?: string[]; paths: string[] }>).map((s) => ({
    id: s.short_id,
    time: s.time,
    site: s.tags?.find((t) => t.startsWith("site:"))?.slice(5) ?? "?",
    paths: s.paths,
  }));
}

export interface RestoreResult {
  site: string;
  snapshot: string;
  db?: { restored_into: string; replaced: boolean };
  files?: { restored_to: string; replaced: boolean };
}

/**
 * Restore a snapshot. Without `replace` nothing existing is touched: the database goes into
 * <name>_restore_<stamp>, files into <site root>/restore-<stamp>/. With `replace` the live
 * database and shared paths/.env are overwritten.
 */
export function restore(domain: string, snapshot: string, what: { db: boolean; files: boolean }, replace: boolean): RestoreResult {
  const cfg = loadBackupConfig();
  const site = cfg.sites.find((s) => s.domain === domain);
  if (!site) throw new FornaxError("backup_error", `${domain} is not backed up on this server`);
  const snaps = listSnapshots(domain);
  const snap = snapshot === "latest" ? snaps[snaps.length - 1] : snaps.find((s) => s.id.startsWith(snapshot));
  if (!snap) throw new FornaxError("backup_error", `no snapshot ${snapshot} for ${domain} (have: ${snaps.map((s) => s.id).join(", ") || "none"})`);
  // to the second, and counted on if a restore of this site in the same second left its directory
  const base = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  let stamp = base;
  for (let n = 2; existsSync(join(site.root, `restore-${stamp}`)) || existsSync(`/var/lib/fornax/restore/${domain}-${stamp}`); n++) stamp = `${base}_${n}`;
  const tmp = `/var/lib/fornax/restore/${domain}-${stamp}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const r = restic(cfg, ["restore", snap.id, "--target", tmp]);
  if (r.code !== 0) throw new FornaxError("backup_error", `restic restore: ${r.err.trim().split("\n").pop()}`);
  const result: RestoreResult = { site: domain, snapshot: snap.id };
  // snapshots taken before the rename keep their dump under the old staging path
  const stage = [cfg.staging, "/var/lib/anvil/backup-staging"].map((s) => join(tmp, s, domain)).find((p) => existsSync(p)) ?? join(tmp, cfg.staging, domain);

  if (what.db && site.db) {
    const db = site.db;
    const target = replace ? db.name : `${db.name}_restore_${stamp}`;
    if (db.engine === "postgres") {
      const dumpFile = join(stage, "db.pgdump");
      if (!existsSync(dumpFile)) throw new FornaxError("backup_error", "the snapshot has no postgres dump");
      if (!replace) {
        const c = sh(["runuser", "-u", "postgres", "--", "createdb", "-O", db.user, target]);
        if (c.code !== 0) throw new FornaxError("backup_error", `createdb ${target}: ${c.err.trim()}`);
      }
      // Extensions (e.g. pgvector) need a superuser; the restore runs as the app's role. Without
      // them every table using their types would be missing from the restored database.
      const list = sh(["pg_restore", "--list", dumpFile]);
      for (const ext of [...list.out.matchAll(/^\d+; \d+ \d+ EXTENSION - (\S+)/gm)].map((m) => m[1]!)) {
        const c = sh(["runuser", "-u", "postgres", "--", "psql", "-q", "-d", target, "-c", `CREATE EXTENSION IF NOT EXISTS "${ext}"`]);
        if (c.code !== 0) throw new FornaxError("backup_error", `create extension ${ext} in ${target}: ${c.err.trim()}`);
      }
      // --no-privileges: every object belongs to the app's role after this restore anyway; grants made
      // by other roles (e.g. postgres' default privileges) cannot be set by it and are not needed
      const args = ["runuser", "-u", "postgres", "--", "pg_restore", "--no-owner", "--no-privileges", `--role=${db.user}`, "-d", target, ...(replace ? ["--clean", "--if-exists"] : [])];
      const p = sh(args, { stdinFile: dumpFile });
      // only the comment on an extension (owned by the superuser) may fail; anything else means missing data
      const errors = p.err.split("\n").filter((l) => /^pg_restore: error:/.test(l) && !/COMMENT ON EXTENSION|must be owner of extension/.test(l));
      const detail = p.err.split("\n").filter((l) => /^pg_restore: (error|detail):/.test(l));
      if (errors.length || (p.code !== 0 && !/errors ignored on restore/.test(p.err))) {
        throw new FornaxError("backup_error", `pg_restore into ${target} failed: ${detail.slice(0, 6).join(" | ") || p.err.trim().split("\n").slice(-3).join(" ")}`);
      }
    } else {
      const dumpFile = join(stage, "db.sql");
      if (!existsSync(dumpFile)) throw new FornaxError("backup_error", "the snapshot has no mysql dump");
      // the dump carries `CREATE DATABASE/USE <name>`; for a side-by-side restore, point it at the new name
      let sql = readFileSync(dumpFile, "utf8");
      if (!replace) {
        sql = sql.replaceAll(`\`${db.name}\``, `\`${target}\``);
        // grant to the hosts the user really has (Forge makes 'user'@'%', fornax 'user'@'localhost')
        const hosts = sh(["mysql", "-N", "-e", `SELECT host FROM mysql.user WHERE user='${db.user}'`]).out.split("\n").filter(Boolean);
        const grants = hosts.map((h) => `GRANT ALL PRIVILEGES ON \`${target}\`.* TO '${db.user}'@'${h}';`).join(" ");
        const g = sh(["mysql", "-e", `CREATE DATABASE \`${target}\`; ${grants}`]);
        if (g.code !== 0) {
          sh(["mysql", "-e", `DROP DATABASE IF EXISTS \`${target}\``]);
          throw new FornaxError("backup_error", `mysql create ${target}: ${g.err.trim()}`);
        }
      }
      const f = join(tmp, "import.sql");
      writeFileSync(f, sql, { mode: 0o600 });
      const p = sh(["mysql"], { stdinFile: f });
      if (p.code !== 0) throw new FornaxError("backup_error", `mysql import: ${p.err.trim()}`);
    }
    result.db = { restored_into: target, replaced: replace };
  }

  if (what.files) {
    const restoredPaths = site.paths.filter((p) => existsSync(join(tmp, p)));
    if (replace) {
      for (const p of restoredPaths) {
        const from = join(tmp, p);
        const isDir = sh(["test", "-d", from]).code === 0;
        const s = sh(["rsync", "-a", "--delete", isDir ? `${from}/` : from, p]);
        if (s.code !== 0) throw new FornaxError("backup_error", `rsync ${p}: ${s.err.trim()}`);
        sh(["chown", "-R", `${site.user}:${site.user}`, p]);
      }
      result.files = { restored_to: site.root, replaced: true };
    } else {
      const dest = join(site.root, `restore-${stamp}`);
      mkdirSync(dest, { recursive: true });
      for (const p of restoredPaths) renameSync(join(tmp, p), join(dest, p.slice(site.root.length + 1) || p.split("/").pop()!));
      sh(["chown", "-R", `${site.user}:${site.user}`, dest]);
      result.files = { restored_to: dest, replaced: false };
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  return result;
}
