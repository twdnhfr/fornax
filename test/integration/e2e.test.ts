/**
 * End to end on OrbStack, no cloud: a fake Hetzner API clones the OrbStack machine
 * `fornax-base` (Ubuntu 24.04 + sshd + the dev key) as the "new server".
 *
 *   orb create ubuntu:noble fornax-base   # once; install openssh-server, add .dev/id_ed25519.pub for root
 *   bun run test:int
 *
 * Covers: server create → bootstrap → provision → site add (php + static) → TLS via Pebble →
 * dns sync → deploy → webhook-free redeploy → rollback → in-sync plan → server destroy.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCloudflare, fakeHetzner } from "./fakes.ts";
import { q } from "../../src/core/shell.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DEV = join(ROOT, ".dev");
const KEY = join(DEV, "id_ed25519");
const PREFIX = `fornax-e2e-${Date.now().toString(36)}`;
const fleet = mkdtempSync(join(tmpdir(), "fornax-e2e-fleet-"));
// FORNAX_E2E_UBUNTU=26.04 runs the same flow on Ubuntu 26.04 (needs an `fornax-base-2604` machine).
const UBUNTU = process.env.FORNAX_E2E_UBUNTU ?? "24.04";
const PHP = UBUNTU === "24.04" ? "8.4" : "8.5";
const hcloud = fakeHetzner({ token: "fake-hcloud", baseMachine: UBUNTU === "24.04" ? "fornax-base" : `fornax-base-${UBUNTU.replace(".", "")}`, prefix: PREFIX });
const cf = fakeCloudflare({ token: "fake-cf", zones: ["e2e.test"] });
let ip = "";

const opStore = join(fleet, "op-store.json");
const env = {
  ...process.env,
  FORNAX_OP_BIN: join(ROOT, "test", "support", "fake-op"),
  FORNAX_FAKE_OP_STORE: opStore,
  FORNAX_HETZNER_API: hcloud.url,
  FORNAX_CLOUDFLARE_API: cf.url,
  FAKE_HCLOUD: "fake-hcloud",
  FAKE_CF: "fake-cf",
};

// Async on purpose: the fake APIs live in this process and must keep serving while fornax runs.
async function fornax(...args: string[]): Promise<{ code: number; json: any; stderr: string }> {
  const p = Bun.spawn(["bun", join(ROOT, "src", "cli.ts"), ...args, "--json"], { cwd: fleet, env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  let json: any = null;
  try {
    json = JSON.parse(out);
  } catch {
    json = { raw: out };
  }
  if (process.env.FORNAX_E2E_VERBOSE) console.error(`$ fornax ${args.join(" ")} → ${code}\n${err}`);
  return { code, json, stderr: err };
}

/** A plan right after an apply must be empty; if not, show what is left. */
async function expectInSync() {
  const p = await fornax("plan", "e2e");
  if (!p.json.in_sync) console.error(JSON.stringify(p.json.changes, null, 2).slice(0, 4000));
  expect(p.json.in_sync).toBe(true);
}

const sshArgs = () => ["-F", "/dev/null", "-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `root@${ip}`];
const onServer = (script: string) => {
  const p = Bun.spawnSync(["ssh", ...sshArgs(), "bash -s"], { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
};

/** Make a git repo from an example directory and push it into /srv/git/<name>.git on the server. */
function publish(name: string, dir: string, version: string, mutate?: (work: string) => void) {
  const work = mkdtempSync(join(tmpdir(), `fornax-${name}-`));
  cpSync(dir, work, { recursive: true });
  writeFileSync(join(work, "VERSION"), version + "\n");
  mutate?.(work);
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", work, ...a], { env: { ...process.env, GIT_SSH_COMMAND: `ssh ${sshArgs().slice(0, -1).join(" ")}` } });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=e2e@fornax", "-c", "user.name=e2e", "commit", "-qm", version);
  onServer(`mkdir -p /srv/git; [ -d /srv/git/${name}.git ] || git init -q --bare -b main /srv/git/${name}.git; git config --system --add safe.directory /srv/git/${name}.git; chmod -R a+rX /srv/git`);
  const push = git("push", "-q", "--force", `root@${ip}:/srv/git/${name}.git`, "main");
  if (push.exitCode !== 0) throw new Error(push.stderr.toString());
  onServer("chmod -R a+rX /srv/git");
}

const curl = (host: string, path = "/") => {
  const p = Bun.spawnSync(["curl", "-sk", "--max-time", "10", "--resolve", `${host}:443:${ip}`, `https://${host}${path}`]);
  return p.stdout.toString();
};

beforeAll(() => {
  if (!existsSync(KEY)) throw new Error(`missing ${KEY} — see the header of this file`);
  // the dev key as the fleet's SSH key item, as `fornax secrets setup` would have made it
  writeFileSync(
    opStore,
    JSON.stringify([
      {
        id: "fleetkey",
        vault: "Infra",
        title: "e2e fleet ssh",
        category: "SSH_KEY",
        fields: [
          { id: "private_key", label: "private key", type: "SSHKEY", value: readFileSync(KEY, "utf8") },
          { id: "public_key", label: "public key", type: "STRING", value: readFileSync(`${KEY}.pub`, "utf8").trim() },
        ],
      },
    ]),
  );
  writeFileSync(
    join(fleet, "fornax.yaml"),
    `fleet: e2e
access: ssh
ssh:
  user: root
  config_file: none
  # the fleet key from the (fake) vault, held in fornax's own agent — every SSH call of this run uses it
  key: op://Infra/e2e fleet ssh/private key?ssh-format=openssh
  known_hosts_file: known_hosts
policies:
  allowed_repo_owners: [never-matches]
  protected: []
tls:
  issuer: letsencrypt
  email: e2e@example.com
  acme_server: https://localhost:14000/dir
  ca_bundle: /opt/pebble/pebble.minica.pem
dns:
  type: cloudflare
  credentials: env:FAKE_CF
provider_credentials:
  hetzner-cloud: env:FAKE_HCLOUD
onepassword:
  vault: Infra
`,
  );
});

afterAll(() => {
  // FORNAX_E2E_KEEP=1 leaves the machines for a look at /var/log/fornax
  if (!process.env.FORNAX_E2E_KEEP) for (const s of hcloud.servers.values()) Bun.spawnSync(["orb", "delete", "-f", s.machine]);
  hcloud.stop();
  cf.stop();
});

describe("from nothing to a deployed app and back", () => {
  test("catalog comes from the provider", async () => {
    const r = await fornax("provider", "catalog", "hetzner-cloud", "--arch", "arm64");
    expect(r.code).toBe(0);
    expect(r.json.map((x: any) => x.size)).toEqual(["cax11"]);
  });

  test("server create orders a machine and waits for SSH", async () => {
    const r = await fornax("server", "create", "e2e", "--provider", "hetzner-cloud", "--size", "cax11", "--location", "nbg1", "--ubuntu", UBUNTU, "--no-provision");
    expect(r.code).toBe(0);
    ip = r.json.ipv4;
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(hcloud.keys.length).toBe(1);
    // a stray click in the console cannot delete it; `server destroy` lifts the protection itself
    expect([...hcloud.servers.values()].every((s) => s.deleteProtected)).toBe(true);
    // keep the e2e run lean: no MySQL
    const p = join(fleet, "servers", "e2e.yaml");
    writeFileSync(p, readFileSync(p, "utf8") + "services: [postgres, redis, supervisor, fail2ban]\nwebhook: { domain: hook.e2e.test }\n");
  }, 300_000);

  test("bootstrap + provision converge, a second plan is empty", async () => {
    expect((await fornax("server", "bootstrap", "e2e")).code).toBe(0);
    onServer(readFileSync(join(import.meta.dir, "setup-pebble.sh"), "utf8").replace('arch="$1"; shift', 'arch=arm64; set -- app.e2e.test www.app.e2e.test static.e2e.test hook.e2e.test'));
    const r = await fornax("server", "provision", "e2e");
    expect(r.code).toBe(0);
    expect(r.json.in_sync).toBe(true);
    const again = await fornax("plan", "e2e");
    expect(again.json.in_sync).toBe(true);
  }, 900_000);

  test("policies refuse repos of foreign owners", async () => {
    const r = await fornax("site", "add", "e2e", "x.e2e.test", "--repo", "someone/else");
    expect(r.code).toBe(1);
    expect(r.json.code).toBe("policy_violation");
  });

  test("sites: add, plan, apply, deploy", async () => {
    // file:// repos have no owner; this fleet allows none, so lift the policy for local repos
    const y = join(fleet, "fornax.yaml");
    writeFileSync(y, readFileSync(y, "utf8").replace("  allowed_repo_owners: [never-matches]\n", ""));
    publish("demo-php", join(ROOT, "examples", "demo-php"), "v1");
    publish("demo-static", join(ROOT, "examples", "demo-static"), "v1");
    expect((await fornax("site", "add", "e2e", "app.e2e.test", "--repo", "file:///srv/git/demo-php.git", "--preset", "php", "--www")).code).toBe(0);
    expect((await fornax("site", "add", "e2e", "static.e2e.test", "--repo", "file:///srv/git/demo-static.git", "--preset", "static")).code).toBe(0);
    const s = join(fleet, "servers", "e2e.yaml");
    writeFileSync(s, readFileSync(s, "utf8").replace("    preset: php\n", "    preset: php\n    health_check: /health\n"));
    const plan = await fornax("plan", "e2e");
    expect(plan.code).toBe(0);
    expect(plan.json.changes.length).toBeGreaterThan(10);
    const apply = await fornax("apply", plan.json.plan);
    expect(apply.code).toBe(0);
    await expectInSync();
    expect((await fornax("deploy", "app.e2e.test")).json.status).toBe("success");
    expect((await fornax("deploy", "static.e2e.test")).json.status).toBe("success");
    expect(JSON.parse(curl("app.e2e.test")).version).toBe("v1");
    expect(JSON.parse(curl("app.e2e.test")).user).toBe("app");
    expect(curl("static.e2e.test")).toContain("Deployed with fornax");
    expect(curl("static.e2e.test", "/nope")).toContain("404");
    expect(curl("www.app.e2e.test")).toContain("301 Moved Permanently");
  }, 900_000);

  test("a PHP site has a Redis of its own that no other site reaches", async () => {
    expect(onServer("systemctl is-active fornax-redis@app").trim()).toBe("active");
    expect(onServer("systemctl is-active fornax-redis@static || true").trim()).toBe("inactive");
    // phpredis, as the app uses it: a socket path with port 0; FLUSHDB is the site's own
    const php = `$r = new Redis; $r->connect('/run/fornax-redis/app/redis.sock', 0); $r->set('k', 'v'); echo $r->get('k'), ' ', $r->flushDB() ? 'flushed' : 'no';`;
    expect(onServer(`runuser -u app -- php${PHP} -r ${q(php)}`).trim()).toBe("v flushed");
    expect(onServer("runuser -u static -- redis-cli -s /run/fornax-redis/app/redis.sock ping 2>&1 || true")).toMatch(/Permission denied|No such file/);
    // only the shared Redis listens on TCP
    expect(onServer("ss -ltnp | grep redis-server | grep -vc ':6379 ' || true").trim()).toBe("0");
    // switched to the shared one, the own instance stops; switched back, it runs again
    const y = join(fleet, "servers", "e2e.yaml");
    const own = readFileSync(y, "utf8");
    writeFileSync(y, own.replace("    preset: php\n", "    preset: php\n    redis: { instance: shared }\n"));
    expect((await fornax("apply", (await fornax("plan", "e2e")).json.plan)).code).toBe(0);
    expect(onServer("systemctl is-active fornax-redis@app || true").trim()).toBe("inactive");
    await expectInSync();
    writeFileSync(y, own);
    expect((await fornax("apply", (await fornax("plan", "e2e")).json.plan)).code).toBe(0);
    expect(onServer("systemctl is-active fornax-redis@app").trim()).toBe("active");
    await expectInSync();
  });

  test("certificates come from the ACME server and cover all names", async () => {
    const r = await fornax("ssl", "status", "e2e");
    const app = r.json.certificates.find((c: any) => c.names.includes("app.e2e.test"));
    expect(app.names.sort()).toEqual(["app.e2e.test", "www.app.e2e.test"]);
    expect(app.used_by).toContain("app.e2e.test");
    // renewals also work behind a proxy that fetches http:// challenges over https (Cloudflare "Full")
    onServer("mkdir -p /var/lib/fornax/acme/.well-known/acme-challenge && echo token-ok > /var/lib/fornax/acme/.well-known/acme-challenge/probe");
    expect(curl("app.e2e.test", "/.well-known/acme-challenge/probe").trim()).toBe("token-ok");
    expect(curl("www.app.e2e.test", "/.well-known/acme-challenge/probe").trim()).toBe("token-ok");
    expect(curl("www.app.e2e.test", "/x")).toContain("301 Moved Permanently");
    onServer("rm /var/lib/fornax/acme/.well-known/acme-challenge/probe");
  });

  test("a proxy name forwards websockets to a local port and shares the certificate", async () => {
    const y = join(fleet, "servers", "e2e.yaml");
    writeFileSync(y, readFileSync(y, "utf8").replace("    health_check: /health\n", "    health_check: /health\n    proxies:\n      - domain: ws.app.e2e.test\n        port: 9099\n"));
    const plan = await fornax("plan", "e2e");
    expect((await fornax("apply", plan.json.plan)).code).toBe(0);
    // a websocket echo server like Reverb, bound to localhost only
    onServer(`cat > /tmp/ws.ts <<'TS'
Bun.serve({ hostname: "127.0.0.1", port: 9099, fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("plain ok"); }, websocket: { message(ws, m) { ws.send(m); } } });
TS
(nohup bun /tmp/ws.ts > /tmp/ws.log 2>&1 &) ; sleep 1`);
    expect(curl("ws.app.e2e.test")).toBe("plain ok");
    const up = Bun.spawnSync(["curl", "-sk", "--http1.1", "--max-time", "3", "-o", "/dev/null", "-w", "%{http_code}", "-H", "Connection: Upgrade", "-H", "Upgrade: websocket", "-H", "Sec-WebSocket-Version: 13", "-H", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "--resolve", `ws.app.e2e.test:443:${ip}`, "https://ws.app.e2e.test/"]);
    expect(up.stdout.toString()).toBe("101");
    const cert = (await fornax("ssl", "status", "e2e")).json.certificates.find((c: any) => c.names.includes("app.e2e.test"));
    expect(cert.names.sort()).toEqual(["app.e2e.test", "ws.app.e2e.test", "www.app.e2e.test"]);
    onServer("pkill -f /tmp/ws.ts || true");
  }, 300_000);

  test("dns sync points every name at the server, then reports in sync", async () => {
    expect((await fornax("dns", "status", "e2e")).json.in_sync).toBe(false);
    expect((await fornax("dns", "sync", "e2e")).code).toBe(0);
    expect(cf.records.map((r) => r.name).sort()).toEqual(["app.e2e.test", "hook.e2e.test", "static.e2e.test", "ws.app.e2e.test", "www.app.e2e.test"]);
    expect(cf.records.every((r) => r.content === ip && !r.proxied)).toBe(true);
    expect((await fornax("dns", "status", "e2e")).json.in_sync).toBe(true);
  });

  test("redeploy, rollback, history", async () => {
    publish("demo-php", join(ROOT, "examples", "demo-php"), "v2");
    expect((await fornax("deploy", "app.e2e.test")).json.status).toBe("success");
    expect(JSON.parse(curl("app.e2e.test")).version).toBe("v2");
    expect((await fornax("rollback", "app.e2e.test")).code).toBe(0);
    expect(JSON.parse(curl("app.e2e.test")).version).toBe("v1");
    const rel = (await fornax("releases", "app.e2e.test")).json;
    expect(rel.releases.length).toBe(2);
    expect(rel.deploys.map((d: any) => d.status)).toContain("rolled_back");
  }, 300_000);

  test("a release that fails its health check never goes live", async () => {
    publish("demo-php", join(ROOT, "examples", "demo-php"), "v3-broken", (w) => {
      const f = join(w, "public", "index.php");
      writeFileSync(f, readFileSync(f, "utf8").replace("echo json_encode(['ok' => true]);", "http_response_code(500); echo 'broken';"));
    });
    const seen = new Set<string>();
    const watch = setInterval(() => {
      try {
        seen.add(JSON.parse(curl("app.e2e.test")).version);
      } catch {
        seen.add("error");
      }
    }, 150);
    const r = await fornax("deploy", "app.e2e.test");
    clearInterval(watch);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("before activation");
    expect([...seen]).toEqual(["v1"]);
    expect((await fornax("releases", "app.e2e.test")).json.releases.length).toBe(2);
  }, 300_000);

  // a compromised app runs as its site user: whatever it plants in its home must not reach root's files
  test("a site user cannot reach root's files through symlinks in its home", async () => {
    const app = (cmd: string) => onServer(`runuser -u app -- bash -c ${JSON.stringify(cmd)}`);
    // deploy logs live outside the home, root-owned
    expect(onServer("stat -c '%U:%G %a' /var/log/fornax-sites/app/deploys").trim()).toBe("root:app 750");
    // nginx does not serve a file of another owner through a link
    // (the request falls through to the app instead)
    app("ln -sfn /etc/hostname /home/app/app.e2e.test/current/public/leak.txt");
    expect(curl("app.e2e.test", "/leak.txt")).not.toContain(onServer("cat /etc/hostname").trim());
    expect(onServer("tail -1 /var/log/nginx/app.e2e.test-error.log")).toContain("symbolic link");
    // reading the site's .env goes through the site user: a link to /etc/shadow yields nothing
    app("ln -sfn /etc/shadow /home/app/app.e2e.test/.env");
    const pull = await fornax("env", "pull", "app.e2e.test");
    expect(pull.code).toBe(1);
    expect(pull.json.code).toBe("no_env");
    // deploy history from before the move: regular files come along, a planted link does not
    app("mkdir -p ~/.fornax/deploys && echo '{}' > ~/.fornax/deploys/20200101000000.json && ln -s /etc/shadow ~/.fornax/deploys/20200101000001.json");
    const plan = await fornax("plan", "e2e");
    expect(plan.json.changes.map((c: any) => c.id)).toContain("check:deploy-logs:app");
    expect((await fornax("apply", plan.json.plan)).code).toBe(0);
    expect(onServer("cd /var/log/fornax-sites/app/deploys && stat -c '%F %U' 20200101000000.json; ls 20200101000001.json 2>&1 || true; ls -d /home/app/.fornax/deploys 2>&1 || true")).toMatch(/regular file root[\s\S]*No such file[\s\S]*No such file/);
    app("rm -f /home/app/app.e2e.test/current/public/leak.txt /home/app/app.e2e.test/.env");
  }, 300_000);

  test("apply guards: stale plans, a held lock, and hand-made firewall rules", async () => {
    onServer("ufw allow 8080/tcp >/dev/null");
    const plan = (await fornax("plan", "e2e")).json;
    expect(plan.changes.map((c: any) => c.id)).toEqual(["check:ufw"]);
    onServer("ufw allow 8081/tcp >/dev/null");
    expect((await fornax("apply", plan.plan)).json.code).toBe("plan_stale");
    const fresh = (await fornax("plan", "e2e")).json;
    onServer('echo "plan other" > /run/lock/fornax-apply.owner; nohup flock /run/lock/fornax-apply.lock sleep 6 >/dev/null 2>&1 &');
    await Bun.sleep(500);
    expect((await fornax("apply", fresh.plan)).json.code).toBe("apply_locked");
    await Bun.sleep(6500);
    expect((await fornax("apply", fresh.plan)).code).toBe(0);
    expect(onServer("ufw show added")).not.toContain("808");
    await expectInSync();
    // and /etc's history says how it went: the hand-made rules as a commit of their own, then fornax undoing them
    const h = (await fornax("history", "e2e", "--path", "ufw")).json.commits;
    expect(h[0]).toMatchObject({ kind: "fornax", files: expect.arrayContaining(["ufw/user.rules"]) });
    expect(h[0].by).toBeTruthy();
    expect(h[1].kind).toBe("outside");
    expect((await fornax("history", "e2e", "--show", h[1].commit)).json.text).toContain("allow tcp 8080");
    // keys and secrets never enter it
    expect(onServer("git -C /etc ls-files -- fornax/secrets fornax/tls ssh/ssh_host_ed25519_key | wc -l").trim()).toBe("0");
  }, 300_000);

  test("explain and status answer from the live server", async () => {
    const e = (await fornax("explain", "app.e2e.test")).json;
    expect(e.live.user_exists).toBe(true);
    expect(e.live.fpm_socket).toBe(`/run/php/php${PHP}-fpm-app-e2e-test.sock`);
    const st = (await fornax("server", "status", "e2e")).json;
    // the deliberately broken deploy above is the only thing worth a warning
    // (OrbStack's 26.04 image fails systemd-networkd-wait-online by itself — not fornax's doing)
    const warnings = st.warnings.filter((w: string) => w !== "failed units: systemd-networkd-wait-online.service");
    expect(warnings).toEqual(["last deploy of app.e2e.test failed — fornax logs app.e2e.test deploy (clears with the next successful deploy)"]);
    expect(st.public_ports).toEqual(expect.arrayContaining(["22", "80", "443"]));
    // databases, redis, php-fpm and the webhook are never on a public address
    for (const p of ["3306", "5432", "6379", "9300"]) expect(st.public_ports).not.toContain(p);
  });

  test("deploy brings an older fornax on the server up to date first, but never downgrades a newer one", async () => {
    const sha = () => onServer("sha256sum /usr/local/bin/fornax | cut -c1-64").trim();
    const current = sha();
    onServer("cp -p /usr/local/bin/fornax /usr/local/bin/fornax.real");
    // an older build: no build stamp, different content
    // written next to it and moved in: the running webhook keeps the file busy for plain writes
    onServer(`printf '#!/bin/sh\\n[ "$1" = --version ] && { echo "{\\\\"version\\\\":\\\\"0.0.9\\\\"}"; exit 0; }\\nexec /usr/local/bin/fornax.real "$@"\\n' > /usr/local/bin/fornax.fake && chmod 755 /usr/local/bin/fornax.fake && mv -f /usr/local/bin/fornax.fake /usr/local/bin/fornax`);
    // the static site: the app's repo is left broken on purpose by the test above
    const up = await fornax("deploy", "static.e2e.test");
    expect(up.json.status).toBe("success");
    expect(up.stderr).toContain("updated fornax on e2e");
    expect(sha()).toBe(current);
    // a newer build (e.g. installed from another machine) stays
    onServer(`printf '#!/bin/sh\\n[ "$1" = --version ] && { echo "{\\\\"version\\\\":\\\\"9.0.0\\\\",\\\\"build\\\\":\\\\"2999-01-01T00:00:00Z\\\\"}"; exit 0; }\\nexec /usr/local/bin/fornax.real "$@"\\n' > /usr/local/bin/fornax.fake && chmod 755 /usr/local/bin/fornax.fake && mv -f /usr/local/bin/fornax.fake /usr/local/bin/fornax`);
    const keep = await fornax("deploy", "static.e2e.test");
    expect(keep.json.status).toBe("success");
    expect(keep.stderr).toContain("is newer (build 2999-01-01T00:00:00Z)");
    expect(sha()).not.toBe(current);
    onServer("mv -f /usr/local/bin/fornax.real /usr/local/bin/fornax");
  }, 600_000);

  test("health gives one verdict: sites, certificates and daemons ok, the failed deploy a warning", async () => {
    const h = await fornax("health", "e2e");
    const checks = Object.fromEntries(h.json.servers[0].checks.map((c: any) => [c.check, c]));
    expect(checks.sites.level).toBe("ok");
    expect(checks.certificates.level).toBe("ok");
    expect(checks.disk.level).toBe("ok");
    expect(checks["last deploys"].level).toBe("warn");
    // something broken on the server turns the verdict critical
    onServer(`systemctl stop php${PHP}-fpm`);
    const bad = await fornax("health", "e2e");
    onServer(`systemctl start php${PHP}-fpm`);
    expect(bad.code).toBe(2);
    const badChecks = Object.fromEntries(bad.json.servers[0].checks.map((c: any) => [c.check, c]));
    expect(badChecks.services.detail).toContain(`php${PHP}-fpm`);
    expect(badChecks.sites.level).toBe("crit");
  }, 120_000);

  test("server rename: provider, hostname, fleet and 1Password follow; the sites keep deploying", async () => {
    const r = await fornax("server", "rename", "e2e", "e2e-renamed");
    if (r.code !== 0) console.error(JSON.stringify(r.json, null, 2), r.stderr);
    expect(r.code).toBe(0);
    expect([...hcloud.servers.values()][0]!.name).toBe("e2e-renamed");
    expect(onServer("hostname").trim()).toBe("e2e-renamed");
    expect(existsSync(join(fleet, "servers", "e2e.yaml"))).toBe(false);
    expect(JSON.parse(readFileSync(opStore, "utf8")).some((i: any) => i.title === "fornax e2e e2e-renamed")).toBe(true);
    // everything that runs under the server's name still works under the new one
    const plan = await fornax("plan", "e2e-renamed");
    if (!plan.json.in_sync) console.error(JSON.stringify(plan.json.changes, null, 2).slice(0, 3000));
    expect(plan.json.in_sync).toBe(true);
    // (the repo still holds the broken v3 from the health check test)
    publish("demo-php", join(ROOT, "examples", "demo-php"), "v4");
    expect((await fornax("deploy", "app.e2e.test")).json.status).toBe("success");
    expect(JSON.parse(curl("app.e2e.test")).version).toBe("v4");
    expect((await fornax("health", "e2e-renamed")).json.servers[0].server).toBe("e2e-renamed");
    // the old name is gone for good
    expect((await fornax("plan", "e2e")).json.code).toBe("unknown_server");
  }, 300_000);

  test("server destroy needs the exact name and deletes the machine", async () => {
    expect((await fornax("server", "destroy", "e2e-renamed")).json.code).toBe("confirmation_required");
    const before = JSON.parse(readFileSync(opStore, "utf8")).find((i: any) => i.title === "fornax e2e e2e-renamed");
    expect(before.fields.some((f: any) => f.label === "redis")).toBe(true);
    const r = await fornax("server", "destroy", "e2e-renamed", "--confirm=e2e-renamed");
    expect(r.code).toBe(0);
    expect(r.json.secrets).toEqual({ archived: true, item: "Infra/fornax e2e e2e-renamed" });
    expect(JSON.parse(readFileSync(opStore, "utf8")).find((i: any) => i.title === "fornax e2e e2e-renamed").archived).toBe(true);
    expect(hcloud.servers.size).toBe(0);
    expect(existsSync(join(fleet, "servers", "e2e-renamed.yaml"))).toBe(false);
  }, 120_000);
});
