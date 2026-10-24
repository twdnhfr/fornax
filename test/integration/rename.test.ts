/**
 * A server set up under fornax's old name (anvil) moves over in one plan + apply — nothing lost,
 * nothing doubled. The old side is the real thing: the last commit before the rename, run from a
 * git worktree. On OrbStack: a server (clone of `fornax-base`) and a Storage Box stand-in.
 *
 * Covers: secrets, keys and deploy history kept · old units, programs and files gone · deploys,
 * the webhook under both paths, backups (old snapshots included), restores and certificate
 * renewal working afterwards · commands refusing a server that has not moved yet.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineIp } from "./fakes.ts";

const ROOT = join(import.meta.dir, "..", "..");
const KEY = join(ROOT, ".dev", "id_ed25519");
/** The last commit before the rename. */
const OLD_COMMIT = "95dff99";
const ID = Date.now().toString(36);
const SERVER = `fornax-rn-srv-${ID}`;
const BOX = `fornax-rn-box-${ID}`;
const SITE = "app.rn.test";
const fleet = mkdtempSync(join(tmpdir(), "fornax-rn-fleet-"));
const oldTree = join(mkdtempSync(join(tmpdir(), "fornax-rn-old-")), "anvil");
let ip = "";
let boxIp = "";
const env = { ...process.env, BOX_PW: "box-secret-pw" };

async function cli(which: "anvil" | "fornax", ...args: string[]) {
  const entry = which === "anvil" ? join(oldTree, "src", "cli.ts") : join(ROOT, "src", "cli.ts");
  const p = Bun.spawn(["bun", entry, ...args, "--json"], { cwd: fleet, env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    json = { raw: out };
  }
  if (process.env.FORNAX_E2E_VERBOSE) console.error(`$ ${which} ${args.join(" ")} → ${code}\n${err}`);
  return { code, json, stderr: err };
}

const ssh = (host: string, script: string) => {
  const p = Bun.spawnSync(["ssh", "-F", "/dev/null", "-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `root@${host}`, "bash -s"], {
    stdin: new Blob([script]),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString() + p.stdout.toString());
  return p.stdout.toString();
};
const onServer = (script: string) => ssh(ip, script);

async function machine(name: string): Promise<string> {
  Bun.spawnSync(["orb", "clone", "fornax-base", name]);
  Bun.spawnSync(["orb", "start", name]);
  for (let i = 0; i < 60; i++) {
    const a = machineIp(name);
    if (a) return a;
    await Bun.sleep(1000);
  }
  throw new Error(`${name} got no IP`);
}

/** The demo app as a git repo on the server (deploys clone it from there). */
function publish(version: string) {
  const work = mkdtempSync(join(tmpdir(), "fornax-rn-demo-"));
  cpSync(join(ROOT, "examples", "demo-php"), work, { recursive: true });
  writeFileSync(join(work, "VERSION"), version + "\n");
  const tar = Bun.spawnSync(["tar", "--no-xattrs", "-cz", "-C", work, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).stdout;
  const p = Bun.spawnSync(
    ["ssh", "-F", "/dev/null", "-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `root@${ip}`,
      `set -e; rm -rf /tmp/demo && mkdir /tmp/demo && tar -xz --no-same-owner -C /tmp/demo && cd /tmp/demo && git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm ${version}
mkdir -p /srv/git && rm -rf /srv/git/demo-php.git && git clone -q --bare /tmp/demo /srv/git/demo-php.git && git config --system --add safe.directory /srv/git/demo-php.git && chmod -R a+rX /srv/git`],
    { stdin: new Blob([tar]), stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
}

/** What must survive the move unchanged. */
const fingerprint = (root: string, home: string) =>
  onServer(`sha256sum ${root}/secrets/restic ${root}/hook-secrets/${SITE} | cut -c1-64; ssh-keygen -lf ${home}/.ssh/*-deploy.pub | cut -d' ' -f2; ssh-keygen -lf /root/.ssh/*-storagebox.pub | cut -d' ' -f2`).trim();
let before = "";
let oldSnapshot = "";
let oldRelease = "";

beforeAll(async () => {
  // the old CLI: a worktree of the last commit before the rename, sharing node_modules
  mkdirSync(join(oldTree, ".."), { recursive: true });
  const wt = Bun.spawnSync(["git", "-C", ROOT, "worktree", "add", "--detach", oldTree, OLD_COMMIT], { stderr: "pipe" });
  if (wt.exitCode !== 0) throw new Error(wt.stderr.toString());
  symlinkSync(join(ROOT, "node_modules"), join(oldTree, "node_modules"));

  [ip, boxIp] = await Promise.all([machine(SERVER), machine(BOX)]);
  for (let i = 0; i < 30; i++) {
    try {
      ssh(ip, "true");
      ssh(boxIp, "true");
      break;
    } catch {
      await Bun.sleep(1000);
    }
  }
  expect(ssh(boxIp, `bash -s u12345 box-secret-pw <<'X'\n${readFileSync(join(import.meta.dir, "setup-storagebox.sh"), "utf8")}\nX`)).toContain("storage box ready");
  onServer(readFileSync(join(import.meta.dir, "setup-pebble.sh"), "utf8").replace('arch="$1"; shift', `arch=arm64; set -- ${SITE} hook.rn.test`));

  // a fleet repo from before the rename: anvil.yaml
  writeFileSync(
    join(fleet, "anvil.yaml"),
    `fleet: rn
ssh:
  user: root
  config_file: none
  identity_file: ${KEY}
  known_hosts_file: known_hosts
tls:
  issuer: letsencrypt
  email: rn@example.com
  acme_server: https://localhost:14000/dir
  ca_bundle: /opt/pebble/pebble.minica.pem
backup:
  storage_box:
    host: ${boxIp}
    user: u12345
    password: env:BOX_PW
  keep: { daily: 3, weekly: 0, monthly: 0 }
`,
  );
  mkdirSync(join(fleet, "servers"));
  writeFileSync(
    join(fleet, "servers", "srv.yaml"),
    `server: srv
host: ${ip}
php: ["8.4"]
services: [mysql, redis, supervisor]
tools: []
hook_domain: hook.rn.test
sites:
  ${SITE}:
    repo: file:///srv/git/demo-php.git
    preset: php
    health_check: /health
    db: { engine: mysql }
    cron:
      - { at: "* * * * *", cmd: "echo tick" }
    daemons:
      - { name: worker, cmd: "sleep infinity" }
`,
  );
}, 900_000);

afterAll(() => {
  if (process.env.FORNAX_KEEP_VMS) console.error(`kept: ${SERVER} (${ip}) ${BOX} (${boxIp}), fleet ${fleet}`);
  else for (const m of [SERVER, BOX]) Bun.spawnSync(["orb", "delete", "-f", m]);
  Bun.spawnSync(["git", "-C", ROOT, "worktree", "remove", "--force", oldTree]);
});

describe("a server set up by anvil moves over to fornax", () => {
  test("the old anvil sets the server up, deploys and backs up", async () => {
    const p = await cli("anvil", "server", "provision", "srv");
    if (p.code !== 0) console.error(JSON.stringify(p.json, null, 2).slice(0, 3000));
    expect(p.code).toBe(0);
    publish("v1"); // git is there once the server is provisioned
    expect((await cli("anvil", "deploy", SITE)).json.status).toBe("success");
    onServer(`mysql -e "CREATE TABLE app.notes (t text); INSERT INTO app.notes VALUES ('from anvil')"`);
    const b = await cli("anvil", "backup", "run", "srv");
    expect(b.code).toBe(0);
    oldSnapshot = b.json.sites[SITE].snapshot;
    oldRelease = (await cli("anvil", "releases", SITE)).json.releases[0].release;
    before = fingerprint("/etc/anvil", "/home/app");
    expect(onServer("ls /etc/systemd/system | grep -c '^anvil-'").trim()).not.toBe("0");
  }, 1_800_000);

  test("fornax refuses to work on the old layout piecemeal", async () => {
    expect((await cli("fornax", "deploy", SITE)).json.code).toBe("legacy_layout");
    expect((await cli("fornax", "plan", "srv", "--site", SITE)).json.code).toBe("legacy_layout");
  }, 300_000);

  test("one plan + apply moves everything over", async () => {
    const plan = await cli("fornax", "plan", "srv");
    expect(plan.code).toBe(0);
    const ids = plan.json.changes.map((c: any) => c.id);
    for (const id of ["check:rename:copy", "check:rename:cleanup", "check:restic-repo-rename"]) expect(ids).toContain(id);
    const apply = await cli("fornax", "apply", plan.json.plan);
    if (apply.code !== 0) console.error(JSON.stringify(apply.json, null, 2).slice(0, 3000));
    expect(apply.code).toBe(0);
    const again = await cli("fornax", "plan", "srv");
    if (!again.json.in_sync) console.error(JSON.stringify(again.json.changes, null, 2).slice(0, 3000));
    expect(again.json.in_sync).toBe(true);
    // nothing of the old name is left, nothing new was invented
    expect(onServer(`ls -d /etc/anvil /var/lib/anvil /usr/local/bin/anvil /etc/systemd/system/anvil-* /etc/supervisor/conf.d/anvil-* /etc/php/*/fpm/pool.d/anvil-* /etc/cron.d/anvil-* /etc/nginx/anvil /home/*/.anvil /home/*/.ssh/anvil-deploy* 2>/dev/null | wc -l`).trim()).toBe("0");
    expect(onServer("id -u anvil-hook >/dev/null 2>&1 && echo yes || echo no").trim()).toBe("no");
    expect(fingerprint("/etc/fornax", "/home/app")).toBe(before);
    // the admin user of a server anvil set up stays "anvil" (nginx runs as it)
    expect(onServer("id -u fornax >/dev/null 2>&1 && echo yes || echo no").trim()).toBe("no");
    const programs = onServer("supervisorctl status");
    expect(programs).toContain("fornax-app-rn-test-worker");
    expect(programs).not.toContain("anvil-");
    expect(programs).not.toMatch(/FATAL|BACKOFF/);
    // the local state of the fleet repo moved too
    expect(Bun.spawnSync(["ls", join(fleet, ".fornax")]).exitCode).toBe(0);
  }, 1_800_000);

  test("deploys, history and the webhook (old and new path) work as before", async () => {
    publish("v2");
    const d = await cli("fornax", "deploy", SITE);
    expect(d.json.status).toBe("success");
    const releases = (await cli("fornax", "releases", SITE)).json.releases.map((r: any) => r.release);
    expect(releases).toContain(oldRelease);
    const secret = onServer(`cat /etc/fornax/hook-secrets/${SITE}`).trim();
    const body = JSON.stringify({ ref: "refs/heads/main", after: "0".repeat(40) });
    for (const path of [`/anvil/hook/${SITE}`, `/fornax/hook/${SITE}`]) {
      const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
      const r = Bun.spawnSync(["curl", "-sk", "--max-time", "10", "--resolve", `hook.rn.test:443:${ip}`, "-H", "x-github-event: ping", "-H", `x-hub-signature-256: ${sig}`, "--data-binary", body, `https://hook.rn.test${path}`]);
      expect(JSON.parse(r.stdout.toString())).toEqual({ ok: true, pong: true });
    }
  }, 900_000);

  test("backups keep their history, restore, and certificates renew from the new webroot", async () => {
    expect((await cli("fornax", "backup", "list", SITE)).json.snapshots.map((s: any) => s.id)).toContain(oldSnapshot);
    expect((await cli("fornax", "backup", "run", "srv")).code).toBe(0);
    const r = await cli("fornax", "backup", "restore", SITE, "--snapshot", oldSnapshot, "--only", "db");
    expect(r.code).toBe(0);
    expect(onServer(`mysql -N -e "SELECT t FROM ${r.json.db.restored_into}.notes"`).trim()).toBe("from anvil");
    expect(onServer(`grep -h webroot_path /etc/letsencrypt/renewal/${SITE}.conf`)).toContain("/var/lib/fornax/acme");
    onServer(`REQUESTS_CA_BUNDLE=/opt/pebble/pebble.minica.pem certbot renew --cert-name ${SITE} --force-renewal --quiet`);
    expect((await cli("fornax", "health", "srv")).json.status).not.toBe("crit");
  }, 900_000);
});
