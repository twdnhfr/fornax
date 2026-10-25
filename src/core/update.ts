import { createHash, createPublicKey, verify } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, accessSync, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fail } from "./errors.ts";
import { RELEASE_KEY } from "./release-key.ts";
import { BUILD, compareVersions, VERSION } from "./version.ts";

export { compareVersions };

/** Where releases come from: read over plain HTTPS, with the GitHub CLI's login as the way into a private fork. */
export const RELEASE_REPO = process.env.FORNAX_RELEASE_REPO ?? "twdnhfr/fornax";

/** Whether SHA256SUMS carries the release key's signature. */
export function verifySums(sums: Uint8Array, sig: Uint8Array, key = RELEASE_KEY): boolean {
  try {
    return verify(null, sums, createPublicKey(key), sig);
  } catch {
    return false;
  }
}

/** How this fornax was installed decides how it is updated. */
export function installKind(execPath = process.execPath): { kind: "source" | "homebrew" | "binary"; dir: string } {
  // bun running src/cli.ts: a checkout (or the wrapper in ~/.local/bin pointing at one)
  if (!BUILD || /^bun(\.exe)?$/.test(basename(execPath))) return { kind: "source", dir: join(import.meta.dir, "..", "..") };
  if (/\/(Cellar|homebrew|linuxbrew)\//.test(execPath)) return { kind: "homebrew", dir: dirname(execPath) };
  return { kind: "binary", dir: dirname(execPath) };
}

function gh(args: string[], timeout = 60_000): string {
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    p = Bun.spawnSync(["gh", ...args], { timeout, stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
  } catch {
    return fail("no_github_token", `${RELEASE_REPO} could not be read over HTTPS, and the GitHub CLI (for a private repo) is not installed`, "check the network; for a private repo install gh (brew install gh) and log in: gh auth login");
  }
  if (p.exitCode !== 0) {
    const err = (p.stderr ?? "").toString().trim().split("\n").pop() ?? "";
    if (/auth|login|401|403/i.test(err)) fail("no_github_token", `the GitHub CLI cannot read ${RELEASE_REPO}: ${err}`, "log in with an account that can read the repo: gh auth login");
    if (/not found|404/i.test(err)) fail("no_release", `no such release in ${RELEASE_REPO}`, err);
    fail("github_failed", `gh ${args[0]} failed: ${err}`);
  }
  return (p.stdout ?? "").toString();
}

/** A public URL over HTTPS (curl: redirects followed, failures as exit codes); undefined when it fails. */
function fetchUrl(url: string, timeout: number, out?: string): string | undefined {
  const p = Bun.spawnSync(["curl", "-fsSL", "--proto", "=https", "--max-time", String(Math.ceil(timeout / 1000)), ...(out ? ["-o", out] : []), url], { stdout: "pipe", stderr: "pipe", timeout: timeout + 2_000 });
  return p.exitCode === 0 ? (p.stdout ?? "").toString() : undefined;
}

/** The newest release (prereleases left out), as a version without the v: the public API first, gh for a private repo. */
export function latestVersion(timeout = 15_000): string {
  const json = fetchUrl(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, timeout);
  const tag = json ? (JSON.parse(json) as { tag_name?: string }).tag_name : undefined;
  return (tag ?? gh(["api", `repos/${RELEASE_REPO}/releases/latest`, "--jq", ".tag_name"], timeout)).trim().replace(/^v/, "");
}

const platform = () => `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;

/**
 * Download a release, check SHA256SUMS against the release key and the archive against SHA256SUMS,
 * then put its files next to this binary: each one written beside its target and renamed over it,
 * so a fornax running at that moment keeps its file; the binary itself goes last.
 */
export function installRelease(version: string, dir: string, log: (l: string) => void): string[] {
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    fail("not_writable", `${dir} is not writable for this user`, "update as the user that installed fornax (or with sudo), or reinstall it to a directory of yours");
  }
  const tmp = mkdtempSync(join(tmpdir(), "fornax-update-"));
  try {
    const x = downloadRelease(version, platform(), tmp, log);
    const files = readdirSync(x).filter((f) => !f.startsWith("."));
    for (const f of [...files.filter((f) => f !== "fornax"), "fornax"]) {
      const target = join(dir, f);
      copyFileSync(join(x, f), `${target}.new`);
      chmodSync(`${target}.new`, statSync(join(x, f)).mode & 0o777 || (f.endsWith(".build") ? 0o644 : 0o755));
      renameSync(`${target}.new`, target);
    }
    return files;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Download a release for a platform ("linux-x64", "darwin-arm64" …) into `tmp`, check SHA256SUMS
 * against the release key and the archive against SHA256SUMS, and unpack it: returns the directory
 * holding its files (the binary `fornax`, its `.build`). Throws when anything does not hold.
 */
export function downloadRelease(version: string, plat: string, tmp: string, log: (l: string) => void): string {
  const asset = `fornax-${version}-${plat}.tar.gz`;
  {
    log(`downloading ${asset} from ${RELEASE_REPO} …`);
    // over HTTPS like any download; the GitHub CLI only when that fails (a private repo). Trust comes from the signature, not the channel.
    const base = `https://github.com/${RELEASE_REPO}/releases/download/v${version}`;
    const direct = [asset, "SHA256SUMS", "SHA256SUMS.sig"].every((f) => fetchUrl(`${base}/${f}`, 300_000, join(tmp, f)) !== undefined);
    if (!direct) gh(["release", "download", `v${version}`, "-R", RELEASE_REPO, "-D", tmp, "--clobber", "-p", asset, "-p", "SHA256SUMS", "-p", "SHA256SUMS.sig"], 300_000);
    for (const f of [asset, "SHA256SUMS", "SHA256SUMS.sig"]) if (!existsSync(join(tmp, f))) fail("no_release", `release v${version} has no ${f}`, f === asset ? `no build for ${platform()}` : "releases from before signing cannot be installed with self-update");
    const sums = readFileSync(join(tmp, "SHA256SUMS"));
    if (!verifySums(sums, readFileSync(join(tmp, "SHA256SUMS.sig")))) fail("signature_invalid", `SHA256SUMS of v${version} is not signed with fornax's release key`, "nothing was installed; the download may have been tampered with");
    const want = sums.toString().split("\n").find((l) => l.trim().endsWith(` ${asset}`) || l.trim().endsWith(`*${asset}`))?.split(/\s+/)[0];
    const got = createHash("sha256").update(readFileSync(join(tmp, asset))).digest("hex");
    if (!want || want !== got) fail("signature_invalid", `${asset} does not match its signed checksum`, "nothing was installed");
    const x = join(tmp, "x");
    mkdirSync(x);
    const tar = Bun.spawnSync(["tar", "-xzf", join(tmp, asset), "-C", x], { stderr: "pipe" });
    if (tar.exitCode !== 0) fail("update_failed", `could not unpack ${asset}: ${tar.stderr.toString().trim()}`);
    if (!readdirSync(x).includes("fornax")) fail("update_failed", `${asset} holds no fornax binary`);
    return x;
  }
}

/**
 * At most once a day, a line when a newer release is out — for release binaries only (a checkout
 * updates with git), never in --json output, never when it fails (offline, no gh login).
 */
export function updateNotice(now = Date.now()): string | undefined {
  if (process.env.FORNAX_NO_UPDATE_CHECK) return undefined;
  const kind = installKind();
  if (kind.kind === "source") return undefined;
  const file = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "fornax", "update-check.json");
  let cached: { checked?: number; latest?: string } = {};
  try {
    cached = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  let latest = cached.latest;
  if (!cached.checked || now - cached.checked > 86_400_000) {
    try {
      latest = latestVersion(3_000);
    } catch {
      latest = undefined;
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ checked: now, latest }));
    } catch {}
  }
  if (!latest || compareVersions(latest, VERSION) <= 0) return undefined;
  return `fornax ${latest} is out (this is ${VERSION}) — ${kind.kind === "homebrew" ? "brew upgrade fornax" : "fornax self-update"}`;
}
