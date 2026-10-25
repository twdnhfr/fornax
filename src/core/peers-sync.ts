/**
 * Moving the fleet repo between this machine and the peers (docs/peers.md): fetch every peer's
 * head, take the newest one that is a fast-forward of all the others — after checking every new
 * commit's signature (peers.ts) — and push it to the peers that are behind. Two peers that went
 * different ways stop it (fleet_diverged): fornax never merges.
 */
import { fail } from "./errors.ts";
import type { Fleet } from "./fleet.ts";
import { assertVerified, git, isAncestor, needTrust, writeTrust, type CommitCheck } from "./peers.ts";
import { q } from "./shell.ts";
import { fleetAgent } from "./ssh-agent.ts";
import { sshEnv, sshHost, sshOptions, sshSettings } from "./ssh.ts";
import type { Server } from "./schema.ts";
import { PEER_DIR } from "../modules/peers.ts";

export type PeerState = "same" | "behind" | "ahead" | "missing" | "not_set_up" | "unreachable" | "refused";

export interface PeerStatus {
  server: string;
  head: string | null;
  state: PeerState;
  /** Why a peer was refused or could not be read. */
  reason?: string;
  /** After a sync: whether this peer got the newest head. */
  pushed?: boolean;
}

/** git's environment and URL for a server: ssh with fornax's options, as root into PEER_DIR. */
async function remote(fleet: Fleet, server: Server): Promise<{ url: string; env: Record<string, string | undefined> }> {
  const { user, port } = sshSettings(fleet, server);
  if (user !== "root") fail("config_invalid", `${server.server}: peers need ssh as root (ssh.user is ${user})`, "the fleet repo on a server is root's");
  const host = sshHost(server);
  const opts = sshOptions(fleet, server, await fleetAgent(fleet));
  const env = { ...(sshEnv(fleet) ?? process.env), GIT_SSH_COMMAND: ["ssh", ...opts].map(q).join(" "), GIT_TERMINAL_PROMPT: "0" };
  return { url: `ssh://${user}@${host.includes(":") ? `[${host}]` : host}:${port}${PEER_DIR}`, env };
}

const peerRef = (server: string) => `refs/fornax-peers/${server}`;

/** Fetch a peer's head into refs/fornax-peers/<server>. */
export async function fetchPeer(fleet: Fleet, server: Server): Promise<{ head: string | null; state?: PeerState; reason?: string }> {
  const { url, env } = await remote(fleet, server);
  const p = Bun.spawnSync(["git", "-C", fleet.dir, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", url, `+refs/heads/main:${peerRef(server.server)}`], { env, stdout: "pipe", stderr: "pipe" });
  const err = p.stderr.toString().trim();
  if (p.exitCode !== 0) {
    if (/couldn't find remote ref/i.test(err)) return { head: null, state: "missing" };
    if (/does not appear to be a git repository|No such file or directory/i.test(err)) return { head: null, state: "not_set_up", reason: `no fleet repo at ${PEER_DIR} yet — plan + apply sets it up` };
    return { head: null, state: "unreachable", reason: err.split("\n").pop() };
  }
  return { head: git(fleet.dir, "rev-parse", peerRef(server.server)).stdout.trim() };
}

/** Push a commit to a peer's main (a fast-forward; the peer's hook checks the signatures again). */
export async function pushPeer(fleet: Fleet, server: Server, commit: string): Promise<void> {
  const { url, env } = await remote(fleet, server);
  const p = Bun.spawnSync(["git", "-C", fleet.dir, "push", "--quiet", url, `${commit}:refs/heads/main`], { env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) fail("peer_push_failed", `pushing the fleet repo to ${server.server} failed`, p.stderr.toString().trim().split("\n").slice(-3).join(" "));
}

export interface SyncResult {
  head: string;
  peers: PeerStatus[];
  /** Commits that were new to this machine, as checked. */
  checked: CommitCheck[];
  /** This machine's repo moved forward to `head`. */
  fastForwarded: boolean;
  /** Commits from a server signed with a login key (a host could have had them signed): not taken over without review (--accept). */
  pendingReview: CommitCheck[];
}

/**
 * Bring this machine and the peers to the newest signed head. `push: false` only looks (and still
 * fast-forwards nothing): what `fornax peers status` shows.
 */
export async function syncPeers(fleet: Fleet, o: { push: boolean; acceptReview?: boolean; servers?: Server[]; log: (l: string) => void }): Promise<SyncResult> {
  const name = fleet.config.fleet;
  const trust = needTrust(name);
  const dir = fleet.dir;
  const local = git(dir, "rev-parse", "HEAD").stdout.trim();
  if (!local) fail("git_failed", `${dir} has no commit yet`);
  const servers = o.servers ?? [...fleet.servers.values()];
  if (git(dir, "cat-file", "-e", `${trust.head}^{commit}`).code !== 0) fail("fleet_rollback", `the trusted commit ${trust.head.slice(0, 12)} is not in ${dir}`, "a repo that lost history, or another repo than the one trusted — check `fornax peers trust`");

  // every candidate either descends from the trusted state (then each new commit must hold) or lies behind it
  const accept = (head: string, where: string): { ok: true; checks: CommitCheck[] } | { ok: false; reason: string } => {
    if (isAncestor(dir, head, trust.head)) return { ok: true, checks: [] };
    try {
      return { ok: true, checks: assertVerified(dir, trust.head, head, where) };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  };

  const localOk = accept(local, "this machine's fleet repo");
  if (!localOk.ok) return fail("unsigned_fleet", localOk.reason, "commit only signed changes to the fleet repo (git commit -S with a key in peers.signers)", "fornax peers verify");

  const peers: PeerStatus[] = [];
  const heads = new Map<string, string>([["(this machine)", local]]);
  for (const server of servers) {
    o.log(`  ${server.server}: fetching the fleet repo …`);
    const f = await fetchPeer(fleet, server);
    if (!f.head) {
      peers.push({ server: server.server, head: null, state: f.state!, ...(f.reason ? { reason: f.reason } : {}) });
      continue;
    }
    const a = accept(f.head, `the fleet repo on ${server.server}`);
    if (!a.ok) {
      peers.push({ server: server.server, head: f.head, state: "refused", reason: a.reason });
      continue;
    }
    heads.set(server.server, f.head);
    peers.push({ server: server.server, head: f.head, state: "same" });
  }

  // the newest: the one head every other is an ancestor of
  const all = [...heads.entries()];
  const newest = all.find(([, h]) => all.every(([, other]) => isAncestor(dir, other, h)));
  if (!newest) {
    const list = all.map(([w, h]) => `${w} ${h.slice(0, 12)}`).join(", ");
    fail("fleet_diverged", `the fleet repo went different ways: ${list}`, "no head is a fast-forward of all others — bring them together by hand (one signed history), fornax never merges", "fornax peers status");
  }
  const head = newest![1];
  // the commits new to this machine (head was accepted above; local is an ancestor of it)
  const from = isAncestor(dir, trust.head, local) ? local : trust.head;
  const checks = isAncestor(dir, head, trust.head) ? [] : assertVerified(dir, from, head);
  // a commit from a server signed with a key that logs in as root is never taken over on its own: a
  // host you ran something on could have had your forwarded key sign it — and any change to the fleet
  // becomes root on some server at the next apply. Commits you sign on your own machine pass.
  const pendingReview = checks.filter((c) => c.viaLoginKey);
  if (pendingReview.length && o.push && !o.acceptReview) {
    fail(
      "review_pending",
      `${pendingReview.length} commit(s) from a server were signed with a login key and wait for your review: ${pendingReview.map((c) => `${c.commit.slice(0, 12)} "${c.subject}"${c.trustChange ? " (changes signers, logins, hosts or secret sources)" : ""}`).join("; ")}`,
      `look at them: git -C ${dir} log -p ${local.slice(0, 12)}..${head.slice(0, 12)} — then take them over with --accept`,
      "fornax peers sync --accept",
      { checks },
    );
  }

  // only a sync moves anything: status looks
  let fastForwarded = false;
  if (head !== local && o.push) {
    const ff = git(dir, "merge", "--ff-only", "--quiet", head);
    if (ff.code !== 0) fail("git_failed", `cannot fast-forward ${dir} to ${head.slice(0, 12)}`, `${ff.stderr.trim()} — commit or stash local changes first`);
    fastForwarded = true;
  }
  if (o.push && !isAncestor(dir, head, trust.head)) writeTrust(name, { anchor: trust.anchor, head });

  for (const p of peers) {
    if (p.state === "refused" || p.state === "unreachable" || p.state === "not_set_up") continue;
    p.state = p.head === head ? "same" : p.head === null ? "missing" : "behind";
    if (o.push && p.state !== "same") {
      o.log(`  ${p.server}: pushing ${head.slice(0, 12)} …`);
      try {
        await pushPeer(fleet, servers.find((s) => s.server === p.server)!, head);
        p.pushed = true;
        p.state = "same";
      } catch (e) {
        p.pushed = false;
        p.reason = (e as Error).message;
      }
    }
  }
  return { head, peers, checked: checks, fastForwarded, pendingReview };
}
