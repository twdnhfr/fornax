/**
 * Backups, 1Password and sudo on OrbStack — no cloud, no real 1Password:
 * - server: a clone of `fornax-base`, reached as user `deploy` with a sudo password from a fake `op`
 * - Storage Box: another clone, SSH/SFTP on port 23, password login, `install-ssh-key`
 * - heartbeat: a local HTTP server the VM reaches via host.orb.internal
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineIp } from "./fakes.ts";

const ROOT = join(import.meta.dir, "..", "..");
const KEY = join(ROOT, ".dev", "id_ed25519");
const ID = Date.now().toString(36);
const SERVER = `fornax-bk-srv-${ID}`;
const BOX = `fornax-bk-box-${ID}`;
const fleet = mkdtempSync(join(tmpdir(), "fornax-bk-"));
const opStore = join(fleet, "op-store.json");
let ip = "";
let boxIp = "";
const heartbeats: string[] = [];
const ntfy: Array<{ title: string; body: string }> = [];
const hb = Bun.serve({
  port: 0,
  hostname: "0.0.0.0",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/ntfy/backups") ntfy.push({ title: req.headers.get("title") ?? "", body: await req.text() });
    else heartbeats.push(path);
    return new Response("ok");
  },
});

const env = { ...process.env, FORNAX_OP_BIN: join(ROOT, "test", "support", "fake-op"), FORNAX_FAKE_OP_STORE: opStore };

async function fornax(...args: string[]) {
  const p = Bun.spawn(["bun", join(ROOT, "src", "cli.ts"), ...args, "--json"], { cwd: fleet, env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    json = { raw: out };
  }
  if (process.env.FORNAX_E2E_VERBOSE) console.error(`$ fornax ${args.join(" ")} → ${code}\n${err}`);
  return { code, json, err };
}

const asRoot = (host: string, script: string) => {
  const p = Bun.spawnSync(["ssh", "-F", "/dev/null", "-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `root@${host}`, "bash -s"], {
    stdin: new Blob([script]),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString() + p.stdout.toString());
  return p.stdout.toString();
};

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

beforeAll(async () => {
  [ip, boxIp] = await Promise.all([machine(SERVER), machine(BOX)]);
  for (let i = 0; i < 30; i++) {
    try {
      asRoot(ip, "true");
      asRoot(boxIp, "true");
      break;
    } catch {
      await Bun.sleep(1000);
    }
  }
  expect(asRoot(boxIp, `bash -s u12345 box-secret-pw <<'X'\n${readFileSync(join(import.meta.dir, "setup-storagebox.sh"), "utf8")}\nX`)).toContain("storage box ready");
  // a non-root login: deploy, sudo with a password
  const pub = readFileSync(`${KEY}.pub`, "utf8").trim();
  asRoot(ip, `useradd -m -s /bin/bash -G sudo deploy; echo 'deploy:deploy-sudo-pw' | chpasswd; install -d -m 700 -o deploy -g deploy /home/deploy/.ssh; echo '${pub}' > /home/deploy/.ssh/authorized_keys; chown deploy: /home/deploy/.ssh/authorized_keys; chmod 600 /home/deploy/.ssh/authorized_keys`);

  writeFileSync(
    opStore,
    JSON.stringify([
      { id: "s1", vault: "Test", title: "sudo deploy", category: "LOGIN", fields: [{ label: "password", type: "CONCEALED", value: "deploy-sudo-pw" }] },
      { id: "s2", vault: "Test", title: "storagebox", category: "LOGIN", fields: [{ label: "password", type: "CONCEALED", value: "box-secret-pw" }] },
      { id: "s3", vault: "Test", title: "healthcheck", category: "LOGIN", fields: [{ label: "url", type: "STRING", value: `http://host.orb.internal:${hb.port}/ping/abc` }] },
    ]),
  );
  writeFileSync(
    join(fleet, "fornax.yaml"),
    `fleet: bk
ssh:
  user: deploy
  sudo_password: op://Test/sudo deploy/password
  config_file: none
  identity_file: ${KEY}
  known_hosts_file: known_hosts
tls:
  issuer: selfsigned
onepassword:
  vault: Infra
backup:
  storage_box:
    host: ${boxIp}
    user: u12345
    password: op://Test/storagebox/password
  heartbeat: op://Test/healthcheck/url
  keep: { daily: 3, weekly: 0, monthly: 0 }
notify:
  ntfy:
    url: http://host.orb.internal:${hb.port}/ntfy/backups
`,
  );
  mkdirSync(join(fleet, "servers"));
  writeFileSync(
    join(fleet, "servers", "srv.yaml"),
    `server: srv
host: ${ip}
php: ["8.4"]
services: [postgres, mysql, supervisor]
tools: []
sites:
  app.test:
    db: { engine: postgres, extensions: [vector] }
  legacy.test:
    db: { engine: mysql }
    backup: { paths: [uploads] }
  forge.test:
    # made by another tool (Forge) with its own password: fornax only backs it up
    user: forgeapp
    db: { engine: mysql, name: forgeapp, user: forge, manage: false }
`,
  );
}, 300_000);

afterAll(() => {
  if (process.env.FORNAX_KEEP_VMS) console.error(`kept: ${SERVER} (${ip}) ${BOX} (${boxIp}), fleet ${fleet}`);
  else for (const m of [SERVER, BOX]) Bun.spawnSync(["orb", "delete", "-f", m]);
  hb.stop(true);
});

const sql = {
  pg: (q: string) => asRoot(ip, `runuser -u postgres -- psql -d app -tAc "${q}"`).trim(),
  my: (q: string) => asRoot(ip, `mysql -N -e "${q}" legacy`).trim(),
};

describe("backups, 1Password and sudo", () => {
  test("everything is provisioned through sudo, the Storage Box key is installed with the box password", async () => {
    const r = await fornax("server", "provision", "srv");
    if (r.code !== 0) console.error(JSON.stringify(r.json, null, 2));
    expect(r.code).toBe(0);
    expect(r.json.in_sync).toBe(true);
    expect(asRoot(boxIp, "cat /home/u12345/.ssh/authorized_keys")).toContain("fornax bk/srv");
  }, 900_000);

  test("generated secrets landed in 1Password, never in the plan files", async () => {
    const store = JSON.parse(readFileSync(opStore, "utf8"));
    const item = store.find((i: any) => i.title === "fornax bk srv");
    expect(item.vault).toBe("Infra");
    const labels = item.fields.filter((f: any) => f.section?.id === "secrets").map((f: any) => f.label).sort();
    expect(labels).toEqual(["db-app-test", "db-legacy-test", "restic", "storagebox-key"]);
    const restic = item.fields.find((f: any) => f.label === "restic").value;
    expect(asRoot(ip, "cat /etc/fornax/secrets/restic").trim()).toBe(restic);
    const planned = Bun.spawnSync(["grep", "-rl", "box-secret-pw", join(fleet, ".fornax")]).stdout.toString();
    expect(planned).toBe("");
    expect((await fornax("secrets", "list", "srv")).json.secrets.every((s: any) => s.in_1password === "same")).toBe(true);
  }, 120_000);

  test("an unmanaged database is left alone: not created, its password untouched", async () => {
    expect(asRoot(ip, `mysql -N -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='forgeapp'"`).trim()).toBe("0");
    // like Forge: database and user with a password fornax never sees
    asRoot(ip, `mysql -e "CREATE DATABASE forgeapp; CREATE USER 'forge'@'%' IDENTIFIED BY 'forge-db-pw'; GRANT ALL ON forgeapp.* TO 'forge'@'%'; CREATE TABLE forgeapp.notes (t text); INSERT INTO forgeapp.notes VALUES ('from forge');"`);
    const plan = await fornax("plan", "srv");
    expect(plan.json.in_sync).toBe(true);
    expect(asRoot(ip, "mysql -uforge -pforge-db-pw -N -e 'SELECT t FROM forgeapp.notes' 2>/dev/null").trim()).toBe("from forge");
  }, 120_000);

  test("backup run: dumps + files to the box, heartbeat pinged", async () => {
    sql.pg("CREATE TABLE notes (t text); INSERT INTO notes VALUES ('keep me');");
    // a table that needs an extension (pgvector) only a superuser can create
    sql.pg("CREATE TABLE embeddings (id int, v vector(3)); INSERT INTO embeddings VALUES (1, '[1,2,3]');");
    // like a hand-made setup: default privileges of the superuser the app's role cannot restore
    sql.pg("ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO app;");
    sql.my("CREATE TABLE notes (t text); INSERT INTO notes VALUES ('keep me too');");
    asRoot(ip, "mkdir -p /home/app/app.test/storage/app && echo upload-1 > /home/app/app.test/storage/app/a.txt && mkdir -p /home/legacy/legacy.test/uploads && echo legacy-file > /home/legacy/legacy.test/uploads/b.txt");
    const r = await fornax("backup", "run", "srv");
    if (r.code !== 0) console.error(JSON.stringify(r.json, null, 2), r.err);
    expect(r.code).toBe(0);
    expect(Object.values(r.json.sites).every((s: any) => s.ok)).toBe(true);
    expect(heartbeats).toContain("/ping/abc");
    const st = await fornax("backup", "status", "srv");
    expect(st.code).toBe(0);
    expect(st.json.sites.map((s: any) => s.site).sort()).toEqual(["app.test", "forge.test", "legacy.test"]);
    expect(ntfy).toEqual([]);
    expect(st.json.next_run).toBeTruthy();
    expect(asRoot(boxIp, "ls /home/u12345/fornax/bk/srv")).toContain("snapshots");
  }, 300_000);

  test("restore side by side leaves live data alone", async () => {
    sql.pg("DELETE FROM notes;");
    asRoot(ip, "rm /home/app/app.test/storage/app/a.txt");
    const list = await fornax("backup", "list", "app.test");
    expect(list.json.snapshots.length).toBe(1);
    const r = await fornax("backup", "restore", "app.test");
    expect(r.code).toBe(0);
    const restoredDb = r.json.db.restored_into as string;
    expect(restoredDb).toMatch(/^app_restore_\d{14}(_\d+)?$/);
    expect(asRoot(ip, `runuser -u postgres -- psql -d ${restoredDb} -tAc "SELECT t FROM notes"`).trim()).toBe("keep me");
    expect(asRoot(ip, `runuser -u postgres -- psql -d ${restoredDb} -tAc "SELECT v FROM embeddings"`).trim()).toBe("[1,2,3]");
    expect(sql.pg("SELECT count(*) FROM notes")).toBe("0");
    expect(asRoot(ip, `cat ${r.json.files.restored_to}/storage/app/a.txt`).trim()).toBe("upload-1");
    expect(asRoot(ip, `stat -c %U ${r.json.files.restored_to}`).trim()).toBe("app");
  }, 300_000);

  test("restore --replace needs the site name and then overwrites", async () => {
    expect((await fornax("backup", "restore", "app.test", "--replace")).json.code).toBe("confirmation_required");
    const r = await fornax("backup", "restore", "app.test", "--replace", "--confirm=app.test");
    expect(r.code).toBe(0);
    expect(sql.pg("SELECT t FROM notes")).toBe("keep me");
    expect(asRoot(ip, "cat /home/app/app.test/storage/app/a.txt").trim()).toBe("upload-1");
    sql.my("DELETE FROM notes;");
    const m = await fornax("backup", "restore", "legacy.test", "--only", "db", "--replace", "--confirm=legacy.test");
    expect(m.code).toBe(0);
    expect(sql.my("SELECT t FROM notes")).toBe("keep me too");
  }, 300_000);

  test("the unmanaged database restores side by side, its user keeps its password", async () => {
    const r = await fornax("backup", "restore", "forge.test", "--only", "db");
    expect(r.code).toBe(0);
    const into = r.json.db.restored_into as string;
    expect(into).toMatch(/^forgeapp_restore_\d{14}(_\d+)?$/);
    expect(asRoot(ip, `mysql -uforge -pforge-db-pw -N -e 'SELECT t FROM ${into}.notes' 2>/dev/null`).trim()).toBe("from forge");
  }, 300_000);

  // a server's name is in its backups (restic host, repository path), its 1Password item and its config:
  // after a rename all of it follows, and what was backed up under the old name stays listed and restorable
  test("rename and back: hostname, fleet, 1Password item and backup repository follow; old snapshots stay", async () => {
    const titles = () => JSON.parse(readFileSync(opStore, "utf8")).filter((i: any) => !i.archived).map((i: any) => i.title);
    const before = (await fornax("backup", "list", "app.test")).json.snapshots;
    const r = await fornax("server", "rename", "srv", "srv2");
    if (r.code !== 0) console.error(JSON.stringify(r.json, null, 2), r.err);
    expect(r.code).toBe(0);
    expect(asRoot(ip, "hostname").trim()).toBe("srv2");
    expect(existsSync(join(fleet, "servers", "srv2.yaml"))).toBe(true);
    expect(existsSync(join(fleet, "servers", "srv.yaml"))).toBe(false);
    expect(readFileSync(join(fleet, "servers", "srv2.yaml"), "utf8")).toContain("former_names:\n  - srv");
    expect(titles()).toContain("fornax bk srv2");
    expect(titles()).not.toContain("fornax bk srv");
    // the repository moved on the box, snapshots and all
    expect(asRoot(boxIp, "ls /home/u12345/fornax/bk").trim()).toBe("srv2");
    expect((await fornax("backup", "list", "app.test")).json.snapshots.map((s: any) => s.id)).toEqual(before.map((s: any) => s.id));
    // new backups go on under the new name, next to the old ones
    expect((await fornax("backup", "run", "srv2", "--site", "app.test")).code).toBe(0);
    const both = (await fornax("backup", "list", "app.test")).json.snapshots;
    expect(both.length).toBe(before.length + 1);
    // a snapshot made under the old name restores
    const old = await fornax("backup", "restore", "app.test", "--snapshot", before[0].id, "--only", "files");
    if (old.code !== 0) console.error(JSON.stringify(old.json, null, 2), old.err);
    expect(old.code).toBe(0);
    expect(asRoot(ip, `cat ${old.json.files.restored_to}/storage/app/a.txt`).trim()).toBe("upload-1");
    // right again, within the same second: a directory of its own, not a clash with the first
    const again = await fornax("backup", "restore", "app.test", "--snapshot", before[0].id, "--only", "files");
    expect(again.code).toBe(0);
    expect(again.json.files.restored_to).not.toBe(old.json.files.restored_to);
    expect((await fornax("plan", "srv2")).json.in_sync).toBe(true);
    // and back again: the repository returns, both names' snapshots stay listed
    const back = await fornax("server", "rename", "srv2", "srv");
    expect(back.code).toBe(0);
    expect(asRoot(ip, "hostname").trim()).toBe("srv");
    expect(readFileSync(join(fleet, "servers", "srv.yaml"), "utf8")).toContain("former_names:\n  - srv2");
    expect(asRoot(boxIp, "ls /home/u12345/fornax/bk").trim()).toBe("srv");
    expect((await fornax("backup", "list", "app.test")).json.snapshots.length).toBe(both.length);
    expect(titles()).toContain("fornax bk srv");
    expect((await fornax("plan", "srv")).json.in_sync).toBe(true);
  }, 600_000);

  test("a failed backup is reported via ntfy", async () => {
    asRoot(ip, `mysql -e "DROP DATABASE forgeapp"`);
    const r = await fornax("backup", "run", "srv");
    expect(r.code).not.toBe(0);
    expect(ntfy).toHaveLength(1);
    expect(ntfy[0]!.title).toBe("srv: backup FAILED (1 of 3 sites)");
    expect(ntfy[0]!.body).toContain("forge.test: mysqldump forgeapp");
  }, 300_000);

  test("a wrong sudo password is a clear error, not a hang", async () => {
    const store = JSON.parse(readFileSync(opStore, "utf8"));
    store.find((i: any) => i.title === "sudo deploy").fields[0].value = "wrong";
    writeFileSync(opStore, JSON.stringify(store));
    const r = await fornax("server", "status", "srv");
    expect(r.json.code).toBe("sudo_failed");
  }, 60_000);
});
