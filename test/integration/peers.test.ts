/**
 * Peers on OrbStack: three clones of `fornax-base` carry the fleet repo; plan and apply run on any
 * of them over a forwarded agent; forged, unsigned and diverged histories are refused.
 *
 *   bun test test/integration/peers.test.ts --timeout 1800000
 *
 * The client signs its commits with a throwaway "laptop" key; the dev key (.dev/id_ed25519) logs in
 * as root and is a signer too — the way a hardware key that logs in also signs what a host commits.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const KEY = join(ROOT, ".dev", "id_ed25519");
const PREFIX = `fornax-peers-${Date.now().toString(36)}`;
const NAMES = ["p1", "p2", "p3"] as const;
const work = mkdtempSync(join(tmpdir(), "fornax-peers-int-"));
const fleet = join(work, "fleet");
const ips: Record<string, string> = {};

const orb = (...args: string[]) => {
  const p = Bun.spawnSync(["orb", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`orb ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};

// git and fornax must not see the developer's own git config, keys or trust state
Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "laptop", "-f", join(work, "laptop")]);
const laptopPub = readFileSync(join(work, "laptop.pub"), "utf8").trim();
const devPub = readFileSync(`${KEY}.pub`, "utf8").trim();
writeFileSync(join(work, "gitconfig"), `[user]\n  name = peers test\n  email = peers@test.invalid\n  signingkey = ${join(work, "laptop")}\n[gpg]\n  format = ssh\n[gpg "ssh"]\n  program = ssh-keygen\n[commit]\n  gpgsign = true\n[init]\n  defaultBranch = main\n`);
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(work, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", FORNAX_PEERS_STATE: join(work, "peers.json"), FORNAX_NO_UPDATE_CHECK: "1", SSH_AUTH_SOCK: "", FORNAX_FORWARD_NO_CONFIRM: "1" };

function git(...args: string[]) {
  const p = Bun.spawnSync(["git", "-C", fleet, ...args], { env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
}

async function fornax(...args: string[]): Promise<{ code: number; json: any; stderr: string }> {
  const p = Bun.spawn(["bun", join(ROOT, "src", "cli.ts"), ...args], { cwd: fleet, env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  let json: any = null;
  try {
    json = JSON.parse(out);
  } catch {
    json = { raw: out };
  }
  if (process.env.FORNAX_E2E_VERBOSE) console.error(`$ fornax ${args.join(" ")} → ${code}\n${err}${out.slice(0, 2000)}`);
  return { code, json, stderr: err };
}

const ssh = (name: string, script: string) => {
  const p = Bun.spawnSync(["ssh", "-F", "/dev/null", "-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `root@${ips[name]}`, "bash -s"], { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${name}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};

function writeFleet(signers: string[]) {
  writeFileSync(
    join(fleet, "fornax.yaml"),
    `version: 2
fleet: peerstest
ssh:
  user: root
  identity_file: ${KEY}
  known_hosts_file: ${join(work, "known_hosts")}
  root_keys:
    - ${devPub}
peers:
  enabled: true
  signers:
${signers.map((s) => `    - ${s}`).join("\n")}
`,
  );
}

beforeAll(async () => {
  for (const n of NAMES) {
    const m = `${PREFIX}-${n}`;
    orb("clone", "fornax-base", m);
    orb("start", m);
  }
  for (const n of NAMES) {
    const m = `${PREFIX}-${n}`;
    for (let i = 0; i < 60 && !ips[n]; i++) {
      try {
        ips[n] = orb("-m", m, "-u", "root", "bash", "-c", "ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1");
      } catch {
        await Bun.sleep(1000);
      }
    }
  }
  Bun.spawnSync(["mkdir", "-p", join(fleet, "servers")]);
  git("init", "-q");
  writeFileSync(join(fleet, ".gitignore"), ".fornax/\n");
  writeFleet([laptopPub, devPub]);
  for (const n of NAMES) writeFileSync(join(fleet, "servers", `${n}.yaml`), `server: ${n}\nhost: ${ips[n]}\nmodules: []\nphp: ["8.3"]\nhistory: false\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "fleet with peers");
}, 300_000);

afterAll(() => {
  if (process.env.FORNAX_E2E_KEEP) return console.error(`kept: ${NAMES.map((n) => `${PREFIX}-${n}`).join(", ")} in ${work}`);
  for (const n of NAMES) Bun.spawnSync(["orb", "delete", "-f", `${PREFIX}-${n}`]);
});

describe("peers on three servers", () => {
  test("trust is pinned on this machine", async () => {
    const r = await fornax("peers", "trust", "--json");
    expect(r.code).toBe(0);
    expect(r.json.signed_by).toBe("laptop");
  });

  test("apply sets up the repo on each server and passes the fleet on", async () => {
    for (const n of NAMES) {
      const r = await fornax("server", "provision", n, "--json");
      if (r.code !== 0) console.error(r.stderr, JSON.stringify(r.json).slice(0, 2000));
      expect(r.code).toBe(0);
    }
    const s = await fornax("peers", "sync", "--json");
    expect(s.code).toBe(0);
    const st = await fornax("peers", "status", "--json");
    expect(st.json.peers.map((p: any) => p.state)).toEqual(["same", "same", "same"]);
    expect(ssh("p2", "git -C /var/lib/fornax/fleet rev-parse HEAD").trim()).toBe(git("rev-parse", "HEAD"));
  });

  test("fornax --on runs on a peer: a plan of another server, and of itself (over loopback)", async () => {
    const other = await fornax("--on", "p1", "plan", "p2", "--json");
    if (other.code !== 0) console.error(other.stderr);
    expect(other.code).toBe(0);
    expect(other.json.in_sync).toBe(true);
    const self = await fornax("--on", "p1", "plan", "p1", "--json");
    expect(self.code).toBe(0);
    expect(self.json.in_sync).toBe(true);
  });

  test("a run leaves no connection open on the host", () => {
    expect(ssh("p1", "ls -A /run/fornax/cm 2>/dev/null | wc -l").trim()).toBe("0");
    expect(ssh("p1", "pgrep -fc 'ssh.*ControlPath=/run/fornax/cm' || true").trim()).toBe("0");
    expect(ssh("p1", "ls -A /var/lib/fornax/runs 2>/dev/null | wc -l").trim()).toBe("0");
  });

  test("a trust change a host commits is held back until it is accepted", async () => {
    const before = git("rev-parse", "HEAD");
    const r = await fornax("--on", "p2", "server", "set", "p3", "--ssh-port", "2222", "--json");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("not taken over");
    expect(git("rev-parse", "HEAD")).toBe(before);
    const s = await fornax("peers", "sync", "--json");
    expect(s.code).toBe(2);
    expect(s.json.code).toBe("trust_change_pending");
    const a = await fornax("peers", "sync", "--accept-trust-changes", "--json");
    expect(git("rev-parse", "HEAD")).not.toBe(before);
    expect(readFileSync(join(fleet, "servers", "p3.yaml"), "utf8")).toContain("2222");
    expect(a.json.peers.find((p: any) => p.server === "p1").state).toBe("same");
    // back to port 22, from this machine: its own commits need no acceptance
    const set = await fornax("server", "set", "p3", "--ssh-port", "22", "--json");
    expect(set.code).toBe(0);
    git("commit", "-q", "-am", "p3 back on port 22");
    const back = await fornax("peers", "sync", "--json");
    expect(back.code).toBe(0);
  });

  test("a change made on a host is committed there, signed through the forwarded agent, and comes back checked", async () => {
    const before = git("rev-parse", "HEAD");
    const r = await fornax("--on", "p2", "server", "set", "p3", "--public-ipv4", "192.0.2.33", "--json");
    if (r.code !== 0) console.error(r.stderr);
    expect(r.code).toBe(0);
    const after = git("rev-parse", "HEAD");
    expect(after).not.toBe(before);
    expect(git("log", "-1", "--format=%s")).toContain("(on p2)");
    const v = await fornax("peers", "verify", "--json");
    expect(v.code).toBe(0);
    expect(readFileSync(join(fleet, "servers", "p3.yaml"), "utf8")).toContain("192.0.2.33");
  });

  test("a run goes on when the connection drops; peers attach picks it up", async () => {
    // every session on p2 takes 4 s after login: the drop below comes while the run still works
    ssh("p2", "echo 'sleep 4' > /etc/ssh/sshrc");
    const p = Bun.spawn(["bun", join(ROOT, "src", "cli.ts"), "--on", "p1", "plan", "p2", "--json"], { cwd: fleet, env, stdout: "pipe", stderr: "pipe" });
    let id = "";
    const reader = p.stderr.getReader();
    let seen = "";
    // the drop comes once the host has its connection to p2: one opened later would have no agent any more
    while (!seen.includes("probing p2")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    id = seen.match(/run (\d{8}T\d{6}-[a-z0-9]+)/)?.[1] ?? "";
    expect(id).not.toBe("");
    await Bun.sleep(1500);
    // the connection drops: ssh and the client go away
    Bun.spawnSync(["pkill", "-9", "-P", String(p.pid)]);
    p.kill(9);
    await p.exited;
    const r = await fornax("--on", "p1", "peers", "attach", id);
    ssh("p2", "rm -f /etc/ssh/sshrc");
    expect(r.code).toBe(0);
    expect(r.json.in_sync).toBe(true);
    // delivered now: nothing of it stays on the host
    expect(ssh("p1", "ls -A /var/lib/fornax/runs | wc -l").trim()).toBe("0");
  });

  test("a peer's hook refuses an unsigned push", () => {
    ssh("p3", "cd /tmp && rm -rf x && git clone -q /var/lib/fornax/fleet x && cd x && echo '# forged' >> fornax.yaml && git -c user.name=x -c user.email=x@x commit -q --no-gpg-sign -am forged");
    const push = Bun.spawnSync(["ssh", "-F", "/dev/null", "-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `root@${ips.p3}`, "cd /tmp/x && git push -q origin HEAD:main 2>&1; echo rc=$?"], { stdout: "pipe" });
    const out = push.stdout.toString();
    expect(out).toContain("not signed");
    expect(out).not.toContain("rc=0");
  });

  test("a forged commit lying on a peer is refused, the others go on", async () => {
    ssh("p3", "cd /var/lib/fornax/fleet && echo '# forged' >> fornax.yaml && git -c user.name=x -c user.email=x@x commit -q --no-gpg-sign -am 'forged on the server'");
    const st = await fornax("peers", "status", "--json");
    expect(st.code).toBe(1);
    const p3 = st.json.peers.find((p: any) => p.server === "p3");
    expect(p3.state).toBe("refused");
    expect(st.json.peers.filter((p: any) => p.server !== "p3").map((p: any) => p.state)).toEqual(["same", "same"]);
    // --on refuses to run on it at all
    const on = await fornax("--on", "p3", "plan", "p1", "--json");
    expect(on.code).not.toBe(0);
    ssh("p3", "cd /var/lib/fornax/fleet && git reset -q --hard HEAD~1");
  });

  test("two histories that went different ways stop it (fleet_diverged)", async () => {
    // a signed commit only p1 has …
    git("checkout", "-q", "-b", "side");
    writeFileSync(join(fleet, "side.txt"), "side\n");
    git("add", "-A");
    git("commit", "-q", "-m", "side");
    const side = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    const sshCmd = `ssh -F /dev/null -i ${KEY} -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`;
    const push = Bun.spawnSync(["git", "-C", fleet, "push", "-q", `ssh://root@${ips.p1}/var/lib/fornax/fleet`, `${side}:refs/heads/main`], { env: { ...env, GIT_SSH_COMMAND: sshCmd }, stdout: "pipe", stderr: "pipe" });
    expect(push.exitCode).toBe(0);
    // … and another one only this machine has
    writeFileSync(join(fleet, "local.txt"), "local\n");
    git("add", "-A");
    git("commit", "-q", "-m", "local side");
    const s = await fornax("peers", "sync", "--json");
    expect(s.code).toBe(2);
    expect(s.json.code).toBe("fleet_diverged");
  });
});
