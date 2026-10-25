import { defineCommand, type Context, type Input } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { assertPolicies, getServer, loadFleet, sites, type Fleet } from "../core/fleet.ts";
import { applyPlan, checkWindow, contentDiffs, loadPlan, makePlan, probe, type Change, type Plan } from "../core/plan.ts";
import type { Server } from "../core/schema.ts";
import { assertOrder, desired, preflight, type Scope } from "../modules/index.ts";
import { autoSync } from "./secrets.ts";
import { pushCopy } from "../core/fleet-copy.ts";
import { peerHost, runnerFor } from "../core/ssh.ts";
import { syncPeers } from "../core/peers-sync.ts";

const SYMBOL: Record<Change["action"], string> = { create: "+", update: "~", delete: "-", install: "+", run: "!" };

export function renderChanges(plan: Pick<Plan, "changes" | "unchanged">): string {
  if (!plan.changes.length) return `in sync — ${plan.unchanged} resources checked, nothing to do`;
  const byOwner = new Map<string, Change[]>();
  for (const c of plan.changes) byOwner.set(c.owner, [...(byOwner.get(c.owner) ?? []), c]);
  const lines: string[] = [];
  for (const [owner, cs] of byOwner) {
    lines.push(`${owner}:`);
    for (const c of cs) lines.push(`  ${SYMBOL[c.action]} ${c.summary}${c.destructive ? "   ⚠ DESTRUCTIVE" : ""}`);
  }
  lines.push("", `${plan.changes.length} to change, ${plan.unchanged} unchanged`);
  return lines.join("\n");
}

const scopeOptions = {
  module: { type: "list" as const, help: "only these server modules (base,access,security,web,php,data)" },
  site: { type: "list" as const, help: "only these sites" },
};

const scopeFrom = (input: Input): Scope => ({ modules: (input.module as string[]) ?? [], sites: (input.site as string[]) ?? [] });

async function buildPlan(fleet: Fleet, server: Server, scope: Scope, ctx: Context): Promise<{ plan: Plan; resources: ReturnType<typeof desired> }> {
  assertPolicies(fleet, server);
  ctx.log(`probing ${server.server} …`);
  const facts = await preflight(fleet, server);
  assertOrder(server, facts, scope);
  const resources = desired(fleet, server, facts, scope);
  const probed = await probe(fleet, server, resources);
  const plan = makePlan(fleet, server, resources, probed, scope);
  return { plan, resources };
}

function planData(plan: Plan) {
  return {
    plan: plan.changes.length ? plan.id : null,
    server: plan.server,
    in_sync: plan.changes.length === 0,
    destructive: plan.destructive,
    changes: plan.changes.map(({ current, ...c }) => ({ ...c, current: current.length > 120 ? current.slice(0, 117) + "…" : current })),
    unchanged: plan.unchanged,
    next: plan.changes.length ? `fornax apply ${plan.id}${plan.destructive ? ` --confirm=${plan.server}` : ""}` : null,
  };
}

defineCommand({
  name: "plan",
  summary: "compare the fleet config with a server and save what would change as a plan",
  tier: "read",
  args: [{ name: "server", help: "server name", required: true }],
  options: scopeOptions,
  examples: ["fornax plan web-1", "fornax plan web-1 --site shop.example.com", "fornax plan web-1 --module web,php"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    const { plan } = await buildPlan(fleet, server, scopeFrom(input), ctx);
    const data = planData(plan);
    const human = renderChanges(plan) + (data.next ? `\n\nplan ${plan.id} saved — review, then: ${data.next}` : "");
    return { data, human };
  },
});

defineCommand({
  name: "diff",
  summary: "show drift between the fleet config and a server, including file contents",
  tier: "read",
  args: [{ name: "server", help: "server name", required: true }],
  options: { ...scopeOptions, "no-content": { type: "boolean", help: "only list changes, no file diffs" } },
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    const { plan, resources } = await buildPlan(fleet, server, scopeFrom(input), ctx);
    const diffs = input.noContent ? {} : await contentDiffs(fleet, server, resources, plan.changes);
    const data = { ...planData(plan), diffs };
    const human = [renderChanges(plan), ...Object.values(diffs).filter(Boolean)].join("\n\n");
    // like diff(1): differences are a result that is not ok — plan exits 0, its result is a plan to review
    return { data, human, exitCode: plan.changes.length ? 1 : 0 };
  },
});

async function runApply(fleet: Fleet, server: Server, plan: Plan, input: Input, ctx: Context) {
  checkWindow(fleet, Boolean(input.outsideWindow));
  ctx.log(`applying plan ${plan.id} to ${server.server} (${plan.changes.length} changes)`);
  const out = await applyPlan(fleet, server, plan, { confirm: input.confirm as string | undefined, log: ctx.log, verbose: ctx.verbose });
  return out;
}

/** New secrets (DB passwords, restic …) go to 1Password right after they were created. */
async function afterApply(fleet: Fleet, server: Server, applied: unknown, ctx: Context) {
  const synced = await autoSync(fleet, server, applied);
  if (synced?.written.length) ctx.log(`  1Password: wrote ${synced.written.join(", ")} to ${synced.vault}/${synced.item}`);
  // peers: every server gets the newest signed fleet repo — a failure here never fails the apply either
  if (fleet.config.peers?.enabled) {
    try {
      const r = await syncPeers(fleet, { push: true, log: () => {} });
      const off = r.peers.filter((p) => p.state === "refused" || p.state === "unreachable" || p.state === "not_set_up" || p.pushed === false);
      ctx.log(`  peers: fleet repo ${r.head.slice(0, 12)} on ${r.peers.length - off.length}/${r.peers.length} servers${off.length ? ` — not on ${off.map((p) => `${p.server} (${p.reason ?? p.state})`).join(", ")}` : ""}`);
    } catch (e) {
      ctx.log(`  warning: fleet repo not passed on to the peers: ${(e as Error).message} — fornax peers sync`);
    }
  }
  // the fleet repo goes along, encrypted — a failure here never fails the apply that already happened
  // (not from a peer host: the copy is signed with the fleet key, which a host never has)
  if (fleet.config.fleet_copy && !peerHost()) {
    try {
      const m = await pushCopy(fleet, server);
      ctx.log(`  fleet copy: stored on ${server.server} (${m.commit ? m.commit.slice(0, 12) : "no commit"}${m.dirty ? " + uncommitted" : ""})`);
    } catch (e) {
      ctx.log(`  warning: fleet copy not stored on ${server.server}: ${(e as Error).message} — fornax fleet push ${server.server}`);
    }
  }
  return synced;
}

export const applyOptions = {
  confirm: { type: "string" as const, help: "required when the plan deletes something: the server name" },
  "outside-window": { type: "boolean" as const, help: "allow changes outside policies.maintenance_window" },
};

defineCommand({
  name: "apply",
  summary: "apply a saved plan — refuses if the server changed since the plan was made",
  tier: "write",
  args: [{ name: "plan", help: "plan id from `fornax plan`", required: true }],
  options: applyOptions,
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const plan = loadPlan(fleet, String(input.plan));
    const server = getServer(fleet, plan.server);
    const out = await runApply(fleet, server, plan, input, ctx);
    const secrets = await afterApply(fleet, server, out, ctx);
    return {
      data: { ...out, secrets_synced: secrets, next: `fornax plan ${plan.server}` },
      human: `applied ${out.applied} changes to ${out.server}${out.handlers.length ? ` (reloaded ${[...new Set(out.handlers)].join(", ")})` : ""}\nlog on server: ${out.log}\nverify: fornax plan ${plan.server}  (should be in sync)`,
    };
  },
});

/**
 * Plan and apply until the server is in sync. Some state only appears after earlier changes (a
 * package drops in its default config), so a fresh server converges in up to three rounds.
 */
export async function converge(fleet: Fleet, server: Server, scope: Scope, input: Input, ctx: Context) {
  const rounds: Awaited<ReturnType<typeof runApply>>[] = [];
  let current = (await buildPlan(fleet, server, scope, ctx)).plan;
  for (let round = 1; round <= 3 && current.changes.length; round++) {
    ctx.log(renderChanges(current));
    rounds.push(await runApply(fleet, server, current, input, ctx));
    current = (await buildPlan(fleet, server, scope, ctx)).plan;
  }
  const applied = rounds.reduce((n, r) => n + r.applied, 0);
  const inSync = current.changes.length === 0;
  const secrets = rounds.length ? await afterApply(fleet, server, { rounds: rounds.length, applied }, ctx) : null;
  return { server: server.server, rounds: rounds.length, applied, in_sync: inSync, logs: rounds.map((r) => r.log), remaining: inSync ? [] : planData(current).changes, secrets_synced: secrets };
}

/**
 * Install the pending security updates now (the origins unattended-upgrades is configured for), so
 * a new server does not go live with months of them waiting for the next nightly run. Returns
 * whether a reboot is required.
 */
export async function securityUpdates(fleet: Fleet, server: Server, ctx: Context): Promise<{ installed: number; reboot: boolean }> {
  ctx.log(`installing security updates on ${server.server} …`);
  const out = await runnerFor(fleet, server).run(`export DEBIAN_FRONTEND=noninteractive
before=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst.*-security' || true)
apt-get -o DPkg::Lock::Timeout=900 update -qq
unattended-upgrade -o DPkg::Lock::Timeout=900 >/dev/null 2>&1 || unattended-upgrade
after=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst.*-security' || true)
echo "installed=$((before - after))"
[ -f /var/run/reboot-required ] && echo reboot=yes || echo reboot=no`);
  return { installed: Number(out.stdout.match(/installed=(-?\d+)/)?.[1] ?? 0), reboot: /reboot=yes/.test(out.stdout) };
}

function oneShot(name: string, summary: string, modules: (s: Server) => Scope, extra: string | ((fleet: Fleet, s: Server) => string) = "", updates = false, note?: (fleet: Fleet, s: Server) => string) {
  defineCommand({
    name,
    summary,
    tier: "write",
    args: [{ name: "server", help: "server name", required: true }],
    options: { ...applyOptions, "dry-run": { type: "boolean", help: "only show the plan" } },
    examples: [`fornax ${name} web-1 --dry-run`, `fornax ${name} web-1`],
    async run(input, ctx) {
      const fleet = loadFleet(ctx);
      const server = getServer(fleet, String(input.server));
      const scope = modules(server);
      if (input.dryRun) {
        const { plan } = await buildPlan(fleet, server, scope, ctx);
        return { data: planData(plan), human: renderChanges(plan) + (note ? note(fleet, server) : "") };
      }
      const r = await converge(fleet, server, scope, input, ctx);
      // first contact: the security updates the provider's image lacks, before anything goes live (no reboot here: the server may already be serving)
      const upd = updates && server.modules.includes("base") ? await securityUpdates(fleet, server, ctx) : null;
      const updLine = upd ? `\nsecurity updates: ${upd.installed} installed${upd.reboot ? " — a reboot is needed (unattended-upgrades reboots at auto_reboot, or reboot now)" : ""}` : "";
      return {
        data: { ...r, ...(upd ? { security_updates: upd } : {}) },
        human: `${name.split(" ")[1]} done: ${r.applied} changes in ${r.rounds} round(s) on ${server.server}${r.in_sync ? ", now in sync" : `, ${r.remaining.length} still differ — fornax plan ${server.server}`}${updLine}${r.logs.length ? `\nlogs on server: ${r.logs.join(", ")}` : ""}${note ? note(fleet, server) : ""}${typeof extra === "function" ? extra(fleet, server) : extra}`,
        exitCode: r.in_sync ? 0 : 1,
      };
    },
  });
}

oneShot(
  "server bootstrap",
  "first contact with a fresh server: base packages, admin user, SSH hardening (keys only — you keep logging in as before), firewall, then the pending security updates",
  (s) => {
    const modules = s.modules.filter((m) => m === "base" || m === "access");
    if (!modules.length) fail("nothing_to_bootstrap", `${s.server} manages neither base nor access (modules: [${s.modules.join(", ")}])`, "adopted servers skip bootstrap", `fornax plan ${s.server}`);
    return { modules, sites: [] };
  },
  "\nnext: fornax server provision <server>",
  true,
  // the step where people fear to lock themselves out: say what logging in looks like afterwards
  (fleet, s) => {
    const user = s.ssh?.user ?? fleet.config.ssh.user;
    const from = s.firewall?.ssh_from ?? [];
    return `\nlogin afterwards: as before — ${user} with the same key (sshd: passwords off, PermitRootLogin prohibit-password); the firewall keeps SSH (port ${s.ssh?.port ?? fleet.config.ssh.port}) open${fleet.config.access === "tailscale" ? " on the tailnet" : from.length ? ` from ${from.join(", ")}` : ""}`;
  },
);

oneShot("server provision", "first setup: install and configure everything the config describes (all modules and sites) — plan and apply in one step (--dry-run shows the plan); later changes go through fornax plan + apply", () => ({ modules: [], sites: [] }), (fleet, server) => {
  // the code is not there yet: a provisioned site serves nothing until its first deploy
  const deploying = sites(fleet, server).filter((s) => s.spec.state === "present" && s.spec.deploy.enabled && s.spec.repo);
  return deploying.length ? `\nnext: ${deploying.map((s) => `fornax deploy ${s.domain}`).join(", ")}   (first deploy of each site; afterwards every push, after fornax git connect)` : "";
});
