/**
 * Every server a host (docs/peers.md, docs/design/peers.md). The fleet repo lies on every server as
 * plain git, so a server must never trust it for lying there: before a host uses the repo, every
 * commit since the last state it trusted is checked — each one against the signers its *parent*
 * names (peers.signers), so a commit cannot sign its own key in. Signers are keys a person holds;
 * a server holds none, so a broken-into server can write to its copy but nobody will use it.
 *
 * The last trusted state lives with the client (~/.config/fornax/peers.json, like known_hosts):
 * a peer whose head does not descend from it is refused, so no peer can slip back an older state.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { fail } from "./errors.ts";

/** git's namespace for commit signatures (ssh-keygen -Y … -n git). */
const NAMESPACE = "git";

const run = (cmd: string[], opts: { cwd?: string; stdin?: string } = {}) => {
  const p = Bun.spawnSync(cmd, { cwd: opts.cwd, stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

export const git = (repo: string, ...args: string[]) => run(["git", "-C", repo, ...args]);

function gitOk(repo: string, ...args: string[]): string {
  const r = git(repo, ...args);
  if (r.code !== 0) fail("git_failed", `git ${args.join(" ")} failed in ${repo}`, r.stderr.trim());
  return r.stdout.trim();
}

/** A commit object split into what was signed and its SSH signature (null: unsigned). */
export function splitSignature(raw: string): { payload: string; signature: string | null } {
  const lines = raw.split("\n");
  const out: string[] = [];
  const sig: string[] = [];
  let inSig = false;
  let inHeader = true;
  for (const line of lines) {
    if (inHeader && line === "") inHeader = false;
    if (inHeader && line.startsWith("gpgsig ")) {
      inSig = true;
      sig.push(line.slice("gpgsig ".length));
      continue;
    }
    // the signature's continuation lines start with one space
    if (inSig && inHeader && line.startsWith(" ")) {
      sig.push(line.slice(1));
      continue;
    }
    inSig = false;
    out.push(line);
  }
  return { payload: out.join("\n"), signature: sig.length ? sig.join("\n") + "\n" : null };
}

/** peers.signers as fornax.yaml has them at a commit ([] when the file or the key is missing). */
export function signersAt(repo: string, commit: string): string[] {
  const r = git(repo, "show", `${commit}:fornax.yaml`);
  if (r.code !== 0) return [];
  try {
    const signers = (YAML.parse(r.stdout) as { peers?: { signers?: unknown } } | null)?.peers?.signers;
    return Array.isArray(signers) ? signers.filter((s): s is string => typeof s === "string").map((s) => s.trim()) : [];
  } catch {
    return [];
  }
}

/** What the trust of the fleet rests on at a commit: the signers and every root key. */
export function trustAt(repo: string, commit: string): { signers: string[]; rootKeys: string[] } {
  const keys: string[] = [];
  const read = (path: string) => {
    const r = git(repo, "show", `${commit}:${path}`);
    if (r.code !== 0) return;
    try {
      const doc = YAML.parse(r.stdout) as { ssh?: { root_keys?: unknown; authorized_keys?: unknown } } | null;
      for (const k of [doc?.ssh?.root_keys, doc?.ssh?.authorized_keys]) if (Array.isArray(k)) keys.push(...k.map(String));
    } catch {
      /* an unreadable file is the schema's business, not this check's */
    }
  };
  read("fornax.yaml");
  for (const f of git(repo, "ls-tree", "--name-only", commit, "servers/").stdout.split("\n").filter((f) => /\.ya?ml$/.test(f))) read(f);
  return { signers: signersAt(repo, commit), rootKeys: keys.sort() };
}

/** Key fingerprint (SHA256:…) of a public key line. */
export function fingerprint(key: string): string {
  const r = run(["ssh-keygen", "-l", "-f", "-"], { stdin: key + "\n" });
  return r.stdout.split(" ")[1] ?? "?";
}

export interface CommitCheck {
  commit: string;
  subject: string;
  ok: boolean;
  /** The signer whose key verified it (its comment, else its fingerprint). */
  signer?: string;
  reason?: string;
  /** The commit changes peers.signers or a root key: the plan and the approval show it apart. */
  trustChange: boolean;
}

/** Check one commit's signature against a list of signer key lines. */
export function verifyCommit(repo: string, commit: string, signers: string[]): { ok: boolean; signer?: string; reason?: string } {
  if (!signers.length) return { ok: false, reason: "the commit before it names no signers (peers.signers)" };
  // the object exactly as stored (not trimmed): the signature covers it byte for byte, minus the gpgsig header
  const obj = git(repo, "cat-file", "commit", commit);
  if (obj.code !== 0) fail("git_failed", `cannot read commit ${commit} in ${repo}`, obj.stderr.trim());
  const { payload, signature } = splitSignature(obj.stdout);
  if (!signature) return { ok: false, reason: "not signed" };
  if (!signature.includes("BEGIN SSH SIGNATURE")) return { ok: false, reason: "not an SSH signature (gpg/x509 are not accepted)" };
  const dir = mkdtempSync(join(tmpdir(), "fornax-peers-"));
  try {
    writeFileSync(join(dir, "allowed"), signers.map((k) => `fornax namespaces="${NAMESPACE}" ${k}`).join("\n") + "\n");
    writeFileSync(join(dir, "sig"), signature);
    const v = run(["ssh-keygen", "-Y", "verify", "-f", join(dir, "allowed"), "-I", "fornax", "-n", NAMESPACE, "-s", join(dir, "sig")], { stdin: payload });
    if (v.code !== 0) return { ok: false, reason: "signed by a key that is not one of the signers" };
    const fp = v.stdout.match(/key (SHA256:\S+)/)?.[1];
    const key = fp ? signers.find((k) => fingerprint(k) === fp) : undefined;
    const comment = key?.split(" ").slice(2).join(" ");
    return { ok: true, signer: comment || fp };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const isAncestor = (repo: string, a: string, b: string) => git(repo, "merge-base", "--is-ancestor", a, b).code === 0;

/**
 * Every commit after `trusted` up to `head`, each checked against its parent's signers. History
 * must be linear and descend from `trusted`: a merge or a head off to the side is refused.
 */
export function verifyRange(repo: string, trusted: string, head: string): CommitCheck[] {
  const t = gitOk(repo, "rev-parse", `${trusted}^{commit}`);
  const h = gitOk(repo, "rev-parse", `${head}^{commit}`);
  if (t === h) return [];
  if (!isAncestor(repo, t, h)) fail("fleet_rollback", `${h.slice(0, 12)} does not descend from the last trusted state ${t.slice(0, 12)}`, "a peer may be offering an older or a forged history — compare with `fornax peers`");
  const lines = gitOk(repo, "rev-list", "--reverse", "--parents", `${t}..${h}`).split("\n").filter(Boolean);
  const checks: CommitCheck[] = [];
  let prev = t;
  for (const line of lines) {
    const [commit, ...parents] = line.split(" ") as [string, ...string[]];
    const subject = gitOk(repo, "log", "-1", "--format=%s", commit);
    if (parents.length !== 1 || parents[0] !== prev) {
      checks.push({ commit, subject, ok: false, reason: parents.length > 1 ? "a merge commit (the fleet's history is linear)" : "not a direct descendant of the commit before", trustChange: false });
      break;
    }
    const before = trustAt(repo, prev);
    const after = trustAt(repo, commit);
    const trustChange = JSON.stringify(before) !== JSON.stringify(after);
    checks.push({ commit, subject, trustChange, ...verifyCommit(repo, commit, before.signers) });
    prev = commit;
  }
  return checks;
}

/** verifyRange, failing on the first commit that does not hold. */
export function assertVerified(repo: string, trusted: string, head: string, where = "the fleet repo"): CommitCheck[] {
  const checks = verifyRange(repo, trusted, head);
  const bad = checks.find((c) => !c.ok);
  if (bad) {
    const code = /not one of the signers|names no signers/.test(bad.reason ?? "") ? "not_a_signer" : "unsigned_fleet";
    fail(code, `${where}: commit ${bad.commit.slice(0, 12)} ("${bad.subject}") is refused — ${bad.reason}`, "only commits signed by a key in peers.signers (as the commit before names them) are used", "fornax peers verify", { checks });
  }
  return checks;
}

// ---- the client's trust state ----------------------------------------------------

export interface TrustState {
  /** The commit trust starts from: pinned by hand (`fornax peers trust`). */
  anchor: string;
  /** The newest commit this machine has verified; peers must descend from it. */
  head: string;
  updated: string;
}

/** ~/.config/fornax/peers.json (FORNAX_PEERS_STATE replaces it, for tests and for hosts). */
export const trustFile = () => process.env.FORNAX_PEERS_STATE ?? join(process.env.HOME ?? tmpdir(), ".config", "fornax", "peers.json");

function readAll(): Record<string, TrustState> {
  const f = trustFile();
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Record<string, TrustState>;
  } catch {
    return fail("config_invalid", `${f} is not valid JSON`, "fix or remove it, then pin again: fornax peers trust");
  }
}

export const readTrust = (fleetName: string): TrustState | undefined => readAll()[fleetName];

export function writeTrust(fleetName: string, state: Omit<TrustState, "updated">): TrustState {
  const all = readAll();
  const next = { ...state, updated: new Date().toISOString() };
  all[fleetName] = next;
  const f = trustFile();
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  return next;
}

/** The trust state for a fleet, or the error that says how to pin it. */
export function needTrust(fleetName: string): TrustState {
  return readTrust(fleetName) ?? fail("no_trust_anchor", `no trusted state for fleet "${fleetName}" on this machine`, "review the fleet repo's history, then pin the commit trust starts from", "fornax peers trust");
}
