// bun run release <version>: set the version (package.json, src/core/version.ts), date its CHANGELOG
// section, run the checks, commit and tag. Pushing is yours: git push origin main v<version> — the
// tag starts the release workflow (binaries, signed checksums, GitHub release).
import { readFileSync, writeFileSync } from "node:fs";
import { compareVersions, VERSION } from "../src/core/version.ts";

const run = (cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) die(`${cmd.join(" ")} failed`);
};
const out = (cmd: string[]) => Bun.spawnSync(cmd).stdout.toString().trim();
function die(msg: string): never {
  console.error(`release: ${msg}`);
  process.exit(1);
}

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) die("usage: bun run release <version>, e.g. 0.2.0");
if (compareVersions(version, VERSION) < 0) die(`${version} is older than the current ${VERSION}`);
if (out(["git", "tag", "-l", `v${version}`])) die(`tag v${version} exists already`);
if (out(["git", "status", "--porcelain"])) die("the work tree has changes: commit or stash them first");
if (out(["git", "rev-parse", "--abbrev-ref", "HEAD"]) !== "main") die("releases are cut from main");

const changelog = readFileSync("CHANGELOG.md", "utf8");
const unreleased = changelog.match(/^## (\S+) — unreleased$/m);
if (!unreleased) die('CHANGELOG.md has no "## <version> — unreleased" section to release');
const date = new Date().toISOString().slice(0, 10);
writeFileSync("CHANGELOG.md", changelog.replace(unreleased[0], `## ${version} — ${date}`));
const pkg = readFileSync("package.json", "utf8");
writeFileSync("package.json", pkg.replace(/"version": "[^"]+"/, `"version": "${version}"`));
const src = readFileSync("src/core/version.ts", "utf8");
writeFileSync("src/core/version.ts", src.replace(/export const VERSION = "[^"]+";/, `export const VERSION = "${version}";`));

run(["bun", "run", "typecheck"]);
run(["bun", "run", "test"]);
run(["git", "commit", "-qam", `fornax ${version}`]);
run(["git", "tag", "-a", `v${version}`, "-m", `fornax ${version}`]);
console.log(`\ntagged v${version}. Publish it: git push origin main v${version}`);
