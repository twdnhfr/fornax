import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { defineCommand } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { loadFleet, stateDir, type Fleet } from "../core/fleet.ts";
import { tailscaleApi } from "../core/tailscale.ts";
import { desiredPolicy, parseHujson, policyText } from "../core/tailnet-policy.ts";

const HOME_TAG = "tag:home";
const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/;

/** What `tailnet sync` would change: the policy (as a diff) and the tags of machines. */
export async function tailnetPlan(fleet: Fleet) {
  const cfg = fleet.config.tailscale;
  const ts = await tailscaleApi(fleet);
  if (!ts || !cfg) fail("no_tailscale_api", "fornax manages the tailnet policy through the Tailscale API, and this fleet has no tailscale.api_token", "put an API access token into the fleet's vault and set tailscale: { api_token: op://… }");
  const [text, devices, nameservers] = await Promise.all([ts!.policy(), ts!.devices(), ts!.nameservers()]);
  const machines = new Map(devices.map((d) => [d.name.split(".")[0]!, d.addresses.find((a) => TAILNET_V4.test(a)) ?? d.addresses[0]!]));
  const serverTag = cfg!.tag || "tag:server";
  const current = parseHujson(text);
  let desired: Record<string, unknown>;
  try {
    desired = desiredPolicy({ current, serverTag, homeTag: HOME_TAG, home: cfg!.home, allow: cfg!.allow, machines, nameservers, sshCheck: cfg!.ssh_check });
  } catch (e) {
    return fail("config_invalid", `tailscale.allow / home: ${(e as Error).message}`, `machines in the tailnet: ${[...machines.keys()].join(", ")}`);
  }
  // the fleet's servers carry the server tag, the machines at home the home tag
  const wanted = new Map<string, string>();
  if (fleet.config.access === "tailscale") for (const s of fleet.servers.values()) wanted.set(s.host.split(".")[0]!, serverTag);
  for (const h of cfg!.home) wanted.set(h, HOME_TAG);
  const tags = [...wanted].flatMap(([name, tag]): Array<{ machine: string; id: string | null; from: string[]; to: string[]; missing: boolean }> => {
    const d = devices.find((x) => x.name.split(".")[0] === name);
    if (!d) return [{ machine: name, id: null, from: [] as string[], to: [tag], missing: true }];
    const now = d.tags ?? [];
    return now.length === 1 && now[0] === tag ? [] : [{ machine: name, id: d.id, from: now, to: [tag], missing: false }];
  });
  return { ts: ts!, text, current, desired, changed: !isDeepStrictEqual(current, desired), tags };
}

/** Unified diff of two policies (as formatted JSON). */
function policyDiff(a: unknown, b: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "fornax-tailnet-"));
  try {
    writeFileSync(join(dir, "a"), JSON.stringify(a, null, 2) + "\n");
    writeFileSync(join(dir, "b"), JSON.stringify(b, null, 2) + "\n");
    return Bun.spawnSync(["diff", "-u", "--label", "tailnet policy (now)", "--label", "tailnet policy (fornax)", join(dir, "a"), join(dir, "b")]).stdout.toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tagLine = (t: { machine: string; from: string[]; to: string[]; missing: boolean }) =>
  t.missing ? `! ${t.machine}: not in the tailnet (cannot tag it ${t.to.join(",")})` : `~ ${t.machine}: ${t.from.join(",") || "untagged"} → ${t.to.join(",")}`;

defineCommand({
  name: "tailnet status",
  summary: "how the tailnet policy and the machines' tags differ from what the fleet wants (servers: DNS and tailscale.allow only; home machines: everything)",
  tier: "read",
  examples: ["fornax tailnet status", "fornax tailnet status --json"],
  async run(_input, ctx) {
    const fleet = loadFleet(ctx);
    const p = await tailnetPlan(fleet);
    const inSync = !p.changed && !p.tags.length;
    return {
      data: { in_sync: inSync, policy_changed: p.changed, tags: p.tags, diff: p.changed ? policyDiff(p.current, p.desired) : "" },
      human: inSync ? "tailnet in sync with the fleet" : [p.changed ? policyDiff(p.current, p.desired) : "policy: in sync", ...p.tags.map(tagLine), "next: fornax tailnet sync"].join("\n"),
      exitCode: inSync ? 0 : 1,
    };
  },
});

defineCommand({
  name: "tailnet sync",
  summary: "write the tailnet policy (acls, ssh, hosts, tags) and tag the fleet's servers and home machines — the previous policy is kept in .fornax/tailnet/",
  tier: "write",
  examples: ["fornax tailnet status   # first: what would change", "fornax tailnet sync"],
  async run(_input, ctx) {
    const fleet = loadFleet(ctx);
    const p = await tailnetPlan(fleet);
    const done: string[] = [];
    if (p.changed) {
      const text = policyText(p.desired, fleet.config.fleet);
      await p.ts.validatePolicy(text);
      const backup = join(stateDir(fleet, "tailnet"), `policy-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}.hujson`);
      writeFileSync(backup, p.text);
      await p.ts.setPolicy(text);
      done.push(`policy written (the previous one: ${backup})`);
    }
    for (const t of p.tags.filter((x) => !x.missing)) {
      await p.ts.setTags(t.id!, t.to);
      done.push(`${t.machine}: tagged ${t.to.join(",")}`);
    }
    const missing = p.tags.filter((x) => x.missing).map(tagLine);
    return {
      data: { done, missing },
      human: [...(done.length ? done.map((d) => `✓ ${d}`) : ["tailnet in sync with the fleet"]), ...missing].join("\n"),
    };
  },
});
