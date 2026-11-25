/**
 * What root still looked at in the homes — the deploy key's probe, `fornax explain` and `fornax detach forge` —
 * run for real: the generated scripts run as root in throwaway Ubuntu containers (Docker or OrbStack),
 * against homes with planted links into root's directories and homes no account owns.
 *
 *   bun test test/integration/root-reads.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFleet, resolveSite, sites } from "../../src/core/fleet.ts";
import { applyScript, parseProbe, probeScript } from "../../src/core/plan.ts";
import { parseFacts, type Facts } from "../../src/core/probe.ts";
import { siteProbe } from "../../src/commands/observe.ts";
import { detachResources, PROBE as DETACH_PROBE } from "../../src/forge/detach.ts";
import { deploySiteResources } from "../../src/modules/deploy.ts";

const IMAGE = process.env.FORNAX_TEST_IMAGE ?? "ubuntu:24.04";
const docker = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const SECRET = "root-only-secret";
const WORKER = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIForgeForgeForgeForgeForgeForgeForgeForge worker@forge.laravel.com";
const MINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMineMineMineMineMineMineMineMineMine me@laptop";

const fleet = loadFleet({ cwd: join(import.meta.dir, "..", "..", "examples", "fleet") });
const server = fleet.servers.get("web-1")!;
const docs = resolveSite(fleet, server, "docs.example.com");
const ctx = { fleet, server, sites: sites(fleet, server), facts: { arch: "arm64", codename: "noble", version: "24.04", phpRepo: true, binary: { keep: false } }, admin: "fornax" } as never;
const deployKey = deploySiteResources(ctx, docs).find((r) => r.id === `check:deploy-key:${docs.domain}`)!;
const detach = detachResources({ server: { ...server, forge_detach: { ufw_ssh_ips: [] }, files: [] } } as never)[0]!;

/** Run `steps` (shell, as root) in a fresh container; `out <name> <command>` records a command's output. */
function container(name: string, files: Record<string, string>, steps: string, setup = ""): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), `fornax-${name}-`));
  for (const [f, content] of Object.entries(files)) writeFileSync(join(dir, f), content);
  writeFileSync(join(dir, "run.sh"), `set -u\nout() { local k="$1" v; shift; v="$("$@" 2>&1)"; printf '@@%s\\t%s\\n' "$k" "$(printf %s "$v" | base64 -w0)"; }\n${setup}\n${steps}\n`);
  const p = Bun.spawnSync(["docker", "run", "--rm", "-v", `${dir}:/t`, IMAGE, "bash", "/t/run.sh"], { stdout: "pipe", stderr: "pipe" });
  const res = new Map<string, string>();
  for (const line of p.stdout.toString().split("\n")) {
    const m = line.match(/^@@([^\t]+)\t(.*)$/);
    if (m) res.set(m[1]!, Buffer.from(m[2]!, "base64").toString());
  }
  if (!res.size) throw new Error(`container ${name} failed: ${p.stderr.toString()}`);
  return res;
}

let dk = new Map<string, string>();
let obs = new Map<string, string>();
let forge = new Map<string, string>();
const facts = (m: Map<string, string>, k: string): Facts => parseFacts(m.get(k) ?? "");

beforeAll(() => {
  if (!docker) return;
  const u = docs.user;
  // the deploy key: a real one, then .ssh swapped for a link to root's directory, then the user deleted, then the home
  dk = container(
    "deploy-key",
    { "probe.sh": probeScript([deployKey]) },
    `useradd -m ${u}
su ${u} -c 'mkdir -m 700 ~/.ssh && echo key > ~/.ssh/fornax-deploy && chmod 600 ~/.ssh/fornax-deploy'
out real bash /t/probe.sh
mkdir -p /etc/v-dk && echo ${SECRET} > /etc/v-dk/fornax-deploy && chmod 600 /etc/v-dk/fornax-deploy
rm -rf /home/${u}/.ssh && su ${u} -c 'ln -s /etc/v-dk ~/.ssh'
out linked bash /t/probe.sh
userdel ${u}
out orphan bash /t/probe.sh
rm -rf /home/${u}
out gone bash /t/probe.sh`,
  );
  // explain: a release of the user's own, then `current` pointed at a repo of root's, then the user deleted
  obs = container(
    "explain",
    { "probe.sh": siteProbe(docs) },
    `useradd -m ${u}
mkdir -p /etc/nginx/sites-enabled && touch /etc/nginx/sites-enabled/${docs.domain}
su ${u} -c 'set -e; mkdir -p ${docs.root}/releases/1; cd ${docs.root}/releases/1; git init -q; git -c user.email=a@b -c user.name=a commit -q --allow-empty -m one; git remote add origin https://github.com/acme/docs.git; ln -sfn ${docs.root}/releases/1 ${docs.current}; echo X=1 > ${docs.root}/.env'
out own bash /t/probe.sh
mkdir -p /srv/rootrepo && cd /srv/rootrepo && git init -q && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m root && git remote add origin https://${SECRET}@example.com/r.git && chmod 600 .git/config && cd /
su ${u} -c 'ln -sfn /srv/rootrepo ${docs.current}'
out linked bash /t/probe.sh
userdel ${u}
out orphan bash /t/probe.sh`,
    "apt-get update -qq >/dev/null && apt-get install -y -qq git >/dev/null 2>&1",
  );
  // detach forge: root's key, a user's own, keys and files behind links to root's directories, a home no account owns
  forge = container(
    "forge",
    { "probe.sh": DETACH_PROBE, "check.sh": probeScript([detach]), "apply.sh": applyScript([detach]) },
    `mkdir -p -m 700 /root/.ssh && printf '%s\\n%s\\n' "${MINE}" "${WORKER}" > /root/.ssh/authorized_keys
mkdir -p /etc/v-keys && printf '%s\\n' "${WORKER}" > /etc/v-keys/authorized_keys && cp /etc/v-keys/authorized_keys /etc/v-keys/direct
printf 'DB_USERNAME=forge\\n' > /etc/v-env && mkdir -p /etc/v-forge
for x in fa fb fc fd fe fg; do useradd -m $x; done
su fa -c 'mkdir -m 700 ~/.ssh && printf "%s\\n%s\\n" "${MINE}" "${WORKER}" > ~/.ssh/authorized_keys'
su fb -c 'ln -s /etc/v-keys ~/.ssh'
su fc -c 'mkdir ~/app ~/real && ln -s /etc/v-env ~/app/.env && echo DB_USERNAME=forge > ~/real/.env'
su fd -c 'ln -s /etc/v-forge ~/.forge'
su fe -c 'mkdir ~/.forge'
su fg -c 'mkdir -m 700 ~/.ssh && ln -s /etc/v-keys/direct ~/.ssh/authorized_keys'
mkdir -p /home/fz/.ssh && printf '%s\\n' "${WORKER}" > /home/fz/.ssh/authorized_keys && chown -R 4242:4242 /home/fz
out probe bash /t/probe.sh
out before bash /t/check.sh
out apply env FORNAX_RUN=x bash /t/apply.sh
out exit bash -c 'FORNAX_RUN=y bash /t/apply.sh >/dev/null 2>&1; echo $?'
out after bash /t/check.sh
out root cat /root/.ssh/authorized_keys
out fa cat /home/fa/.ssh/authorized_keys
out vkeys cat /etc/v-keys/authorized_keys /etc/v-keys/direct
out fz cat /home/fz/.ssh/authorized_keys`,
  );
}, 600_000);

describe.skipIf(!docker)("root and the homes, in a container", () => {
  test("the deploy key is probed as its user: a key behind a link to root's files does not count; without the user the plan stops", () => {
    const state = (k: string) => parseProbe(dk.get(k)!, [deployKey])[deployKey.id];
    expect(state("real")).toBe("ok");
    expect(state("linked")).toBe("missing");
    expect(() => state("orphan")).toThrow(`user ${docs.user} does not exist`);
    expect(state("gone")).toBe("missing");
  });

  test("explain reads the site's tree as its user: nothing of root's repo, and nothing of the tree without the user", () => {
    const own = facts(obs, "own");
    expect(own.get("user_exists")).toEqual(["yes"]);
    expect(own.get("sha")?.[0]).toMatch(/^[0-9a-f]{40}$/);
    expect(own.get("remote")).toEqual(["https://github.com/acme/docs.git"]);
    expect(own.get("env")).toEqual(["yes"]);
    expect(Number(own.get("current_age_s")?.[0])).toBeGreaterThanOrEqual(0);
    expect(own.get("disk")?.[0]).toBeTruthy();

    const linked = facts(obs, "linked");
    expect(linked.get("current")).toEqual(["/srv/rootrepo"]);
    expect(linked.get("sha")?.[0] ?? "").toBe("");
    expect(linked.get("remote")?.[0] ?? "").toBe("");
    expect(obs.get("linked")).not.toContain(SECRET);

    const orphan = facts(obs, "orphan");
    expect(orphan.get("user_exists")).toEqual(["no"]);
    for (const k of ["current", "current_age_s", "sha", "remote", "releases", "env", "disk"]) expect(orphan.get(k)).toBeUndefined();
    expect(orphan.get("vhost")).toEqual([`/etc/nginx/sites-enabled/${docs.domain}`]);
  });

  test("detach forge looks into each home as its owner only", () => {
    const f = facts(forge, "probe");
    expect((f.get("worker_key") ?? []).sort()).toEqual(["/home/fa/.ssh/authorized_keys", "/root/.ssh/authorized_keys"]);
    expect(f.get("env_forge_user")).toEqual(["/home/fc/real/.env"]);
    expect(f.get("forge_dir")).toEqual(["/home/fe/.forge"]);
    expect(f.get("skipped_home")).toEqual(["/home/fz"]);
    expect(forge.get("probe")).not.toContain("/etc/v-");
  });

  test("detach forge: root edits root's keys, each user its own; files behind links and homes without account stay", () => {
    expect(forge.get("before")).toContain("missing");
    expect(forge.get("exit")).toBe("0");
    expect(forge.get("after")).toContain("ok");
    expect(forge.get("root")).toBe(MINE);
    expect(forge.get("fa")).toBe(MINE);
    expect(forge.get("vkeys")).toBe(`${WORKER}\n${WORKER}`);
    expect(forge.get("fz")).toBe(WORKER);
  });

  test("the generated scripts are valid bash", () => {
    for (const script of [siteProbe(docs), DETACH_PROBE, applyScript([detach, deployKey]), probeScript([detach, deployKey])]) {
      expect(Bun.spawnSync(["bash", "-n"], { stdin: new Blob([script]) }).exitCode).toBe(0);
    }
  });
});
