import { isAbsolute } from "node:path";
import type { ResolvedSite } from "../core/fleet.ts";
import { check, dir, file, packages, service, type Resource } from "../core/resource.ts";
import { q, sha256 } from "../core/shell.ts";
import { HEADER, SECRETS, secretFile, type ModuleCtx } from "./common.ts";
import { siteRuntimeNtfy } from "../core/runtime.ts";
import { binaryResource, ntfyTokenResources } from "./deploy.ts";

const H = `# ${HEADER}\n`;
export const BACKUP_DIR = "/etc/fornax/backup";
export const BACKUP_CONFIG = `${BACKUP_DIR}/config.json`;
export const SSH_CONFIG = `${BACKUP_DIR}/ssh_config`;
export const BOX_KEY = "/root/.ssh/fornax-storagebox";
export const RESTIC_PASSWORD = `${SECRETS}/restic`;
export const HEARTBEAT_FILE = `${SECRETS}/backup-heartbeat`;
export const STATUS_FILE = "/var/lib/fornax/backup-status.json";
const SFTP = `ssh -F ${SSH_CONFIG} fornax-storagebox -s sftp`;

/** What `fornax backup-agent` reads on the server. */
export interface BackupRuntime {
  version: 1;
  fleet: string;
  server: string;
  /** Every name the server had (current first): snapshots carry the name they were made under. */
  hosts?: string[];
  repository: string;
  sftp_command: string;
  password_file: string;
  keep: { daily: number; weekly: number; monthly: number };
  heartbeat_file: string | null;
  staging: string;
  sites: Array<{ domain: string; user: string; root: string; db: { engine: "mysql" | "postgres"; name: string; user: string } | null; paths: string[] }>;
  /** Where failed runs are reported (missing in older configs = nowhere). */
  notify?: { ntfy: { url: string; email?: string; token_file?: string } | null };
}

export function backupSites(ctx: ModuleCtx): ResolvedSite[] {
  return ctx.sites.filter((s) => s.spec.state === "present" && s.spec.backup.enabled);
}

export const backupEnabled = (ctx: Pick<ModuleCtx, "fleet" | "server" | "sites">) =>
  Boolean(ctx.fleet.config.backup) && ctx.server.backup !== false && ctx.sites.some((s) => s.spec.state === "present" && s.spec.backup.enabled);

export function backupRuntime(ctx: ModuleCtx, heartbeat: boolean): BackupRuntime {
  const b = ctx.fleet.config.backup!;
  const repoPath = `${b.storage_box.path.replace(/\/+$/, "")}/${ctx.fleet.config.fleet}/${ctx.server.server}`;
  return {
    version: 1,
    fleet: ctx.fleet.config.fleet,
    server: ctx.server.server,
    ...(ctx.server.former_names.length ? { hosts: [ctx.server.server, ...ctx.server.former_names] } : {}),
    repository: `sftp:fornax-storagebox:${repoPath}`,
    sftp_command: SFTP,
    password_file: RESTIC_PASSWORD,
    keep: b.keep,
    heartbeat_file: heartbeat ? HEARTBEAT_FILE : null,
    staging: "/var/lib/fornax/backup-staging",
    sites: backupSites(ctx).map((s) => ({
      domain: s.domain,
      user: s.user,
      root: s.root,
      db: s.db ? { engine: s.db.engine, name: s.db.name, user: s.db.user } : null,
      paths: [...new Set([...s.shared.map((p) => `${s.root}/${p}`), `${s.root}/.env`, ...s.spec.backup.paths.map((p) => (isAbsolute(p) ? p : `${s.root}/${p}`))])],
    })),
    notify: { ntfy: siteRuntimeNtfy(ctx.fleet) },
  };
}

const sshConfig = (ctx: ModuleCtx) => {
  const box = ctx.fleet.config.backup!.storage_box;
  return `${H}Host fornax-storagebox
    HostName ${box.host}
    User ${box.user}
    Port ${box.port}
    IdentityFile ${BOX_KEY}
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
    UserKnownHostsFile ${BACKUP_DIR}/known_hosts
    ServerAliveInterval 60
    BatchMode yes
`;
};

const UNIT = `${H}[Unit]
Description=fornax backup (database dumps, uploads, .env → restic on the Storage Box)
After=network-online.target

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
ExecStart=/usr/local/bin/fornax backup-agent run
TimeoutStartSec=6h
`;

const timer = (at: string) => `${H}[Unit]
Description=nightly fornax backup

[Timer]
OnCalendar=*-*-* ${at}:00 UTC
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
`;

export function backupResources(ctx: ModuleCtx): Resource[] {
  if (!backupEnabled(ctx) || !ctx.facts.binary) return [];
  const b = ctx.fleet.config.backup!;
  const o = { owner: "backup" };
  const rt = backupRuntime(ctx, Boolean(ctx.facts.heartbeat));
  const restic = `RESTIC_PASSWORD_FILE=${RESTIC_PASSWORD} restic -r ${q(rt.repository)} -o sftp.command=${q(SFTP)}`;
  const r: Resource[] = [
    binaryResource(ctx)!,
    packages("backup", ["restic", "openssh-client", ...(b.storage_box.password ? ["sshpass"] : [])], o),
    dir(BACKUP_DIR, { ...o, mode: "0700" }),
    dir("/var/lib/fornax/backup-staging", { ...o, mode: "0700" }),
    file(SSH_CONFIG, sshConfig(ctx), { ...o, mode: "0600", handler: "none" }),
    check("storagebox-key", `SSH key ${BOX_KEY} for the Storage Box`, `[ -f ${BOX_KEY} ]`, `install -d -m 0700 /root/.ssh; [ -f ${BOX_KEY} ] || ssh-keygen -q -t ed25519 -N '' -C ${q(`fornax ${ctx.fleet.config.fleet}/${ctx.server.server}`)} -f ${BOX_KEY}`, o),
  ];
  // The box accepts the key once it is installed — automatically with the box password from 1Password, by hand otherwise.
  const reachable = `echo pwd | sftp -q -F ${SSH_CONFIG} -b - fornax-storagebox >/dev/null 2>&1`;
  const install = b.storage_box.password
    ? `SSHPASS="$FORNAX_SECRET_STORAGEBOX" sshpass -e ssh -F ${SSH_CONFIG} -o BatchMode=no -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive fornax-storagebox install-ssh-key < ${BOX_KEY}.pub
${reachable} || { echo "the Storage Box still refuses the key after install-ssh-key" >&2; exit 1; }`
    : `echo "the Storage Box does not accept this server's key yet. Add it to the box (or set backup.storage_box.password so fornax can):" >&2; cat ${BOX_KEY}.pub >&2; exit 1`;
  r.push({
    // the key moved from the old name is already accepted: nothing to install then
    ...check("storagebox-access", `Storage Box ${b.storage_box.user}@${b.storage_box.host} accepts this server's key`, reachable, `${reachable} || {\n${install}\n}`, o),
    ...(b.storage_box.password ? { env: { FORNAX_SECRET_STORAGEBOX: b.storage_box.password } } : {}),
  });
  r.push(secretFile(RESTIC_PASSWORD, "backup", { bytes: 32 }));
  // Before the rename the default directory on the box was "anvil": move the repository over
  // (one sftp rename, snapshots and key stay as they are) instead of starting an empty one.
  if (ctx.facts.legacy && b.storage_box.path.replace(/\/+$/, "") === "fornax") {
    const tail = `${ctx.fleet.config.fleet}/${ctx.server.server}`;
    // the plan is made before the move, when only the old SSH config exists: use whichever is there
    const box = `c=${SSH_CONFIG}; h=fornax-storagebox; [ -f "$c" ] || { c=/etc/anvil/backup/ssh_config; h=anvil-storagebox; }
has() { echo "ls $1/config" | sftp -q -F "$c" -b - "$h" >/dev/null 2>&1; }`;
    r.push(
      check(
        "restic-repo-rename",
        `move the backup repository anvil/${tail} → fornax/${tail} on the Storage Box`,
        `${box}; has fornax/${tail} || ! has anvil/${tail}`,
        `${box}
has fornax/${tail} || printf '%s\\n' '-mkdir fornax' '-mkdir fornax/${ctx.fleet.config.fleet}' 'rename anvil/${tail} fornax/${tail}' | sftp -q -F "$c" -b - "$h"`,
        o,
      ),
    );
  }
  // after `server rename` the repository moves with the name: one sftp rename, snapshots and key stay as they are
  const base = `${b.storage_box.path.replace(/\/+$/, "")}/${ctx.fleet.config.fleet}`;
  for (const old of ctx.server.former_names) {
    const has = `has() { echo "ls $1/config" | sftp -q -F ${SSH_CONFIG} -b - fornax-storagebox >/dev/null 2>&1; }`;
    r.push(
      check(
        `restic-repo-move:${old}`,
        `move the backup repository ${base}/${old} → ${base}/${ctx.server.server} on the Storage Box (renamed server)`,
        `${has}; has ${q(`${base}/${ctx.server.server}`)} || ! has ${q(`${base}/${old}`)}`,
        `${has}; has ${q(`${base}/${ctx.server.server}`)} || printf '%s\\n' ${q(`rename ${base}/${old} ${base}/${ctx.server.server}`)} | sftp -q -F ${SSH_CONFIG} -b - fornax-storagebox`,
        o,
      ),
    );
  }
  r.push(check("restic-repo", `restic repository ${rt.repository}`, `${restic} cat config`, `${restic} cat config >/dev/null 2>&1 || ${restic} init`, o));
  if (ctx.facts.heartbeat) {
    const hb = ctx.facts.heartbeat;
    r.push(
      hb.ref
        ? {
            ...check("backup-heartbeat", `heartbeat URL ${HEARTBEAT_FILE} (from ${hb.ref})`, `[ "$(sha256sum < ${HEARTBEAT_FILE} 2>/dev/null | cut -c1-64)" = ${q(sha256(hb.value))} ]`, `umask 077; printf %s "$FORNAX_SECRET_HEARTBEAT" > ${HEARTBEAT_FILE}`, o),
            env: { FORNAX_SECRET_HEARTBEAT: hb.ref },
          }
        : file(HEARTBEAT_FILE, hb.value, { ...o, mode: "0600" }),
    );
  }
  r.push(
    ...ntfyTokenResources(ctx),
    file(BACKUP_CONFIG, JSON.stringify(rt, null, 2) + "\n", { ...o, mode: "0600", handler: "none" }),
    file("/etc/systemd/system/fornax-backup.service", UNIT, o),
    file("/etc/systemd/system/fornax-backup.timer", timer(b.at), { ...o, handler: "backup-timer" }),
    service("fornax-backup.timer", o),
  );
  return r;
}
