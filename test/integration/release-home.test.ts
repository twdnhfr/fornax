/**
 * `fornax release` as root, for sites whose user is gone: the Linux build of fornax runs in a throwaway
 * Ubuntu container (Docker or OrbStack). Before, `id -u` of a missing user gave "" and so uid 0 — the
 * clone, build, link and delete steps ran as root in the home that user left behind.
 * With the user there, what the release itself reads in the site's tree it reads as that user: a repo
 * whose package.json was a link to a file of root's got that file's first word into the deploy log.
 *
 *   bun test test/integration/release-home.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteBinary } from "../../src/core/binary.ts";
import type { SiteRuntime } from "../../src/core/runtime.ts";
import type { ReleaseResult } from "../../src/remote/release.ts";

const IMAGE = process.env.FORNAX_TEST_IMAGE ?? "ubuntu:24.04";
const docker = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const SECRET = "root-only-secret";
// a single word: JSON.parse quotes the first word of what it cannot parse
const ROOT_WORD = "rootonlyword4711";

const runtime = (domain: string, user: string, more: Partial<SiteRuntime> = {}): SiteRuntime => ({
  version: 1,
  domain,
  user,
  root: `/home/${user}/${domain}`,
  php: "8.3",
  preset: "static",
  repo_url: "https://git.invalid/acme/site.git",
  github_repo: null,
  branch: "main",
  shared: [],
  keep_releases: 3,
  deploy_script: ".fornax/deploy.sh",
  deploy_commands: null,
  mode: "releases",
  health_check: null,
  preview_socket: null,
  programs: [],
  node: null,
  notify: { url: null, github_status: false, ntfy: null },
  uses_deploy_key: false,
  ...more,
});

const sites = [
  runtime("ghost.test", "ghost"),
  runtime("rb.test", "ghostrb"),
  runtime("ip.test", "ghostip", { mode: "in_place" }),
  runtime("alive.test", "alive"),
  runtime("linked.test", "linker", { preset: "node", repo_url: "https://git.invalid/acme/linked.git" }),
  runtime("lrb.test", "linkrb"),
];

// as root in the container; each `fact` line becomes facts[<name>]
const SCRIPT = String.raw`set -u
fact() { printf '@@%s\t%s\n' "$1" "$(printf '%s' "$2" | base64 -w0)"; }
last() { cat "$(ls -t /var/log/fornax-sites/$1/deploys/*.json | head -1)"; }
mkdir -p /etc/fornax/sites && cp /t/sites/*.json /etc/fornax/sites/
# the image has no git: this one notes who runs it and fails, which ends the run there — except for
# linked.git, a repo whose package.json is a link to a file only root may read
cat > /usr/local/bin/git <<'GIT'
#!/bin/sh
echo "$(id -un) $*" >> /tmp/git-calls
case "$*" in
  clone*linked.git*) for a; do dir=$a; done; mkdir -p "$dir" && ln -s /etc/root-only "$dir/package.json"; exit $? ;;
  *" rev-parse HEAD") echo 4f2a9c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c; exit 0 ;;
esac
exit 1
GIT
chmod 755 /usr/local/bin/git
install -m 666 /dev/null /tmp/git-calls
install -m 600 /dev/null /etc/root-only && echo ${ROOT_WORD} > /etc/root-only
{
  # gone, its home left with releases/ linked into /etc
  useradd -m ghost; mkdir -p /etc/v-ghost && echo ${SECRET} > /etc/v-ghost/f
  su ghost -c 'mkdir ~/ghost.test && ln -s /etc/v-ghost ~/ghost.test/releases'
  # gone, with two releases to roll back between
  useradd -m ghostrb
  su ghostrb -c 'mkdir -p ~/rb.test/releases/20260101000000 ~/rb.test/releases/20260102000000 && ln -s /home/ghostrb/rb.test/releases/20260102000000 ~/rb.test/current'
  # gone, an in-place checkout
  useradd -m ghostip; su ghostip -c 'mkdir -p ~/ip.test/.git'
  userdel ghost; userdel ghostrb; userdel ghostip
  useradd -m alive; su alive -c 'mkdir ~/alive.test'
  useradd -m linker; su linker -c 'mkdir ~/linked.test'
  # releases/ linked to a directory of root's, with a release in it to roll back to
  mkdir -p /root/lrb/20260101000000
  useradd -m linkrb; su linkrb -c 'mkdir ~/lrb.test && ln -s /root/lrb ~/lrb.test/releases'
} >/dev/null 2>&1
/t/fornax release ghost.test >/dev/null 2>&1; fact ghost.exit "$?"
fact ghost.result "$(last ghost)"
fact ghost.etc "$(ls -A /etc/v-ghost)"
fact ghost.logdir "$(stat -c %U:%G /var/log/fornax-sites/ghost)"
/t/fornax release rb.test --rollback >/dev/null 2>&1; fact rb.exit "$?"
fact rb.result "$(last ghostrb)"
fact rb.current "$(readlink /home/ghostrb/rb.test/current)"
/t/fornax release ip.test >/dev/null 2>&1; fact ip.exit "$?"
fact ip.result "$(last ghostip)"
fact gone.git "$(cat /tmp/git-calls)"
fact gone.rootfiles "$(find /home/ghost /home/ghostrb /home/ghostip -user root)"
: > /tmp/git-calls
/t/fornax release alive.test >/dev/null 2>&1; fact alive.exit "$?"
fact alive.result "$(last alive)"
fact alive.git "$(cat /tmp/git-calls)"
fact alive.logdir "$(stat -c %U:%G /var/log/fornax-sites/alive)"
: > /tmp/git-calls
/t/fornax release linked.test >/dev/null 2>&1; fact linked.exit "$?"
fact linked.result "$(last linker)"
fact linked.log "$(cat "$(ls -t /var/log/fornax-sites/linker/deploys/*.log | head -1)")"
fact linked.git "$(cat /tmp/git-calls)"
fact linked.releases "$(ls -A /home/linker/linked.test/releases)"
fact linked.rootfiles "$(find /home/linker -user root)"
/t/fornax release lrb.test --rollback >/dev/null 2>&1; fact lrb.exit "$?"
fact lrb.result "$(last linkrb)"
fact lrb.current "$(readlink /home/linkrb/lrb.test/current)"
`;

const facts = new Map<string, string>();
const fact = (k: string) => facts.get(k) ?? "";
const result = (k: string) => JSON.parse(fact(`${k}.result`) || "null") as ReleaseResult | null;

beforeAll(async () => {
  if (!docker) return;
  const arch = Bun.spawnSync(["docker", "version", "--format", "{{.Server.Arch}}"]).stdout.toString().trim();
  const bin = await remoteBinary(arch === "arm64" || arch === "aarch64" ? "arm64" : "x86_64");
  const dir = mkdtempSync(join(tmpdir(), "fornax-release-"));
  copyFileSync(bin.path, join(dir, "fornax"));
  Bun.spawnSync(["chmod", "755", join(dir, "fornax")]);
  Bun.spawnSync(["mkdir", join(dir, "sites")]);
  for (const s of sites) writeFileSync(join(dir, "sites", `${s.domain}.json`), JSON.stringify(s));
  writeFileSync(join(dir, "run.sh"), SCRIPT);
  const p = Bun.spawnSync(["docker", "run", "--rm", "-v", `${dir}:/t`, IMAGE, "bash", "/t/run.sh"], { stdout: "pipe", stderr: "pipe" });
  for (const line of p.stdout.toString().split("\n")) {
    const m = line.match(/^@@([^\t]+)\t(.*)$/);
    if (m) facts.set(m[1]!, Buffer.from(m[2]!, "base64").toString());
  }
  if (!facts.size) throw new Error(`container run failed: ${p.stderr.toString()}`);
}, 600_000);

describe.skipIf(!docker)("a release for a site whose user is gone, as root in a container", () => {
  test("a deploy is refused before the clone, and reported as a failed run", () => {
    expect(fact("ghost.exit")).toBe("1");
    expect(result("ghost")).toMatchObject({ status: "failed", release: null, error: "refusing to touch /home/ghost/ghost.test as root: user ghost does not exist" });
    // nothing went through the link the user left
    expect(fact("ghost.etc")).toBe("f");
    expect(fact("ghost.logdir")).toBe("root:root");
  });

  test("a rollback is refused: `current` stays where it was", () => {
    expect(fact("rb.exit")).toBe("1");
    expect(result("rb")).toMatchObject({ status: "failed", source: "rollback", error: "refusing to touch /home/ghostrb/rb.test as root: user ghostrb does not exist" });
    expect(fact("rb.current")).toBe("/home/ghostrb/rb.test/releases/20260102000000");
  });

  test("an in-place deploy is refused before git looks at the checkout", () => {
    expect(fact("ip.exit")).toBe("1");
    expect(result("ip")?.error).toBe("refusing to touch /home/ghostip/ip.test as root: user ghostip does not exist");
  });

  test("nothing ran in those homes — as root or at all", () => {
    expect(fact("gone.git")).toBe("");
    expect(fact("gone.rootfiles")).toBe("");
  });

  test("with its user there, the run goes on as that user", () => {
    expect(fact("alive.exit")).toBe("1");
    expect(result("alive")?.error).toStartWith("command failed (exit 1): git clone");
    expect(fact("alive.git")).toStartWith("alive clone --quiet --depth 1 --branch main https://git.invalid/acme/site.git /home/alive/alive.test/releases/");
    expect(fact("alive.logdir")).toBe("root:alive");
  });
});

describe.skipIf(!docker)("what a release reads in the site's tree, it reads as the site user", () => {
  test("a package.json linked to a file of root's is refused, its content never shows", () => {
    expect(fact("linked.exit")).toBe("1");
    expect(result("linked")).toMatchObject({ status: "failed", sha: "4f2a9c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c", error: "package.json cannot be read as linker" });
    expect(fact("linked.result")).not.toContain(ROOT_WORD);
    expect(fact("linked.log")).toContain("=> building");
    expect(fact("linked.log")).not.toContain(ROOT_WORD);
    expect(fact("linked.git")).toStartWith("linker clone --quiet --depth 1 --branch main https://git.invalid/acme/linked.git /home/linker/linked.test/releases/");
    // the failed release is gone, removed as the user
    expect(fact("linked.releases")).toBe("");
    expect(fact("linked.rootfiles")).toBe("");
  });

  test("releases/ linked to a directory of root's lists nothing to roll back to", () => {
    expect(fact("lrb.exit")).toBe("1");
    expect(result("lrb")).toMatchObject({ status: "failed", source: "rollback", error: "no release to roll back to (current: none, available: none)" });
    expect(fact("lrb.current")).toBe("");
  });
});
