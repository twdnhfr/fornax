/**
 * The backup agent and the paths in a site user's home, for real: `fornax backup-agent` (built for
 * Linux) runs as root in a throwaway Ubuntu container (Docker or OrbStack) with restic and a local
 * repository, against homes with planted symlinks.
 *
 *   bun test test/integration/backup-home.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupRuntime } from "../../src/modules/backup.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BASE = process.env.FORNAX_TEST_IMAGE ?? "ubuntu:24.04";
const IMAGE = "fornax-test-backup";
const docker = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const SECRET = "root-only-secret";

const site = (domain: string, user: string, paths: string[], db: BackupRuntime["sites"][number]["db"] = null) => {
  const root = `/home/${user}/${domain}`;
  return { domain, user, root, db, paths: paths.map((p) => `${root}/${p}`) };
};

const config: BackupRuntime = {
  version: 1,
  fleet: "t",
  server: "srv",
  repository: "/srv/repo",
  sftp_command: "false",
  password_file: "/etc/fornax/secrets/restic",
  keep: { daily: 7, weekly: 0, monthly: 0 },
  heartbeat_file: null,
  staging: "/var/lib/fornax/backup-staging",
  sites: [
    // a link on the way to a backup path (uploads → a directory of root's), and one as the last part of a path
    site("shop.test", "shop", ["storage", ".env", "uploads/files"], { engine: "mysql", name: "shop", user: "shop" }),
    // a shared path swapped for a link into /etc
    site("blog.test", "blog", ["storage", ".env"]),
    // a file of root's in the user's storage (say, a log written by `artisan` run as root): not the user's to read
    site("logs.test", "logs", ["storage", ".env"]),
    // the user is gone, its home and a link in it are left
    site("gone.test", "gone", ["storage", ".env"]),
  ],
};

const SETUP = `
mkdir -p /etc/fornax/backup /etc/fornax/secrets /var/lib/fornax/backup-staging /srv/repo
cp /t/config.json /etc/fornax/backup/config.json
( umask 077; echo restic-pw > /etc/fornax/secrets/restic )
RESTIC_PASSWORD_FILE=/etc/fornax/secrets/restic restic -q -r /srv/repo init
# mysqldump and mysql stand-ins: a known dump, and the import kept where the test can read it
printf '#!/bin/bash\\nprintf -- "-- dump of shop\\\\nCREATE DATABASE \\\\x60shop\\\\x60;\\\\nUSE \\\\x60shop\\\\x60;\\\\n"; seq 1 2000 | sed "s/^/INSERT INTO notes VALUES (/; s/$/);/"\\n' > /usr/local/bin/mysqldump
printf '#!/bin/bash\\nif [ $# -eq 0 ]; then cat > /var/tmp/mysql-import.sql; else case "$*" in *SELECT*) echo localhost;; esac; fi\\n' > /usr/local/bin/mysql
chmod +x /usr/local/bin/mysqldump /usr/local/bin/mysql
victim() { mkdir -p "$1/files" && echo ${SECRET} > "$1/files/secret" && echo ${SECRET} > "$1/secret" && chmod 0600 "$1/secret" "$1/files/secret"; }

victim /etc/v-shop; chmod 0700 /etc/v-shop
useradd -m shop
su shop -c 'mkdir -p ~/shop.test/storage/app && echo upload-1 > ~/shop.test/storage/app/a.txt && echo APP_KEY=shop > ~/shop.test/.env && ln -s /etc/v-shop ~/shop.test/uploads && ln -s /etc/v-shop/files/secret ~/shop.test/storage/app/key'

victim /etc/v-blog
useradd -m blog
su blog -c 'mkdir -p ~/blog.test && echo APP_KEY=blog > ~/blog.test/.env && ln -s /etc/v-blog ~/blog.test/storage'

useradd -m logs
su logs -c 'mkdir -p ~/logs.test/storage/logs && echo own-log > ~/logs.test/storage/logs/app.log && echo APP_KEY=logs > ~/logs.test/.env'
echo ${SECRET} > /home/logs/logs.test/storage/logs/root.log; chmod 0600 /home/logs/logs.test/storage/logs/root.log

victim /etc/v-gone
useradd -m gone
su gone -c 'mkdir -p ~/gone.test && ln -s /etc/v-gone ~/gone.test/storage && echo APP_KEY=gone > ~/gone.test/.env'
userdel gone
`;

const RUN = `
out="$(/t/fornax backup-agent run --json 2>&1)"; fact run.exit "$?"; fact run.out "$out"
export RESTIC_PASSWORD_FILE=/etc/fornax/secrets/restic
fact snapshots "$(restic -r /srv/repo snapshots --json)"
for id in $(restic -r /srv/repo snapshots --json | grep -o '"short_id":"[^"]*"' | cut -d'"' -f4); do restic -q -r /srv/repo restore "$id" --target "/var/tmp/check/$id"; done
for f in /var/tmp/check/*/*.tar; do fact "list.$(basename "$f" .tar)" "$(tar -tvf "$f")"; done
# root's files: in no snapshot, and where they were
fact leaked "$(grep -rla ${SECRET} /var/tmp/check)"
fact kept "$(cat /etc/v-shop/files/secret /etc/v-blog/secret /etc/v-gone/secret /home/logs/logs.test/storage/logs/root.log)"
# the database comes back from fornax's own first member; the files are left to the next step
out="$(/t/fornax backup-agent restore shop.test --db --json 2>&1)"; fact db.exit "$?"; fact db.out "$out"
fact db.import "$(cat /var/tmp/mysql-import.sql)"
fact db.dump "$(mysqldump --databases shop)"
out="$(/t/fornax backup-agent restore shop.test --files --json 2>&1)"; fact files.exit "$?"; fact files.out "$out"
`;

const facts = new Map<string, string>();
const fact = (k: string) => facts.get(k) ?? "";

beforeAll(() => {
  if (!docker) return;
  const dir = mkdtempSync(join(tmpdir(), "fornax-backup-home-"));
  const build = Bun.spawnSync(["docker", "build", "-q", "-t", IMAGE, "-"], {
    stdin: new Blob([`FROM ${BASE}\nRUN apt-get update && apt-get install -y --no-install-recommends restic && rm -rf /var/lib/apt/lists/*\n`]),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(`docker build failed: ${build.stderr.toString()}`);
  const arch = Bun.spawnSync(["docker", "info", "--format", "{{.Architecture}}"]).stdout.toString().trim();
  const target = /arm|aarch/.test(arch) ? "bun-linux-arm64" : "bun-linux-x64";
  const bin = Bun.spawnSync(["bun", "build", "--compile", `--target=${target}`, join(ROOT, "src", "cli.ts"), "--outfile", join(dir, "fornax")], { stdout: "pipe", stderr: "pipe" });
  if (bin.exitCode !== 0) throw new Error(`bun build failed: ${bin.stderr.toString()}`);
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  const script = ["set -u", `fact() { printf '@@%s\\t%s\\n' "$1" "$(printf '%s' "$2" | base64 -w0)"; }`, `( ${SETUP} ) >/dev/null 2>&1`, RUN].join("\n");
  writeFileSync(join(dir, "run.sh"), script);
  const p = Bun.spawnSync(["docker", "run", "--rm", "-v", `${dir}:/t`, IMAGE, "bash", "/t/run.sh"], { stdout: "pipe", stderr: "pipe" });
  for (const line of p.stdout.toString().split("\n")) {
    const m = line.match(/^@@([^\t]+)\t(.*)$/);
    if (m) facts.set(m[1]!, Buffer.from(m[2]!, "base64").toString());
  }
  if (!facts.size) throw new Error(`container run failed: ${p.stderr.toString()}`);
  if (process.env.FORNAX_E2E_VERBOSE) for (const [k, v] of facts) console.error(`--- ${k}\n${v}`);
}, 600_000);

/** The JSON `backup-agent run` prints after its log lines. */
const run = () => JSON.parse(fact("run.out").slice(fact("run.out").indexOf("\n{") + 1)) as { ok: boolean; sites: Record<string, { ok: boolean; snapshot?: string; files?: number; error?: string }> };

describe.skipIf(!docker)("backups of paths in a home, as root in a container", () => {
  test("root's files behind the links are in no snapshot, and stay where they are", () => {
    expect(fact("leaked")).toBe("");
    expect(fact("kept")).toBe(Array(4).fill(SECRET).join("\n"));
  });

  test("a site's snapshot is fornax's dump first, then the user's files — a link kept as a link, a path behind a link of root's left out", () => {
    const r = run().sites["shop.test"]!;
    expect(r.ok).toBe(true);
    const list = fact("list.shop.test").split("\n");
    expect(list[0]).toMatch(/^-rw------- root\/root .* fornax\/db\.sql$/);
    expect(list.some((l) => l.endsWith(" home/shop/shop.test/storage/app/a.txt"))).toBe(true);
    expect(list.some((l) => l.endsWith(" home/shop/shop.test/.env"))).toBe(true);
    expect(list.some((l) => l.endsWith(" home/shop/shop.test/storage/app/key -> /etc/v-shop/files/secret"))).toBe(true);
    expect(list.some((l) => l.includes("uploads"))).toBe(false);
    expect(r.files).toBe(3);
    expect(JSON.parse(fact("snapshots")).find((s: { tags: string[] }) => s.tags.includes("site:shop.test")).paths).toEqual(["/shop.test.tar"]);
  });

  test("a shared path swapped for a link into /etc goes into the snapshot as that link", () => {
    expect(run().sites["blog.test"]!.ok).toBe(true);
    const list = fact("list.blog.test");
    expect(list).toMatch(/^drwx------ root\/root .* fornax\/$/m);
    expect(list).toContain("home/blog/blog.test/storage -> /etc/v-blog");
    expect(list).not.toContain("secret");
  });

  test("a file in the home the user cannot read fails the backup, loudly, and stays out", () => {
    const r = run().sites["logs.test"]!;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("files of logs: tar: home/logs/logs.test/storage/logs/root.log: Cannot open: Permission denied");
    // the rest is in the snapshot
    expect(fact("list.logs.test")).toContain("home/logs/logs.test/storage/logs/app.log");
    expect(fact("list.logs.test")).not.toContain("root.log");
  });

  test("a site whose user is gone is not backed up, not as root either", () => {
    const r = run().sites["gone.test"]!;
    expect(r.ok).toBe(false);
    expect(r.error).toBe("refusing to back up gone.test: user gone does not exist, and its files are read only as that user");
    expect(fact("list.gone.test")).toBe("");
    expect(fact("run.exit")).toBe("1");
  });

  test("the database restores from fornax's own member; the files wait for the next step", () => {
    expect(fact("db.exit")).toBe("0");
    const db = JSON.parse(fact("db.out")) as { db: { restored_into: string } };
    expect(db.db.restored_into).toMatch(/^shop_restore_\d{14}$/);
    expect(fact("db.import")).toBe(fact("db.dump").replaceAll("`shop`", `\`${db.db.restored_into}\``));
    expect(fact("files.exit")).not.toBe("0");
    expect(JSON.parse(fact("files.out")).error).toContain("were packed by shop");
  });
});
