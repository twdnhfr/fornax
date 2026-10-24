/**
 * The fleet repo, kept encrypted on the servers it describes. A lost laptop then costs nothing but
 * the laptop: `fornax fleet restore` fetches the newest copy from any server and decrypts it with a
 * key you hold (a hardware key, a paper key). The servers only store it — they can read nothing.
 *
 * Encryption alone would not do: anyone can encrypt to a public recipient, so a broken-into server
 * could leave a fleet of its own making — and the next apply would run it as root everywhere. Each
 * copy therefore comes with a manifest signed by the fleet's SSH key (ssh.key, in fornax's agent),
 * and restore takes the newest copy whose signature holds.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "./errors.ts";
import type { Fleet } from "./fleet.ts";
import type { Server } from "./schema.ts";
import { askpassPath, controlDir } from "./askpass.ts";
import { q } from "./shell.ts";
import { fleetAgent } from "./ssh-agent.ts";
import { runnerFor } from "./ssh.ts";

export const COPY_DIR = "/var/lib/fornax/fleet-copy";
const NAMESPACE = "fornax-fleet-copy";

export interface Manifest {
  format: 1;
  fleet: string;
  /** ISO time the copy was made: restore takes the newest. */
  created: string;
  /** HEAD of the fleet repo, and whether the working tree differed from it. */
  commit: string | null;
  dirty: boolean;
  sha256: string;
  size: number;
}

export const copyPaths = (fleetName: string) => ({
  data: `${COPY_DIR}/${fleetName}.tar.age`,
  manifest: `${COPY_DIR}/${fleetName}.json`,
  sig: `${COPY_DIR}/${fleetName}.json.sig`,
});

const run = (cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; stdin?: Blob } = {}) => {
  const p = Bun.spawnSync(cmd, { cwd: opts.cwd, env: opts.env ?? process.env, stdin: opts.stdin, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString(), bytes: p.stdout };
};

function need(bin: string, hint: string) {
  if (run(["sh", "-c", `command -v ${bin}`]).code !== 0) fail("missing_tool", `${bin} is not installed`, hint);
}

/** The fleet key's public half, from fornax's agent. */
async function signerKey(fleet: Fleet): Promise<{ agent: string; pub: string }> {
  const agent = await fleetAgent(fleet);
  if (!agent) fail("config_invalid", "fleet_copy needs ssh.key: copies are signed with the fleet's SSH key", "fornax secrets setup makes one");
  const pub = run(["ssh-add", "-L"], { env: { ...process.env, SSH_AUTH_SOCK: agent } }).stdout.trim().split("\n")[0] ?? "";
  if (!pub.startsWith("ssh-")) fail("ssh_key_invalid", "the fleet's SSH key is not in fornax's agent");
  return { agent: agent!, pub };
}

interface Package {
  dir: string;
  data: string;
  manifest: string;
  sig: string;
  info: Manifest;
}

const packages = new Map<string, Promise<Package>>();

/** Encrypt and sign the fleet repo once per run (every server of the run gets the same copy). */
export function packageFleet(fleet: Fleet): Promise<Package> {
  if (!packages.has(fleet.dir)) packages.set(fleet.dir, makePackage(fleet));
  return packages.get(fleet.dir)!;
}

async function makePackage(fleet: Fleet): Promise<Package> {
  const recipients = fleet.config.fleet_copy?.recipients ?? [];
  if (!recipients.length) fail("config_invalid", "fleet_copy.recipients is empty");
  need("age", "brew install age (or your distribution's age package)");
  const { agent, pub } = await signerKey(fleet);
  const dir = mkdtempSync(join(tmpdir(), "fornax-copy-"));
  chmodSync(dir, 0o700);
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));

  // the whole repo with its history; .fornax/ holds plans and .env copies and stays on this machine
  const tar = run(["tar", "--exclude=./.fornax", "--exclude=./.anvil", "-czf", "-", "-C", fleet.dir, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (tar.code !== 0) fail("fleet_copy_failed", "packing the fleet repo failed", tar.stderr.trim());
  const data = join(dir, "fleet.tar.age");
  const age = run(["age", "-e", ...recipients.flatMap((r) => ["-r", r]), "-o", data], { stdin: new Blob([tar.bytes]) });
  if (age.code !== 0) fail("fleet_copy_failed", "encrypting the fleet repo failed", age.stderr.trim());

  const git = (args: string[]) => run(["git", "-C", fleet.dir, ...args]);
  const head = git(["rev-parse", "HEAD"]);
  const bytes = readFileSync(data);
  const info: Manifest = {
    format: 1,
    fleet: fleet.config.fleet,
    created: new Date().toISOString(),
    commit: head.code === 0 ? head.stdout.trim() : null,
    dirty: git(["status", "--porcelain"]).stdout.trim() !== "",
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
  const manifest = join(dir, "fleet.json");
  writeFileSync(manifest, JSON.stringify(info, null, 2) + "\n");
  const pubFile = join(dir, "signer.pub");
  writeFileSync(pubFile, pub + "\n");
  const sign = run(["ssh-keygen", "-q", "-Y", "sign", "-f", pubFile, "-n", NAMESPACE, manifest], { env: { ...process.env, SSH_AUTH_SOCK: agent } });
  if (sign.code !== 0) fail("fleet_copy_failed", "signing the fleet copy failed", sign.stderr.trim());
  return { dir, data, manifest, sig: `${manifest}.sig`, info };
}

/** Put the current fleet copy on a server (root-only). */
export async function pushCopy(fleet: Fleet, server: Server): Promise<Manifest> {
  const pkg = await packageFleet(fleet);
  const p = copyPaths(fleet.config.fleet);
  const runner = runnerFor(fleet, server);
  await runner.run(`install -d -m 0700 -o root -g root ${COPY_DIR}`);
  // the manifest last: whoever reads one finds its data and signature already in place
  await runner.upload(pkg.data, p.data, "0600");
  await runner.upload(pkg.sig, p.sig, "0600");
  await runner.upload(pkg.manifest, p.manifest, "0600");
  return pkg.info;
}

/** Check a manifest's signature against the signer's public key line. */
export function verifyManifest(manifest: string, sig: string, signerPub: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "fornax-verify-"));
  try {
    writeFileSync(join(dir, "allowed"), `fornax ${signerPub.trim()}\n`);
    writeFileSync(join(dir, "sig"), sig);
    const v = run(["ssh-keygen", "-Y", "verify", "-f", join(dir, "allowed"), "-I", "fornax", "-n", NAMESPACE, "-s", join(dir, "sig")], { stdin: new Blob([manifest]) });
    return v.code === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The manifest on a server, whether its signature holds — or null when the server has no copy. */
export async function readCopy(fleet: Fleet, server: Server): Promise<{ manifest: Manifest; valid: boolean } | null> {
  const p = copyPaths(fleet.config.fleet);
  const r = await runnerFor(fleet, server).run(`[ -f ${q(p.manifest)} ] || exit 3; cat ${q(p.manifest)}; printf '\\0'; cat ${q(p.sig)}`, { allowFail: true });
  if (r.code === 3) return null;
  if (r.code !== 0) fail("remote_failed", `reading the fleet copy on ${server.server} failed`, r.stderr.trim());
  const [manifest, sig] = r.stdout.split("\0") as [string, string];
  const { pub } = await signerKey(fleet);
  return { manifest: JSON.parse(manifest) as Manifest, valid: verifyManifest(manifest, sig ?? "", pub) };
}

/** Files in a directory, for "is it empty" (restore never writes over a directory with something in it). */
export const isEmptyDir = (d: string) => !existsSync(d) || readdirSync(d).length === 0;


export interface RestoreOptions {
  /** ssh targets (root@host), tried in turn; the newest validly signed copy among them wins. */
  from: string[];
  /** The fleet key's public key: a key line, a file, or an op:// reference. */
  signer: string;
  /** age identity files or op:// references (none: age asks its plugins, e.g. a FIDO2 key). */
  identities: string[];
  dir: string;
  /** Only copies of this fleet (a server keeps one per fleet that applies to it). */
  fleetName?: string;
  /** SSH key to log in with (e.g. a security key's handle from `ssh-keygen -K`); default: ssh's own choice. */
  sshKey?: string;
  log: (line: string) => void;
}

/**
 * Bring a fleet repo back from the servers — on a machine that has nothing but ssh, age and your
 * keys: no fleet config is needed (it is what is being restored).
 */
export async function restoreCopy(o: RestoreOptions): Promise<{ dir: string; from: string; manifest: Manifest }> {
  if (!isEmptyDir(o.dir)) fail("not_empty", `${o.dir} is not empty`, "restore into a new directory");
  need("age", "brew install age — and for a FIDO2 identity the age-plugin-fido2-hmac binary in PATH");
  const work = mkdtempSync(join(tmpdir(), "fornax-restore-"));
  chmodSync(work, 0o700);
  try {
    const signer = readRef(o.signer).trim();
    // one connection per server for all fetches: a security key asks once
    // on a Mac, PIN and touch of a security key come as dialogs (askpass.ts); elsewhere on the terminal
    const env = process.platform === "darwin" ? { ...process.env, SSH_ASKPASS: askpassPath(), SSH_ASKPASS_REQUIRE: "prefer", DISPLAY: process.env.DISPLAY ?? ":0" } : process.env;
    const key = o.sshKey ? ["-i", o.sshKey] : [];
    const ssh = (target: string, remote: string) =>
      Bun.spawn(["ssh", ...key, "-o", "ControlMaster=auto", "-o", `ControlPath=${controlDir()}/%C`, "-o", "ControlPersist=120", target, remote], { stdin: "inherit", stdout: "pipe", stderr: "inherit", env });
    const candidates: Array<{ target: string; name: string; manifest: Manifest }> = [];
    for (const target of o.from) {
      o.log(`looking at ${target} …`);
      const p = ssh(target, `for m in ${COPY_DIR}/*.json; do [ -f "$m" ] || continue; printf '%s\\0' "$(basename "$m" .json)"; cat "$m"; printf '\\0'; cat "$m.sig"; printf '\\0'; done`);
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) {
        o.log(`  ${target}: not reachable or no access (needs root)`);
        continue;
      }
      const parts = out.split("\0");
      for (let i = 0; i + 2 < parts.length; i += 3) {
        const [name, manifest, sig] = [parts[i]!, parts[i + 1]!, parts[i + 2]!];
        if (o.fleetName && name !== o.fleetName) continue;
        if (!verifyManifest(manifest, sig, signer)) {
          o.log(`  ${target}: copy "${name}" is NOT signed by the fleet key — ignored`);
          continue;
        }
        const m = JSON.parse(manifest) as Manifest;
        o.log(`  ${target}: "${name}" from ${m.created}${m.commit ? ` (commit ${m.commit.slice(0, 12)}${m.dirty ? ", with uncommitted changes" : ""})` : ""}`);
        candidates.push({ target, name, manifest: m });
      }
    }
    const fleets = new Set(candidates.map((c) => c.name));
    if (fleets.size > 1) fail("ambiguous", `copies of several fleets found: ${[...fleets].join(", ")}`, "choose one with --fleet-name");
    const best = candidates.sort((a, b) => b.manifest.created.localeCompare(a.manifest.created))[0];
    if (!best) fail("no_copy", "no validly signed fleet copy found", "check --from (root@host of a server fornax applied to) and --signer");
    o.log(`restoring "${best!.name}" from ${best!.target} (${best!.manifest.created})`);

    const dl = ssh(best!.target, `cat ${q(copyPaths(best!.name).data)}`);
    const bytes = new Uint8Array(await new Response(dl.stdout).arrayBuffer());
    if ((await dl.exited) !== 0) fail("fleet_copy_failed", `downloading the copy from ${best!.target} failed`);
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (hash !== best!.manifest.sha256) fail("fleet_copy_failed", "the downloaded copy does not match its signed manifest", "try another server with --from");
    const data = join(work, "fleet.tar.age");
    writeFileSync(data, bytes);

    const ids = o.identities.map((ref, i) => {
      if (!ref.startsWith("op://")) return ref;
      const f = join(work, `identity-${i}`);
      writeFileSync(f, readRef(ref), { mode: 0o600 });
      return f;
    });
    o.log("decrypting — have your key ready (PIN, touch) …");
    const tarFile = join(work, "fleet.tar.gz");
    const age = Bun.spawnSync(["age", "-d", ...ids.flatMap((f) => ["-i", f]), "-o", tarFile, data], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (age.exitCode !== 0) fail("fleet_copy_failed", "decrypting failed", "is the key you used one of fleet_copy.recipients?");
    mkdirSync(o.dir, { recursive: true });
    const tar = run(["tar", "-xzf", tarFile, "-C", o.dir]);
    if (tar.code !== 0) fail("fleet_copy_failed", "unpacking failed", tar.stderr.trim());
    return { dir: o.dir, from: best!.target, manifest: best!.manifest };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A value given directly, as a file, or as an op:// reference (read with the 1Password CLI). */
function readRef(ref: string): string {
  if (ref.startsWith("op://")) {
    let r = run(["op", "read", ref]);
    // op picks one account when several are signed in (OP_ACCOUNT, or its default): on a fresh
    // machine nobody remembers which one holds the item, so try them all
    if (r.code !== 0 && !process.env.OP_ACCOUNT) {
      const list = run(["op", "account", "list", "--format", "json"]);
      const accounts = list.code === 0 ? (JSON.parse(list.stdout || "[]") as Array<{ url?: string }>).map((a) => a.url).filter(Boolean) : [];
      for (const account of accounts) {
        const tried = run(["op", "read", "--account", account!, ref]);
        if (tried.code === 0) {
          r = tried;
          break;
        }
      }
    }
    if (r.code !== 0) fail("secret_unavailable", `cannot read ${ref}`, `${r.stderr.trim()} — with several 1Password accounts, OP_ACCOUNT=<account> picks one`);
    return r.stdout;
  }
  return existsSync(ref) ? readFileSync(ref, "utf8") : ref;
}
