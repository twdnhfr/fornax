/**
 * The tailnet policy as the fleet wants it (`fornax tailnet sync`). Three kinds of machines:
 *
 * - your own devices (autogroup:member): reach everything, SSH to everything — as before;
 * - machines at home (tag:home, `tailscale.home`): reach everything, SSH to the servers;
 * - internet-facing servers (tag:server): reach the tailnet's DNS servers and what
 *   `tailscale.allow` lists — nothing else, and SSH nowhere. A compromised app on a server stays
 *   on that server.
 *
 * fornax writes `acls`, `ssh`, `hosts` and its tags in `tagOwners`; everything else in the policy
 * (nodeAttrs, autoApprovers, grants of your own …) is kept as it is.
 */

export interface AllowRule {
  from: string;
  to: string;
  ports: number[];
  why: string;
}

export interface PolicyInput {
  current: Record<string, unknown>;
  serverTag: string;
  homeTag: string;
  home: string[];
  allow: AllowRule[];
  /** Machine name (first label of its MagicDNS name) → its tailnet IPv4. */
  machines: Map<string, string>;
  /** The tailnet's DNS servers (only addresses inside the tailnet need a rule). */
  nameservers: string[];
  /**
   * Your devices SSH to servers and home machines only after a fresh Tailscale login within this
   * period ("12h", "1h", "always"); "off": without. Someone at your unlocked laptop then still
   * needs your Tailscale login (with its second factor) — the home machines (agents) are not asked.
   */
  sshCheck?: string;
}

const TAILNET = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/;
const BOTH = ["autogroup:nonroot", "root"];

/** A machine name or tag as an ACL target; machine names become `hosts` entries. */
function target(name: string, machines: Map<string, string>, hosts: Record<string, string>): string {
  if (name.startsWith("tag:") || name.startsWith("autogroup:")) return name;
  const ip = machines.get(name);
  if (!ip) throw new Error(`no machine "${name}" in the tailnet`);
  hosts[name] = ip;
  return name;
}

export function desiredPolicy(i: PolicyInput): Record<string, unknown> {
  const hosts: Record<string, string> = {};
  const home = i.home.length > 0;
  const dns = i.nameservers.filter((ns) => TAILNET.test(ns)).map((ns) => `${ns}:53`);
  const acls: unknown[] = [
    { action: "accept", src: ["autogroup:member"], dst: ["*:*"] },
    ...(home ? [{ action: "accept", src: [i.homeTag], dst: ["*:*"] }] : []),
    ...(dns.length ? [{ action: "accept", src: [i.serverTag], dst: dns }] : []),
    ...i.allow.map((a) => ({ action: "accept", src: [target(a.from, i.machines, hosts)], dst: [`${target(a.to, i.machines, hosts)}:${a.ports.join(",")}`] })),
  ];
  // into servers and home machines (which reach the servers in turn) your devices need a fresh login
  const toMachines = i.sshCheck && i.sshCheck !== "off" ? { action: "check", checkPeriod: i.sshCheck } : { action: "accept" };
  const ssh: unknown[] = [
    { action: "accept", src: ["autogroup:member"], dst: ["autogroup:self"], users: BOTH },
    { ...toMachines, src: ["autogroup:member"], dst: [i.serverTag], users: BOTH },
    ...(home ? [{ ...toMachines, src: ["autogroup:member"], dst: [i.homeTag], users: BOTH }, { action: "accept", src: [i.homeTag], dst: [i.serverTag], users: BOTH }] : []),
  ];
  const tagOwners = { ...((i.current.tagOwners as Record<string, string[]>) ?? {}), [i.serverTag]: ["autogroup:admin"], ...(home ? { [i.homeTag]: ["autogroup:admin"] } : {}) };
  const { acls: _a, ssh: _s, hosts: _h, tagOwners: _t, ...rest } = i.current;
  return { tagOwners, ...(Object.keys(hosts).length ? { hosts } : {}), acls, ssh, ...rest };
}

/** The policy file text fornax writes (HuJSON: JSON with a comment saying where it comes from). */
export function policyText(policy: Record<string, unknown>, fleetName: string): string {
  return `// acls, ssh, hosts and the server/home tags are written by \`fornax tailnet sync\` from the fleet "${fleetName}"
// (tailscale: home / allow in fornax.yaml) — change them there; other parts of this file are kept as they are.
${JSON.stringify(policy, null, "\t")}
`;
}

/** HuJSON → value: comments and trailing commas removed, strings left alone. */
export function parseHujson(text: string): Record<string, unknown> {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
}
