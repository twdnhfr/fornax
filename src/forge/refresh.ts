/**
 * `fornax import forge <server> --refresh`: while Forge still runs a server's other sites, it keeps
 * changing their files (a new domain, a scheduler job, a vhost edit in the UI). A plan would then
 * turn those changes back. Refresh takes them over into the fleet repo again:
 *
 *   - sites still fully adopted (no area converted yet) get Forge's current files and settings
 *   - sites with a conversion in progress or done are left alone
 *   - /etc/crontab is taken from the server, minus the jobs fornax already moved to /etc/cron.d
 *   - new Forge sites are added (adopted), sites gone from Forge are only reported
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { editServerFile, type Fleet } from "../core/fleet.ts";
import type { Server, Site } from "../core/schema.ts";
import type { ImportPlan } from "./import.ts";

/** Fields `import forge` derives from Forge; everything else in a site is the user's. */
const FROM_FORGE = ["adopted", "user", "php", "web_dir", "aliases", "tls", "daemons", "pool", "generate", "files", "origin", "notes"] as const;

export interface RefreshResult {
  refreshed: string[];
  added: string[];
  skipped: Array<{ site: string; reason: string }>;
  gone: string[];
  files: string[];
  warnings: string[];
}

/** Still exactly as imported: nothing converted, nothing deployed by fornax. */
function untouched(s: Site): boolean {
  const g = s.generate;
  return s.adopted && !g.vhost && !g.pool && !g.daemons && !g.cron && !g.logrotate && !s.deploy.enabled && s.retire.length === 0 && ["existing", "none", undefined].includes(s.tls.issuer);
}

export function refreshServer(fleet: Fleet, server: Server, plan: ImportPlan): RefreshResult {
  const res: RefreshResult = { refreshed: [], added: [], skipped: [], gone: [], files: [], warnings: [] };
  const fresh = plan.server.sites as Record<string, Record<string, unknown>>;
  const write = (rel: string) => {
    const p = join(fleet.dir, rel);
    const content = plan.files.get(rel)!;
    if (existsSync(p) && readFileSync(p).equals(content)) return;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    res.files.push(rel);
  };
  const sources = (spec: { files?: Array<{ source?: string }> }) => (spec.files ?? []).map((f) => f.source).filter(Boolean) as string[];
  const forgeScript = (domain: string) => `adopted/${server.server}/forge/${domain}.deploy.sh`;

  const updates = new Map<string, Record<string, unknown>>();
  for (const [domain, next] of Object.entries(fresh)) {
    const have = server.sites[domain];
    if (!have) {
      updates.set(domain, next);
      for (const rel of [...sources(next as never), forgeScript(domain)]) if (plan.files.has(rel)) write(rel);
      res.added.push(domain);
      continue;
    }
    if (!untouched(have)) {
      res.skipped.push({ site: domain, reason: have.adopted ? "conversion in progress — finish it with `fornax site convert`" : "converted — fornax manages it" });
      continue;
    }
    const raw = readSite(fleet, server, domain);
    const merged: Record<string, unknown> = { ...raw };
    for (const k of FROM_FORGE) {
      if (k in next) merged[k] = next[k];
      else delete merged[k];
    }
    const before = new Set(sources(raw as never));
    const after = sources(next as never);
    for (const rel of [...after, forgeScript(domain)]) if (plan.files.has(rel)) write(rel);
    for (const rel of before) {
      if (!after.includes(rel) && existsSync(join(fleet.dir, rel))) {
        rmSync(join(fleet.dir, rel));
        res.files.push(`${rel} (removed — Forge no longer has it)`);
      }
    }
    if (JSON.stringify(merged) !== JSON.stringify(raw)) updates.set(domain, merged);
    res.refreshed.push(domain);
  }
  for (const [domain, s] of Object.entries(server.sites)) {
    if (!(domain in fresh) && s.adopted) res.gone.push(domain);
  }

  // /etc/crontab: the server's version, without what fornax already took over
  const crontab = (plan.server.files as Array<{ path: string; source: string }>).find((f) => f.path === "/etc/crontab");
  const mine = server.files.find((f) => f.path === "/etc/crontab" && f.source);
  if (crontab && mine) {
    const lines = plan.files.get(crontab.source)!.toString().split("\n");
    const moved = Object.values(server.sites).filter((s) => s.generate.cron && s.user).map((s) => s.user!);
    const isJob = (l: string) => Boolean(l.trim()) && !l.trim().startsWith("#") && moved.includes(l.trim().split(/\s+/)[5] ?? "");
    let kept = lines.filter((l, i) => !isJob(l) && !(/^# Laravel Forge Scheduler \d+$/.test(l.trim()) && lines[i + 1] !== undefined && isJob(lines[i + 1]!)));
    if (server.forge_detach) kept = kept.filter((l) => !(l.includes("forge-cleanup.sh") && !l.trim().startsWith("#")));
    const p = join(fleet.dir, mine.source!);
    const content = kept.join("\n");
    if (!existsSync(p) || readFileSync(p, "utf8") !== content) {
      writeFileSync(p, content);
      res.files.push(mine.source!);
    }
  }

  if (updates.size) editServerFile(fleet, server.server, (doc) => {
    for (const [domain, spec] of updates) doc.setIn(["sites", domain], doc.createNode(spec));
  });
  if (res.gone.length) res.warnings.push(`no longer in Forge: ${res.gone.join(", ")} — still in the fleet repo; remove them with \`fornax site remove\` once you are sure they are gone from the server`);
  return res;
}

function readSite(fleet: Fleet, server: Server, domain: string): Record<string, unknown> {
  return (YAML.parse(readFileSync(fleet.files.get(server.server)!, "utf8")) as { sites: Record<string, Record<string, unknown>> }).sites[domain]!;
}
