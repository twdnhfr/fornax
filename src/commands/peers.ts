import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { defineCommand } from "../core/command.ts";
import { q } from "../core/shell.ts";
import { closePeerConnections } from "../core/ssh.ts";
import { PEER_DIR } from "../modules/peers.ts";
import { fail } from "../core/errors.ts";
import { getServer, loadFleet } from "../core/fleet.ts";
import { syncPeers, type SyncResult } from "../core/peers-sync.ts";
import { assertVerified, git, readTrust, RUN_DONE, signersAt, verifyCommit, writeTrust, type CommitCheck } from "../core/peers.ts";

const short = (c: string) => c.slice(0, 12);

function rev(dir: string, ref: string): string {
  const r = git(dir, "rev-parse", "--verify", `${ref}^{commit}`);
  if (r.code !== 0) fail("unknown_commit", `no commit "${ref}" in ${dir}`, r.stderr.trim());
  return r.stdout.trim();
}

export const renderChecks = (checks: CommitCheck[]) =>
  checks.map((c) => `${c.ok ? "✓" : "✗"} ${short(c.commit)} ${c.subject}${c.ok ? ` — signed by ${c.signer}${c.viaLoginKey ? " (a login key)" : ""}` : ` — ${c.reason}`}${c.trustChange ? "   ⚠ changes signers, logins, hosts or secret sources" : ""}`).join("\n");

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

const keyBody = (line: string) => line.trim().split(/\s+/).slice(0, 2).join(" ");

defineCommand({
  name: "peers signing-key",
  summary: "for git on a peer host (gpg.ssh.defaultKeyCommand): the forwarded agent's key that is one of the signers",
  tier: "read",
  internal: true,
  async run(_input, ctx) {
    const repo = git(ctx.cwd, "rev-parse", "--show-toplevel").stdout.trim() || ctx.cwd;
    const signers = signersAt(repo, "HEAD").map(keyBody);
    const listed = Bun.spawnSync(["ssh-add", "-L"], { stdout: "pipe", stderr: "pipe" });
    const keys = listed.exitCode === 0 ? listed.stdout.toString().split("\n").filter(Boolean) : [];
    const key = keys.find((k) => signers.includes(keyBody(k)));
    if (!key) fail("not_a_signer", "the forwarded agent holds no key that is one of peers.signers — this commit cannot be signed", keys.length ? "forward an agent with one of your signing keys (fornax --on does)" : "no agent was forwarded (SSH_AUTH_SOCK)");
    return { data: `key::${keyBody(key!)}`, human: `key::${keyBody(key!)}` };
  },
});

defineCommand({
  name: "peers receive",
  summary: "pre-receive hook of the fleet repo on a server: fast-forwards of signed commits only",
  tier: "read",
  internal: true,
  async run(_input, ctx) {
    const zero = /^0+$/;
    const lines = (await new Response(Bun.stdin.stream()).text()).split("\n").filter(Boolean);
    for (const line of lines) {
      const [old, next, ref] = line.split(" ") as [string, string, string];
      if (ref !== "refs/heads/main") fail("peer_push_refused", `only main is kept here, not ${ref}`);
      if (zero.test(next)) fail("peer_push_refused", "the fleet repo's main is never deleted");
      // the first push into an empty repo has nothing to check against: only a client with root here can make it
      if (zero.test(old)) continue;
      const checks = assertVerified(ctx.cwd, old, next, "the pushed fleet repo");
      ctx.log(`fornax: ${checks.length} signed commit(s) accepted`);
    }
    return { data: null };
  },
});

defineCommand({
  name: "peers status",
  summary: "each server's copy of the fleet repo: its head, whether every commit is signed, behind or ahead of this machine",
  tier: "read",
  args: [{ name: "servers", help: "server names (default: all)", variadic: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const names = input.servers as string[];
    const servers = names.length ? names.map((n) => getServer(fleet, n)) : undefined;
    const r = await syncPeers(fleet, { push: false, servers, log: ctx.log });
    return { data: r, human: renderSync(r, false), exitCode: r.peers.some((p) => p.state !== "same") || r.pendingReview.length ? 1 : 0 };
  },
});

defineCommand({
  name: "peers sync",
  summary: "bring this machine and every server to the newest signed state of the fleet repo (fast-forward only; apply does it by itself)",
  tier: "write",
  args: [{ name: "servers", help: "server names (default: all)", variadic: true }],
  options: { accept: { type: "boolean", help: "take over commits from a server that were signed with a login key — after you looked at them (git log -p)" } },
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    if (!fleet.config.peers?.enabled) fail("no_peers", "peers are not enabled in fornax.yaml", "set peers.enabled: true and peers.signers, then plan + apply");
    const names = input.servers as string[];
    const servers = names.length ? names.map((n) => getServer(fleet, n)) : undefined;
    const r = await syncPeers(fleet, { push: true, acceptReview: Boolean(input.accept), servers, log: ctx.log });
    const bad = r.peers.filter((p) => p.state === "refused" || p.state === "unreachable" || p.state === "not_set_up" || p.pushed === false);
    return { data: r, human: renderSync(r, true), exitCode: bad.length ? 1 : 0 };
  },
});

export function renderSync(r: SyncResult, pushed: boolean): string {
  const word: Record<string, string> = { same: "in sync", behind: "behind", missing: "empty", not_set_up: "not set up", unreachable: "unreachable", refused: "REFUSED", ahead: "ahead" };
  return [
    r.checked.length ? renderChecks(r.checked) : "",
    !pushed && r.pendingReview.length ? `⚠ ${r.pendingReview.length} commit(s) from a server were signed with a login key and wait for your review — git log -p, then: fornax peers sync --accept` : "",
    `newest signed state: ${short(r.head)}${r.fastForwarded ? " (this machine moved forward to it)" : ""}`,
    ...r.peers.map((p) => `  ${p.server}: ${p.head ? short(p.head) : "—"} ${word[p.state]}${pushed && p.pushed ? " → updated" : ""}${p.pushed === false ? " → push failed" : ""}${p.reason ? ` (${p.reason})` : ""}`),
  ].filter(Boolean).join("\n");
}

const RUNS = "/var/lib/fornax/runs";

/**
 * Hand a run's output to the client and remove the run once the client confirmed it (it answers the
 * marker with the nonce it sent); without that answer — a dropped connection — the run stays for attach.
 */
async function deliver(r: { out: string; code: number }, run: string, nonce: string, input: { next(): Promise<string | undefined> }, log: (l: string) => void, dropped: () => boolean) {
  process.stdout.write(r.out);
  if (!nonce) return;
  log(`${RUN_DONE} ${nonce}`);
  const ack = await Promise.race([input.next(), Bun.sleep(15_000).then(() => undefined)]);
  if (ack === "ack" && !dropped()) rmSync(run, { recursive: true, force: true });
}

/** stdin line by line, as it arrives (the client keeps it open to confirm the end of a run). */
function stdinLines(): { next(): Promise<string | undefined> } {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = false;
  return {
    async next() {
      for (;;) {
        const i = buf.indexOf("\n");
        if (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          return line;
        }
        if (done) return buf ? ((buf = ""), buf) : undefined;
        const { value, done: d } = await reader.read();
        if (d) done = true;
        else buf += decoder.decode(value, { stream: true });
      }
    },
  };
}

/** The words of a command line up to its first option: what a commit message and a run record keep (no values, no secrets). */
export const commandWords = (argv: string[]) => argv.slice(0, argv.findIndex((a) => a.startsWith("-")) < 0 ? argv.length : argv.findIndex((a) => a.startsWith("-"))).slice(0, 4);

/** Runs nobody attached to are gone after a week, output and all. */
function pruneRuns() {
  let ids: string[] = [];
  try {
    ids = readdirSync(RUNS);
  } catch {
    return;
  }
  for (const id of ids) {
    try {
      if (Date.now() - statSync(join(RUNS, id)).mtimeMs > 7 * 86_400_000) rmSync(join(RUNS, id), { recursive: true, force: true });
    } catch {
      /* gone already */
    }
  }
}

/** Relay a detached run's stderr as it grows, until it has ended; then its stdout and exit code. */
async function follow(dir: string, log: (l: string) => void): Promise<{ out: string; code: number }> {
  let offset = 0;
  let rest = "";
  const drain = () => {
    const f = join(dir, "err");
    if (!existsSync(f)) return;
    const buf = readFileSync(f);
    if (buf.length <= offset) return;
    rest += buf.subarray(offset).toString();
    offset = buf.length;
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) log(l);
  };
  while (!existsSync(join(dir, "exit"))) {
    drain();
    await Bun.sleep(200);
  }
  drain();
  if (rest) log(rest);
  return { out: existsSync(join(dir, "out")) ? readFileSync(join(dir, "out"), "utf8") : "", code: Number(readFileSync(join(dir, "exit"), "utf8").trim() || 1) };
}

defineCommand({
  name: "peers host-run",
  summary: "on a peer host, started by `fornax --on`: check the fleet repo against the client's trusted state and run a command detached from the connection",
  tier: "write",
  internal: true,
  options: { server: { type: "string", help: "the name of this server in the fleet" } },
  args: [{ name: "argv", help: "the fornax command to run", variadic: true }],
  async run(input, ctx) {
    const server = String(input.server ?? fail("missing_option", "--server is required"));
    const argv = input.argv as string[];
    // first line: the 1Password service-account token (may be empty); second: anchor:head the client trusts
    // the client's stdin: the 1Password token (may be empty), the trusted anchor:head, its host keys (base64)
    const input_ = stdinLines();
    const token = (await input_.next()) ?? "";
    const trustLine = (await input_.next()) ?? "";
    const hostKeys = (await input_.next()) ?? "";
    const nonce = (await input_.next()) ?? "";
    const [anchor, head] = trustLine.split(":");
    if (!anchor || !head) fail("no_trust_anchor", "the client sent no trusted state", "start it with fornax --on <server> …");
    // reattaching is no new run: follow the old one right here, and remove it only once delivered
    if (argv[0] === "peers" && argv[1] === "attach") {
      const id = String(argv[2] ?? "");
      if (!/^[\w-]+$/.test(id) || !existsSync(join(RUNS, id))) fail("unknown_run", `no run ${id} on ${server}`);
      const r = await follow(join(RUNS, id), ctx.log);
      closePeerConnections(`/run/fornax/cm/${id}`);
      await deliver(r, join(RUNS, id), nonce, input_, ctx.log, () => false);
      return { data: null, human: "", exitCode: r.code };
    }
    const dir = PEER_DIR;
    if (!existsSync(join(dir, "fornax.yaml"))) fail("not_set_up", `no fleet repo at ${dir} yet`, "plan + apply with peers.enabled sets it up, then fornax peers sync");
    if (git(dir, "status", "--porcelain").stdout.trim()) fail("peer_dirty", `the fleet repo on ${server} has uncommitted changes`, "a run that ended before its commit was signed: look at them with fornax --on <server> run -- git -C /var/lib/fornax/fleet status");
    assertVerified(dir, head!, "HEAD", `the fleet repo on ${server}`);
    const fleetName = (YAML.parse(readFileSync(join(dir, "fornax.yaml"), "utf8")) as { fleet?: string } | null)?.fleet ?? "fleet";

    const id = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}-${Math.random().toString(36).slice(2, 6)}`;
    const run = join(RUNS, id);
    pruneRuns();
    mkdirSync(run, { recursive: true, mode: 0o700 });
    writeFileSync(join(run, "known_hosts"), Buffer.from(hostKeys, "base64").toString(), { mode: 0o600 });
    writeFileSync(join(run, "trust.json"), JSON.stringify({ [fleetName]: { anchor, head, updated: new Date().toISOString() } }), { mode: 0o600 });
    writeFileSync(join(run, "cmd"), JSON.stringify(commandWords(argv)) + "\n");
    ctx.log(`fornax on ${server}: run ${id} (if the connection drops it goes on — fornax --on ${server} peers attach ${id})`);

    const cm = `/run/fornax/cm/${id}`;
    const env: Record<string, string | undefined> = { ...process.env, FORNAX_PEER_HOST: "1", FORNAX_PEER_SELF: server, FORNAX_PEERS_STATE: join(run, "trust.json"), FORNAX_PEER_KNOWN_HOSTS: join(run, "known_hosts"), FORNAX_PEER_CM: cm, FORNAX_OP_TOKEN: token || undefined };
    // its own session, its output in files: a dropped connection neither hangs it up nor breaks its pipes
    Bun.spawn(["setsid", "sh", "-c", `"$0" "$@" > ${q(join(run, "out"))} 2> ${q(join(run, "err"))}; echo $? > ${q(join(run, "exit"))}`, process.execPath === "/usr/local/bin/fornax" ? process.execPath : "/usr/local/bin/fornax", "--fleet", dir, ...argv], { cwd: dir, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
    // a dropped connection must not stop this process: it still closes the run's connections at the end
    let dropped = false;
    process.on("SIGHUP", () => void (dropped = true));
    process.on("SIGPIPE", () => void (dropped = true));
    const log = (l: string) => {
      try {
        if (!dropped) ctx.log(l);
      } catch {
        dropped = true;
      }
    };
    let r: { out: string; code: number };
    try {
      r = await follow(run, log);
    } finally {
      // no connection this run opened outlives it — whether it ended well or not
      closePeerConnections(cm);
    }

    // what the command changed in the fleet repo becomes a commit, signed through the forwarded agent
    if (git(dir, "status", "--porcelain").stdout.trim()) {
      const add = git(dir, "add", "-A");
      const commit = add.code === 0 ? Bun.spawnSync(["git", "-C", dir, "commit", "-q", "-m", `fornax ${commandWords(argv).join(" ")} (on ${server})`], { stdout: "pipe", stderr: "pipe" }) : undefined;
      if (!commit || commit.exitCode !== 0) ctx.log(`warning: the fleet repo on ${server} changed, but the commit could not be signed: ${commit?.stderr.toString().trim() ?? add.stderr.trim()}`);
      else ctx.log(`fleet repo on ${server}: committed ${git(dir, "rev-parse", "--short=12", "HEAD").stdout.trim()} (signed)`);
    }
    // delivered: nothing of it stays on the server. The client confirms it got the output (it answers
    // the marker below on stdin); without that answer — a dropped connection — the run stays for attach
    if (!dropped) await deliver(r, run, nonce, input_, log, () => dropped);
    return { data: null, human: "", exitCode: r.code };
  },
});

defineCommand({
  name: "peers attach",
  summary: "follow a run `fornax --on` started on this host, e.g. after the connection dropped: its output and exit code",
  tier: "read",
  args: [{ name: "run", help: "the run id fornax --on printed", required: true }],
  examples: ["fornax --on web-1 peers attach 20261025T101500-ab12"],
  async run(input, ctx) {
    const id = String(input.run);
    if (!/^[\w-]+$/.test(id) || !existsSync(join(RUNS, id))) fail("unknown_run", `no run ${id} on this host`);
    const r = await follow(join(RUNS, id), ctx.log);
    closePeerConnections(`/run/fornax/cm/${id}`);
    // read here on the host itself: nobody confirms delivery, so the run stays until it is pruned
    return { data: r.out, human: r.out, exitCode: r.code };
  },
});
