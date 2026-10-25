import { defineCommand } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { loadFleet } from "../core/fleet.ts";
import { assertVerified, git, readTrust, signersAt, verifyCommit, writeTrust, type CommitCheck } from "../core/peers.ts";

const short = (c: string) => c.slice(0, 12);

function rev(dir: string, ref: string): string {
  const r = git(dir, "rev-parse", "--verify", `${ref}^{commit}`);
  if (r.code !== 0) fail("unknown_commit", `no commit "${ref}" in ${dir}`, r.stderr.trim());
  return r.stdout.trim();
}

export const renderChecks = (checks: CommitCheck[]) =>
  checks.map((c) => `${c.ok ? "✓" : "✗"} ${short(c.commit)} ${c.subject}${c.ok ? ` — signed by ${c.signer}` : ` — ${c.reason}`}${c.trustChange ? "   ⚠ changes signers or root keys" : ""}`).join("\n");

defineCommand({
  name: "peers trust",
  summary: "pin the commit trust in the fleet repo starts from on this machine (like known_hosts) — review the history up to it first",
  tier: "write",
  args: [{ name: "commit", help: "commit to trust (default: HEAD)" }],
  examples: ["fornax peers trust", "fornax peers trust 4c1e9a2"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const commit = rev(fleet.dir, String(input.commit ?? "HEAD"));
    const signers = signersAt(fleet.dir, commit);
    if (!signers.length) fail("no_signers", `commit ${short(commit)} has no peers.signers in fornax.yaml`, "add peers.signers (your signing keys), commit it signed, then trust that commit");
    // the anchor is trusted because you say so; whether its own signers signed it is shown, not required
    const own = verifyCommit(fleet.dir, commit, signers);
    const before = readTrust(fleet.config.fleet);
    const state = writeTrust(fleet.config.fleet, { anchor: commit, head: commit });
    return {
      data: { fleet: fleet.config.fleet, anchor: state.anchor, signed_by: own.ok ? own.signer : null, replaced: before ?? null, signers: signers.length },
      human: [
        `trust for fleet "${fleet.config.fleet}" starts at ${short(commit)} (${git(fleet.dir, "log", "-1", "--format=%s", commit).stdout.trim()})`,
        own.ok ? `  signed by ${own.signer}` : `  note: this commit is not signed by one of its own signers (${own.reason}) — fine for the anchor, which you vouch for`,
        `  ${signers.length} signer(s) from here on`,
        before ? `  replaces the anchor ${short(before.anchor)} (last verified ${short(before.head)})` : "",
      ].filter(Boolean).join("\n"),
    };
  },
});

defineCommand({
  name: "peers verify",
  summary: "check every commit since the last trusted state against the signers its parent names; advances the trusted state when all hold",
  tier: "read",
  args: [{ name: "rev", help: "commit or branch to check (default: HEAD)" }],
  examples: ["fornax peers verify", "fornax peers verify origin/main"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const trust = readTrust(fleet.config.fleet) ?? fail("no_trust_anchor", `no trusted state for fleet "${fleet.config.fleet}" on this machine`, "review the history, then pin where trust starts", "fornax peers trust");
    const head = rev(fleet.dir, String(input.rev ?? "HEAD"));
    const checks = assertVerified(fleet.dir, trust.head, head);
    if (checks.length) writeTrust(fleet.config.fleet, { anchor: trust.anchor, head });
    const dirty = git(fleet.dir, "status", "--porcelain").stdout.trim() !== "";
    return {
      data: { fleet: fleet.config.fleet, trusted: head, checked: checks, uncommitted_changes: dirty },
      human: [
        checks.length ? renderChecks(checks) : `nothing new since ${short(trust.head)}`,
        `trusted: ${short(head)}`,
        dirty ? "note: uncommitted changes in the working tree are neither checked nor passed on to peers — commit them (signed)" : "",
      ].filter(Boolean).join("\n"),
    };
  },
});
