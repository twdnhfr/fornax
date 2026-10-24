import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoUrl } from "./runtime.ts";
import type { Preset } from "./schema.ts";

export interface Detected {
  preset: Preset;
  web_dir?: string;
  start?: string;
  /** The file that decided it, said back to the user. */
  why: string;
}

interface Pkg {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** What a repo is from its top-level files (plus public/index.php) and package.json. */
export function presetFromFiles(files: string[], pkg?: Pkg): Detected {
  const has = (f: string) => files.includes(f);
  if (has("artisan")) return { preset: "laravel", why: "artisan" };
  if (has("public/index.php")) return { preset: "php", why: "public/index.php" };
  if (has("index.php")) return { preset: "php", web_dir: ".", why: "index.php" };
  if (pkg?.scripts?.start) {
    const pm = has("package-lock.json") && !has("bun.lock") && !has("bun.lockb") ? "npm" : "bun";
    return { preset: "node", start: `${pm} run start`, why: "package.json with a start script" };
  }
  if (has("index.html")) return { preset: "static", why: "index.html" };
  if (pkg?.scripts?.build) {
    // the build's output directory: Next.js exports to out/, Vite, Astro and most others to dist/
    const next = Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
    return { preset: "static", web_dir: next ? "out" : "dist", why: `package.json with a build script (serves ${next ? "out" : "dist"}/)` };
  }
  return { preset: "static", why: "no app entry point (artisan, index.php, a start script)" };
}

/** How this machine reads a repo: GitHub over HTTPS (never SSH, where a key agent may ask for a touch); other SSH repos not at all. */
function readableUrl(repo: string): string | undefined {
  const r = repoUrl(repo);
  if (r.github) return `https://github.com/${r.github}.git`;
  // https and local repos only: no ssh (an agent may ask for a touch), no ext:: or other transports
  return /^(https:\/\/|file:\/\/\/|\/)[^\s]*$/.test(r.url) && !r.url.startsWith("-") ? r.url : undefined;
}

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", SSH_ASKPASS: "true", GIT_ALLOW_PROTOCOL: "https:file", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });

/** The repo's branches as seen from here; undefined when it cannot be read from here (private, SSH, offline). */
export function remoteBranches(repo: string): string[] | undefined {
  const url = readableUrl(repo);
  if (!url) return undefined;
  const p = Bun.spawnSync(["git", "ls-remote", "--heads", "--", url], { env: gitEnv(), timeout: 20_000, stderr: "pipe" });
  if (p.exitCode !== 0) return undefined;
  return p.stdout.toString().split("\n").map((l) => l.split("refs/heads/")[1]).filter((b): b is string => Boolean(b));
}

/**
 * Look at the repo from this machine, with its own git access: a shallow clone without file
 * contents, then the few files that decide. GitHub repos go over HTTPS (public ones, or with a
 * stored credential) — never over SSH, where a key agent may ask for a touch or an approval.
 */
export function detectPreset(repo: string, branch: string): Detected | { error: string } {
  const url = readableUrl(repo);
  if (!url) return { error: "an SSH repo is not read from here" };
  const dir = mkdtempSync(join(tmpdir(), "fornax-detect-"));
  const env = gitEnv();
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { env, timeout: 20_000, stderr: "pipe" });
  try {
    const clone = Bun.spawnSync(["git", "clone", "--quiet", "--depth", "1", "--filter=blob:none", "--no-checkout", "--branch", branch, "--", url, dir], { env, timeout: 30_000, stderr: "pipe" });
    if (clone.exitCode !== 0) return { error: `could not read ${repo} (${branch}) from here: ${clone.stderr.toString().trim().split("\n").pop() || "git clone failed"}` };
    const files = git("ls-tree", "--name-only", "HEAD").stdout.toString().split("\n").filter(Boolean);
    if (git("cat-file", "-e", "HEAD:public/index.php").exitCode === 0) files.push("public/index.php");
    let pkg: Pkg | undefined;
    if (files.includes("package.json")) {
      try {
        pkg = JSON.parse(git("show", "HEAD:package.json").stdout.toString()) as Pkg;
      } catch {
        pkg = undefined;
      }
    }
    return presetFromFiles(files, pkg);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
