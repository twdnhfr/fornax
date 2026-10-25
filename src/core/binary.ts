import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail } from "./errors.ts";
import { BUILD } from "./version.ts";

export interface LocalBinary {
  path: string;
  sha: string;
  /** Build time baked into the binary (from <path>.build); undefined for builds without one. */
  build?: string;
}

const SRC = join(import.meta.dir, "..");
const ROOT = join(SRC, "..");

function newestMtime(dir: string): number {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return max;
}

/**
 * The Linux build of fornax that runs on servers (release + webhook). Looked up in
 * FORNAX_REMOTE_BINARY, next to the running binary, or in dist/ of a source checkout —
 * where it is (re)built automatically when the sources are newer.
 */
export async function remoteBinary(arch: "arm64" | "x86_64"): Promise<LocalBinary> {
  const name = `fornax-linux-${arch === "arm64" ? "arm64" : "x64"}`;
  const fromSource = existsSync(join(SRC, "cli.ts"));
  // on a server (a peer host): its own binary, for servers of the same architecture
  const self = process.platform === "linux" && !fromSource && process.arch === (arch === "arm64" ? "arm64" : "x64") ? process.execPath : undefined;
  const candidates = [process.env.FORNAX_REMOTE_BINARY, join(dirname(process.execPath), name), self, join(ROOT, "dist", name)].filter((p): p is string => Boolean(p));
  let path = candidates.find((p) => existsSync(p));
  const distPath = join(ROOT, "dist", name);
  if (fromSource && !process.env.FORNAX_REMOTE_BINARY && (!existsSync(distPath) || statSync(distPath).mtimeMs < newestMtime(SRC))) {
    mkdirSync(dirname(distPath), { recursive: true });
    // the build time is the newest source file: rebuilding unchanged sources gives the same stamp
    const build = new Date(Math.floor(newestMtime(SRC) / 1000) * 1000).toISOString().replace(".000Z", "Z");
    const p = Bun.spawnSync(
      ["bun", "build", "--compile", "--minify", `--target=bun-linux-${arch === "arm64" ? "arm64" : "x64"}`, "--define", `FORNAX_BUILD=${JSON.stringify(build)}`, join(SRC, "cli.ts"), "--outfile", distPath],
      { cwd: ROOT, stderr: "pipe", stdout: "pipe" },
    );
    if (p.exitCode !== 0) fail("build_failed", `could not build ${name}`, p.stderr.toString().slice(-800));
    writeFileSync(`${distPath}.build`, build + "\n");
    path = distPath;
  }
  if (!path) fail("binary_missing", `no ${name} found`, "servers need the Linux build of fornax; set FORNAX_REMOTE_BINARY or put it next to the fornax binary");
  const sha = new Bun.CryptoHasher("sha256").update(await Bun.file(path!).arrayBuffer()).digest("hex");
  const build = path === self ? (BUILD ?? undefined) : existsSync(`${path}.build`) ? readFileSync(`${path}.build`, "utf8").trim() || undefined : undefined;
  return { path: path!, sha, build };
}
