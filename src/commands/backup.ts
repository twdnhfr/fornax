import { defineCommand, requireConfirm } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { findSite, getServer, loadFleet } from "../core/fleet.ts";
import { ensureServerBinary } from "../core/server-binary.ts";
import { q } from "../core/shell.ts";
import { runnerFor, tail } from "../core/ssh.ts";
import { BOX_KEY, STATUS_FILE } from "../modules/backup.ts";
import { listSnapshots, restore, runBackup } from "../remote/backup.ts";

// ---- internal: on the server ---------------------------------------------------------

defineCommand({
  name: "backup-agent run",
  summary: "(server) run the backup — started by fornax-backup.timer",
  tier: "write",
  internal: true,
  options: { site: { type: "list", help: "only these sites" } },
  async run(input) {
    const r = await runBackup(input.site as string[] | undefined);
    return { data: r, human: "", exitCode: r.ok ? 0 : 1 };
  },
});

defineCommand({
  name: "backup-agent snapshots",
  summary: "(server) list restic snapshots as JSON",
  tier: "read",
  internal: true,
  options: { site: { type: "string", help: "only this site" } },
  async run(input) {
    return { data: listSnapshots(input.site as string | undefined) };
  },
});

defineCommand({
  name: "backup-agent restore",
  summary: "(server) restore a snapshot",
  tier: "write",
  internal: true,
  args: [{ name: "site", help: "site domain", required: true }],
  options: {
    snapshot: { type: "string", help: "snapshot id or latest", default: "latest" },
    db: { type: "boolean", help: "restore the database" },
    files: { type: "boolean", help: "restore shared paths and .env" },
    replace: { type: "boolean", help: "overwrite the live database/files" },
  },
  async run(input) {
    return { data: restore(String(input.site), String(input.snapshot), { db: Boolean(input.db), files: Boolean(input.files) }, Boolean(input.replace)) };
  },
});

// ---- for humans and agents ---------------------------------------------------------------

function ensureBackups(fleetHasBackup: boolean) {
  if (!fleetHasBackup) fail("no_backup", "this fleet has no backup configured", "add `backup: { storage_box: { host, user } }` to fornax.yaml, then plan + apply");
}

defineCommand({
  name: "backup status",
  summary: "last backup per site, next scheduled run, failures",
  tier: "read",
  args: [{ name: "server", help: "server name", required: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    ensureBackups(Boolean(fleet.config.backup));
    const server = getServer(fleet, String(input.server));
    const out = await runnerFor(fleet, server).run(`cat ${STATUS_FILE} 2>/dev/null || echo '{}'; echo; echo "@@next $(systemctl show fornax-backup.timer -p NextElapseUSecRealtime --value 2>/dev/null)"`);
    const [json, nextLine] = out.stdout.split("\n@@next ");
    const status = JSON.parse(json || "{}") as { updated?: string; sites?: Record<string, { ok: boolean; at: string; snapshot?: string; error?: string }> };
    const sites = Object.entries(status.sites ?? {}).map(([site, s]) => ({ site, ...s, age_hours: Math.round((Date.now() - Date.parse(s.at)) / 360000) / 10 }));
    const stale = sites.filter((s) => !s.ok || s.age_hours > 26);
    const next = nextLine?.trim() || null;
    const human = sites.length
      ? sites.map((s) => `${s.ok ? "ok " : "!! "} ${s.site.padEnd(32)} ${s.at.slice(0, 16)}Z  ${s.snapshot ?? ""}${s.error ? `  ${s.error}` : ""}`).join("\n") + `\nnext run: ${next ?? "?"}`
      : `no backup has run yet${next ? ` — next run: ${next}` : ""}`;
    return { data: { server: server.server, next_run: next, sites, problems: stale.map((s) => s.site) }, human, exitCode: stale.length ? 1 : 0 };
  },
});

defineCommand({
  name: "backup run",
  summary: "run the backup of a server now (all sites, or some)",
  tier: "write",
  args: [{ name: "server", help: "server name", required: true }],
  options: { site: { type: "list", help: "only these sites" } },
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    ensureBackups(Boolean(fleet.config.backup));
    const server = getServer(fleet, String(input.server));
    const sites = (input.site as string[] | undefined) ?? [];
    await ensureServerBinary(fleet, server, ctx.log);
    const res = await runnerFor(fleet, server).run(`/usr/local/bin/fornax backup-agent run --json ${sites.map((s) => `--site ${q(s)}`).join(" ")} 2>&1`, {
      allowFail: true,
      timeoutMs: 6 * 3_600_000,
      onStdout: (l) => (l.startsWith("=>") || l.startsWith("   ") ? ctx.log(l) : undefined),
    });
    const json = res.stdout.slice(res.stdout.indexOf("\n{") + 1);
    let data: { ok: boolean; sites: Record<string, { ok: boolean; snapshot?: string; error?: string }> };
    try {
      data = JSON.parse(json);
    } catch {
      return fail("backup_failed", "the backup did not finish", tail(res.stdout, 15));
    }
    const human = Object.entries(data.sites)
      .map(([s, r]) => `${r.ok ? "✓" : "✗"} ${s}${r.snapshot ? ` → ${r.snapshot}` : ""}${r.error ? `  ${r.error}` : ""}`)
      .join("\n");
    return { data, human, exitCode: data.ok ? 0 : 1 };
  },
});

defineCommand({
  name: "backup list",
  summary: "snapshots of a site (newest last)",
  tier: "read",
  args: [{ name: "site", help: "site domain", required: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    ensureBackups(Boolean(fleet.config.backup));
    const { server, site } = findSite(fleet, String(input.site));
    const res = await runnerFor(fleet, server).run(`/usr/local/bin/fornax backup-agent snapshots --site ${q(site.domain)} --json`);
    const snaps = JSON.parse(res.stdout) as Array<{ id: string; time: string }>;
    return { data: { site: site.domain, snapshots: snaps }, human: snaps.map((s) => `${s.id}  ${s.time.slice(0, 19)}`).join("\n") || "no snapshots yet" };
  },
});

defineCommand({
  name: "backup restore",
  summary: "restore a site from a snapshot — side by side by default; --replace overwrites the live data (needs --confirm=<site>)",
  tier: "write",
  args: [{ name: "site", help: "site domain", required: true }],
  options: {
    snapshot: { type: "string", help: "snapshot id (see `fornax backup list`) or latest", default: "latest" },
    only: { type: "string", help: "db or files (default: both)" },
    replace: { type: "boolean", help: "overwrite the live database and files instead of restoring next to them" },
    confirm: { type: "string", help: "with --replace: the site domain" },
  },
  examples: [
    "fornax backup restore shop.example.com                      # → database shop_restore_<stamp>, files in <root>/restore-<stamp>/",
    "fornax backup restore shop.example.com --snapshot 1a2b3c4d --only db --replace --confirm=shop.example.com",
  ],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    ensureBackups(Boolean(fleet.config.backup));
    const { server, site } = findSite(fleet, String(input.site));
    if (input.only && !["db", "files"].includes(String(input.only))) fail("invalid_option", "--only must be db or files");
    if (input.replace) requireConfirm(input, site.domain);
    const what = input.only ? `--${input.only}` : "--db --files";
    await ensureServerBinary(fleet, server, ctx.log);
    const res = await runnerFor(fleet, server).run(`/usr/local/bin/fornax backup-agent restore ${q(site.domain)} --snapshot ${q(String(input.snapshot))} ${what} ${input.replace ? "--replace" : ""} --json`, { allowFail: true, timeoutMs: 6 * 3_600_000 });
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(res.stdout);
    } catch {
      return fail("restore_failed", "restore failed", tail(res.stdout + res.stderr, 10));
    }
    if (res.code !== 0) fail("restore_failed", String(data.error ?? "restore failed"), String(data.hint ?? ""));
    const d = data as { snapshot: string; db?: { restored_into: string; replaced: boolean }; files?: { restored_to: string; replaced: boolean } };
    const human = [
      `restored snapshot ${d.snapshot} of ${site.domain}`,
      d.db ? `  database → ${d.db.restored_into}${d.db.replaced ? " (replaced the live database)" : " (side by side; the live database is untouched)"}` : "",
      d.files ? `  files → ${d.files.restored_to}${d.files.replaced ? " (replaced the live files)" : " (side by side)"}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { data, human };
  },
});

defineCommand({
  name: "backup key",
  summary: "public key a server uses for the Storage Box (add it there if fornax cannot do it with the box password)",
  tier: "read",
  args: [{ name: "server", help: "server name", required: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    const out = await runnerFor(fleet, server).run(`cat ${BOX_KEY}.pub 2>/dev/null || true`);
    if (!out.stdout.trim()) fail("no_key", `${server.server} has no Storage Box key yet`, undefined, `fornax plan ${server.server}`);
    return { data: { server: server.server, public_key: out.stdout.trim() }, human: out.stdout.trim() };
  },
});
