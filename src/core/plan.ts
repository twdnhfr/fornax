import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FornaxError, fail } from "./errors.ts";
import { isProtected, secret, stateDir, type Fleet } from "./fleet.ts";
import { APPLY_LIB, HANDLERS, handlerFor, type Resource } from "./resource.ts";
import type { Server } from "./schema.ts";
import { b64, q } from "./shell.ts";
import { runnerFor, tail } from "./ssh.ts";
import { actor, etcCommit, etcCommitOutside, fleetRevision, fornaxMessage } from "./etc-history.ts";
import { BUILD, VERSION } from "./version.ts";

export type Action = "create" | "update" | "delete" | "install" | "run";

export interface Change {
  id: string;
  kind: Resource["kind"];
  owner: string;
  summary: string;
  action: Action;
  /** Probed state before the change. */
  current: string;
  destructive: boolean;
  path?: string;
}

export interface Plan {
  version: 1;
  id: string;
  fleet: string;
  server: string;
  host: string;
  created: string;
  scope: { modules: string[]; sites: string[] };
  changes: Change[];
  unchanged: number;
  destructive: boolean;
  /** States of ALL probed resources — apply refuses if any of them changed since. */
  states: Record<string, string>;
  probeHash: string;
  probeScript: string;
  script: string;
  uploads: Array<{ local: string; remote: string; sha: string }>;
  /** ENV_NAME → secret reference, resolved at apply time. */
  secretEnv: Record<string, string>;
  warnings: string[];
}

export const PLAN_TTL_HOURS = 24;

/** How long fornax keeps its own traces on a server. */
export const RETENTION = { backupDays: 14, logDays: 90, deployLogs: 50 };

export function probeScript(resources: Resource[]): string {
  return [
    "export LC_ALL=C",
    // Leading newline: a probe may not end its output with one.
    ...resources.map((r, i) => `printf '\\n@@${i}\\n'; ( ${r.probe} ) 2>/dev/null || echo probe-error`),
    "printf '\\n@@end\\n'",
  ].join("\n");
}

export function parseProbe(out: string, resources: Resource[]): Record<string, string> {
  const states: Record<string, string> = {};
  let cur: number | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (cur !== undefined) states[resources[cur]!.id] = buf.join("\n").trim();
    buf = [];
  };
  for (const line of out.split("\n")) {
    const m = line.match(/^@@(\d+|end)$/);
    if (m) {
      flush();
      cur = m[1] === "end" ? undefined : Number(m[1]);
    } else if (cur !== undefined) buf.push(line);
  }
  flush();
  for (const r of resources) if (!(r.id in states)) fail("probe_failed", `probe output incomplete (no state for ${r.id})`);
  return states;
}

function actionFor(r: Resource, current: string): Action {
  if (r.kind === "absent") return "delete";
  if (r.kind === "packages") return "install";
  if (r.kind === "check" || r.kind === "service") return "run";
  return current === "missing" ? "create" : "update";
}

export function computeChanges(resources: Resource[], states: Record<string, string>): { changed: Resource[]; changes: Change[] } {
  const changed = resources.filter((r) => states[r.id] !== r.desired);
  const changes = changed.map((r) => ({
    id: r.id,
    kind: r.kind,
    owner: r.owner,
    summary: r.kind === "packages" ? missingPackagesSummary(r, states[r.id]!) : r.summary,
    action: actionFor(r, states[r.id]!),
    current: states[r.id]!,
    destructive: Boolean(r.destructive),
    path: r.path,
  }));
  return { changed, changes };
}

function missingPackagesSummary(r: Resource, current: string): string {
  const have = new Set(current.split(" ").filter(Boolean));
  const missing = r.desired.split(" ").filter((p) => !have.has(p));
  return `install ${missing.join(" ")}`;
}

export function applyScript(changed: Resource[], phpVersions: string[] = []): string {
  // Every known handler gets a case: pending reloads from an earlier run may need any of them.
  const handlers = [
    ...new Set([...Object.keys(HANDLERS), ...phpVersions.map((v) => `php${v}-fpm`), ...changed.map((r) => r.handler).filter((h): h is string => Boolean(h))]),
  ].filter((h) => h !== "none");
  const cases = handlers
    .map((h) => {
      const def = handlerFor(h);
      const validate = def.validate
        ? `if ! ( ${def.validate} ); then echo "@@validate_failed ${h}"; fornax_restore ${q(h)}; exit 70; fi; `
        : "";
      return `      ${q(h)}) ${validate}echo "@@handler ${h}"; ( ${def.reload} ) ;;`;
    })
    .join("\n");
  const steps = changed.map((r, i) => {
    const lines = [];
    if (r.flushBefore) lines.push("fornax_flush");
    lines.push(`echo "@@step ${i + 1}/${changed.length} ${r.id}"`);
    lines.push(`{\n${r.apply}\n}`);
    if (r.handler && r.handler !== "none") lines.push(`fornax_pending ${q(r.handler)}`);
    return lines.join("\n");
  });
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive LC_ALL=C",
    ': "${FORNAX_RUN:?}"',
    APPLY_LIB,
    "fornax_flush() {",
    "  local h",
    "  for h in $PENDING; do",
    '    case "$h" in',
    cases,
    "    esac",
    '    rm -f "$BK/$h.list"',
    "  done",
    '  PENDING=""',
    "}",
    "",
    ...steps,
    "fornax_flush",
    'echo "@@done"',
    // Housekeeping: nothing else on the server cleans up after fornax.
    "find /var/lib/fornax/backup -mindepth 1 -maxdepth 1 -type d -empty -delete 2>/dev/null || true",
    `find /var/lib/fornax/backup -mindepth 1 -maxdepth 1 -mtime +${RETENTION.backupDays} -exec rm -rf {} + 2>/dev/null || true`,
    `find /var/log/fornax -maxdepth 1 -type f -mtime +${RETENTION.logDays} -delete 2>/dev/null || true`,
    "find /var/tmp/fornax-staging -maxdepth 1 -type f -mtime +1 -delete 2>/dev/null || true",
  ].join("\n");
}

export function makePlan(fleet: Fleet, server: Server, resources: Resource[], probed: Probed, scope: Plan["scope"], warnings: string[] = []): Plan {
  const states = probed.states;
  const seen = new Set<string>();
  for (const r of resources) {
    if (seen.has(r.id)) fail("config_conflict", `two parts of the config manage the same thing: ${r.id}`, "a file can only come from one place — remove the duplicate");
    seen.add(r.id);
  }
  const { changed, changes } = computeChanges(resources, states);
  const id = Math.random().toString(16).slice(2, 10);
  const plan: Plan = {
    version: 1,
    id,
    fleet: fleet.config.fleet,
    server: server.server,
    host: server.host,
    created: new Date().toISOString(),
    scope,
    changes,
    unchanged: resources.length - changed.length,
    destructive: changes.some((c) => c.destructive),
    states,
    probeHash: probed.hash,
    probeScript: probeScript(resources),
    script: changed.length ? applyScript(changed, server.php) : "",
    uploads: changed.flatMap((r) => (r.upload ? [r.upload] : [])),
    secretEnv: Object.assign({}, ...changed.map((r) => r.env ?? {})),
    warnings,
  };
  if (changed.length) writeFileSync(join(stateDir(fleet, "plans"), `${id}.json`), JSON.stringify(plan, null, 2));
  return plan;
}

export interface Probed {
  states: Record<string, string>;
  /** sha256 of the raw probe output (trailing newlines stripped, as bash's $(…) does). */
  hash: string;
}

export const probeHash = (raw: string) => new Bun.CryptoHasher("sha256").update(raw.replace(/\n+$/, "")).digest("hex");

export async function probe(fleet: Fleet, server: Server, resources: Resource[]): Promise<Probed> {
  const out = await runnerFor(fleet, server).run(probeScript(resources), { timeoutMs: 300_000 });
  return { states: parseProbe(out.stdout, resources), hash: probeHash(out.stdout) };
}

/**
 * Whether this fleet repo ever planned the whole server (provision, or plan without --module/--site):
 * before that, the next step for it is `fornax server provision`, not plan + apply.
 */
export function everPlannedWhole(fleet: Fleet, server: string): boolean {
  const dir = join(fleet.dir, ".fornax", "plans");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => {
    try {
      const p = JSON.parse(readFileSync(join(dir, f), "utf8")) as Plan;
      return p.server === server && !p.scope.modules.length && !p.scope.sites.length;
    } catch {
      return false;
    }
  });
}

export function loadPlan(fleet: Fleet, id: string): Plan {
  const path = join(fleet.dir, ".fornax", "plans", `${id}.json`);
  if (!existsSync(path)) fail("unknown_plan", `no plan "${id}" in this fleet`, "plans are created by `fornax plan <server>`", "fornax plan <server>");
  return JSON.parse(readFileSync(path, "utf8")) as Plan;
}

function inWindow(window: string, now = new Date()): boolean {
  const [a, b] = window.split("-").map((t) => {
    const [h, m] = t.split(":").map(Number);
    return h! * 60 + m!;
  });
  const n = now.getUTCHours() * 60 + now.getUTCMinutes();
  return a! <= b! ? n >= a! && n < b! : n >= a! || n < b!;
}

export function checkWindow(fleet: Fleet, force: boolean): void {
  const w = fleet.config.policies.maintenance_window;
  if (w && !force && !inWindow(w)) {
    fail("outside_maintenance_window", `this fleet only allows server changes between ${w} UTC (app deploys are not restricted)`, "wait for the window, or pass --outside-window if the human explicitly agreed");
  }
}

export interface ApplyOutcome {
  plan: string;
  server: string;
  applied: number;
  log: string;
  handlers: string[];
  steps: string[];
}

export async function applyPlan(fleet: Fleet, server: Server, plan: Plan, o: { confirm?: string; log: (l: string) => void; verbose: boolean }): Promise<ApplyOutcome> {
  if (!plan.changes.length) fail("nothing_to_apply", "this plan has no changes");
  const ageH = (Date.now() - Date.parse(plan.created)) / 3_600_000;
  if (ageH > PLAN_TTL_HOURS) fail("plan_expired", `plan ${plan.id} is ${Math.round(ageH)}h old`, undefined, `fornax plan ${plan.server}`);
  if (plan.destructive) {
    for (const c of plan.changes.filter((x) => x.destructive)) {
      const name = c.owner.replace(/^site:/, "");
      if (isProtected(fleet, name)) fail("protected", `"${name}" is protected by policy and cannot be deleted`, "remove it from policies.protected in fornax.yaml first");
    }
    if (o.confirm !== plan.server) {
      throw new FornaxError("confirmation_required", `plan ${plan.id} deletes things on ${plan.server} — repeat with --confirm=${plan.server}`, plan.changes.filter((c) => c.destructive).map((c) => c.summary).join("; "));
    }
  }
  const runner = runnerFor(fleet, server);
  for (const u of plan.uploads ?? []) {
    const local = Bun.file(u.local);
    if (!(await local.exists())) fail("upload_missing", `${u.local} is gone since the plan was made`, undefined, `fornax plan ${plan.server}`);
    const sha = new Bun.CryptoHasher("sha256").update(await local.arrayBuffer()).digest("hex");
    if (sha !== u.sha) fail("plan_stale", `${u.local} changed since plan ${plan.id} was made`, undefined, `fornax plan ${plan.server}`);
    o.log(`  upload ${u.local} → ${u.remote}`);
    await runner.upload(u.local, u.remote, "0755");
  }
  const run = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${plan.id}`;
  // One apply per server at a time, and the drift check happens under the same lock:
  // what runs is exactly what was reviewed, even with several agents or terminals around.
  const exports: string[] = [];
  for (const [name, ref] of Object.entries(plan.secretEnv ?? {})) {
    if (!/^FORNAX_SECRET_[A-Z0-9_]+$/.test(name)) fail("internal_error", `bad secret env name ${name}`);
    // "$(…)" drops trailing newlines; the extra "x" keeps them (a file written from it must match its hash)
    exports.push(`${name}="$(printf %s ${q(b64(await secret(fleet, ref)))} | base64 -d; printf x)"; export ${name}="\${${name}%x}"`);
  }
  const wrapper = `${exports.join("\n")}
set -o pipefail
mkdir -p /var/log/fornax /run/lock && chmod 700 /var/log/fornax
exec 9>/run/lock/fornax-apply.lock
if ! flock -n 9; then echo "@@locked $(cat /run/lock/fornax-apply.owner 2>/dev/null)"; exit 75; fi
echo "plan ${plan.id} since $(date -u +%FT%TZ)" > /run/lock/fornax-apply.owner
p=$(mktemp); printf %s ${q(b64(plan.probeScript))} | base64 -d > "$p"
o=$(bash "$p" 2>/dev/null); rm -f "$p"
if [ "$(printf %s "$o" | sha256sum | cut -c1-64)" != ${q(plan.probeHash)} ]; then echo "@@stale"; printf '%s\\n' "$o"; exit 76; fi
${etcCommitOutside(`fornax run ${run}`)}
f=/var/log/fornax/${run}.sh
printf %s ${q(b64(plan.script))} | base64 -d > "$f"; chmod 700 "$f"
FORNAX_RUN=${q(run)} bash "$f" 2>&1 | tee /var/log/fornax/${run}.log; rc=$?
${etcCommit(
  fornaxMessage(`${plan.changes.length} change(s) by plan ${plan.id}`, {
    run,
    fleet: fleetRevision(fleet.dir),
    by: actor(),
    version: `fornax ${VERSION}${BUILD ? ` (${BUILD})` : ""}`,
    log: `/var/log/fornax/${run}.log`,
  }),
)}
exit $rc
`;
  const steps: string[] = [];
  const handlers: string[] = [];
  const out = await runner.run(wrapper, {
    allowFail: true,
    timeoutMs: 3_600_000,
    onStdout: (l) => {
      if (l.startsWith("@@step ")) {
        steps.push(l.slice(7));
        o.log(`  ${l.slice(7)}`);
      } else if (l.startsWith("@@handler ")) {
        handlers.push(l.slice(10));
        o.log(`  reload ${l.slice(10)}`);
      } else if (l.startsWith("@@validate_failed ")) o.log(`  ✗ validation failed for ${l.slice(18)} — restored previous files`);
      else if (o.verbose && !l.startsWith("@@")) o.log(`    ${l}`);
    },
  });
  const logPath = `/var/log/fornax/${run}.log`;
  if (out.code === 75) {
    const holder = out.stdout.match(/@@locked (.*)/)?.[1]?.trim();
    fail("apply_locked", `another apply is running on ${plan.server}${holder ? ` (${holder})` : ""}`, "wait for it to finish, then plan again — the server will have changed", `fornax plan ${plan.server}`);
  }
  if (out.code === 76) {
    const now = parseProbeIds(out.stdout.slice(out.stdout.indexOf("@@stale") + 7), Object.keys(plan.states));
    const drifted = Object.keys(plan.states).filter((id) => now[id] !== plan.states[id]);
    fail("plan_stale", `the server changed since plan ${plan.id} was made (${drifted.slice(0, 5).join(", ") || "probe output differs"}${drifted.length > 5 ? ", …" : ""})`, undefined, `fornax plan ${plan.server}`);
  }
  if (out.code !== 0 || !out.stdout.includes("@@done")) {
    const failedStep = steps[steps.length - 1];
    const validate = out.stdout.match(/@@validate_failed (\S+)/);
    throw new FornaxError(
      validate ? "validation_failed" : "apply_failed",
      validate ? `${validate[1]} rejected the new configuration; the previous files were restored` : `apply failed at step ${failedStep ?? "?"}`,
      tail(out.stdout.split("\n").filter((l) => !l.startsWith("@@")).join("\n"), 20),
      `fornax plan ${plan.server}`,
      { log: logPath, step: failedStep, exit: out.code },
    );
  }
  return { plan: plan.id, server: plan.server, applied: steps.length, log: logPath, handlers, steps };
}

function parseProbeIds(out: string, ids: string[]): Record<string, string> {
  return parseProbe(out, ids.map((id) => ({ id }) as Resource));
}

/** Unified diff of file contents for changed file resources (sensitive ones are skipped). */
export async function contentDiffs(fleet: Fleet, server: Server, resources: Resource[], changes: Change[]): Promise<Record<string, string>> {
  const files = changes
    .filter((c) => c.kind === "file")
    .map((c) => resources.find((r) => r.id === c.id)!)
    .filter((r) => !r.sensitive && r.path);
  if (!files.length) return {};
  // only a file reached without any symlink on the way: one a site user planted must not show root's files
  const script =
    files.map((r, i) => `printf '\\n@@${i}\\n'; [ -f ${q(r.path!)} ] && [ "$(realpath -e ${q(r.path!)})" = ${q(r.path!)} ] && base64 -w0 ${q(r.path!)}; echo`).join("\n") + "\nprintf '\\n@@end\\n'";
  const out = await runnerFor(fleet, server).run(script);
  const parsed = parseProbe(out.stdout, files);
  const dir = mkdtempSync(join(tmpdir(), "fornax-diff-"));
  const result: Record<string, string> = {};
  for (const r of files) {
    const a = join(dir, "a"),
      b = join(dir, "b");
    writeFileSync(a, Buffer.from(parsed[r.id] ?? "", "base64"));
    writeFileSync(b, r.content ?? "");
    const p = Bun.spawnSync(["diff", "-u", "--label", `${r.path} (server)`, "--label", `${r.path} (fornax)`, a, b]);
    result[r.path!] = p.stdout.toString();
  }
  return result;
}
