/**
 * Root and the paths in a site user's home, for real: the probe and apply scripts fornax generates run
 * as root in a throwaway Ubuntu container (Docker or OrbStack), against homes with planted symlinks.
 *
 *   bun test test/integration/home-paths.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyScript, parseProbe, probeScript } from "../../src/core/plan.ts";
import { absent, file, type Resource } from "../../src/core/resource.ts";

const IMAGE = process.env.FORNAX_TEST_IMAGE ?? "ubuntu:24.04";
const docker = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const o = { owner: "t" };
const SECRET = "root-only-secret";
const SECRET_SHA = new Bun.CryptoHasher("sha256").update(`${SECRET}\n`).digest("hex");

interface Scenario {
  /** Shell, as root, before the probe. */
  setup: string;
  resources: Resource[];
  /** Shell, as root, after the apply: each line `name command` becomes fact <scenario>.<name>. */
  after?: Record<string, string>;
}

const victim = (dir: string) => `mkdir -p ${dir}/sub && echo ${SECRET} > ${dir}/obsolete && echo ${SECRET} > ${dir}/sub/f && chmod 0600 ${dir}/obsolete`;

const scenarios: Record<string, Scenario> = {
  // the attack: a user links a directory of its home into /etc, and is then deleted without its home
  orphan: {
    setup: `useradd -m orphan; ${victim("/etc/v-orphan")}; su orphan -c 'ln -s /etc/v-orphan ~/config'; userdel orphan`,
    resources: [absent("/home/orphan/config/obsolete", o)],
    after: { kept: "cat /etc/v-orphan/obsolete" },
  },
  orphanRecursive: {
    setup: `useradd -m orphanr; ${victim("/etc/v-orphanr")}; su orphanr -c 'ln -s /etc/v-orphanr ~/config'; userdel orphanr`,
    resources: [absent("/home/orphanr/config/sub", { ...o, recursive: true })],
    after: { kept: "cat /etc/v-orphanr/sub/f" },
  },
  // the same link with its user still there: removed as that user, who may not touch /etc
  present: {
    setup: `useradd -m present; ${victim("/etc/v-present")}; su present -c 'ln -s /etc/v-present ~/config'`,
    resources: [absent("/home/present/config/obsolete", o)],
    after: { kept: "cat /etc/v-present/obsolete" },
  },
  presentOwn: {
    setup: `useradd -m own; su own -c 'echo mine > ~/old.txt; mkdir -p ~/olddir/x && echo mine > ~/olddir/x/f'`,
    resources: [absent("/home/own/old.txt", o), absent("/home/own/olddir", { ...o, recursive: true })],
    after: { left: "ls -A /home/own | grep -v '^\\.' || true", backups: "ls /var/lib/fornax/backup/presentOwn" },
  },
  // a link as the last part of the path goes as a link: what it points to stays
  directLink: {
    setup: `useradd -m links; ${victim("/etc/v-links")}; su links -c 'ln -s /etc/v-links/obsolete ~/file-link; ln -s /etc/v-links/sub ~/dir-link'`,
    resources: [absent("/home/links/file-link", o), absent("/home/links/dir-link", { ...o, recursive: true })],
    after: { kept: "cat /etc/v-links/obsolete /etc/v-links/sub/f", links: "ls -A /home/links | grep link || true" },
  },
  // neither user nor home: nothing there to remove, and nothing looked at as root
  gone: {
    setup: "true",
    resources: [absent("/home/nobody-here/x", o), absent("/home/nobody-here/dir", { ...o, recursive: true })],
  },
  system: {
    setup: "echo old > /etc/fornax-test-old",
    resources: [absent("/etc/fornax-test-old", o)],
    after: { left: "ls /etc/fornax-test-old 2>&1 || true", backup: "cat /var/lib/fornax/backup/system/_etc_fornax-test-old" },
  },
  // the file probe reads as the user too: root's hash of /etc/v-file/obsolete must not show up
  fileProbe: {
    setup: `useradd -m fprobe; ${victim("/etc/v-file")}; su fprobe -c 'ln -s /etc/v-file ~/conf'`,
    resources: [file("/home/fprobe/conf/obsolete", "x\n", { ...o, user: "fprobe:fprobe" })],
    after: { kept: "cat /etc/v-file/obsolete" },
  },
  fileOrphan: {
    setup: `useradd -m forphan; ${victim("/etc/v-forphan")}; su forphan -c 'ln -s /etc/v-forphan ~/conf'; userdel forphan`,
    resources: [file("/home/forphan/conf/obsolete", "x\n", { ...o, user: "forphan:forphan" })],
    after: { kept: "cat /etc/v-forphan/obsolete" },
  },
};

const facts = new Map<string, string>();
const fact = (k: string) => facts.get(k) ?? "";

beforeAll(() => {
  if (!docker) return;
  const dir = mkdtempSync(join(tmpdir(), "fornax-home-"));
  const lines = ["set -u", "mkdir -p /var/lib/fornax", `fact() { printf '@@%s\\t%s\\n' "$1" "$(printf '%s' "$2" | base64 -w0)"; }`];
  for (const [name, s] of Object.entries(scenarios)) {
    writeFileSync(join(dir, `${name}.probe.sh`), probeScript(s.resources));
    writeFileSync(join(dir, `${name}.apply.sh`), applyScript(s.resources));
    lines.push(
      `( ${s.setup} ) >/dev/null 2>&1`,
      `fact ${name}.probe "$(bash /t/${name}.probe.sh)"`,
      `out="$(FORNAX_RUN=${name} bash /t/${name}.apply.sh 2>&1)"; code=$?`,
      `fact ${name}.exit "$code"`,
      `fact ${name}.out "$out"`,
      `fact ${name}.backup-secret "$(grep -rl ${SECRET} /var/lib/fornax/backup/${name} 2>/dev/null)"`,
      ...Object.entries(s.after ?? {}).map(([k, cmd]) => `fact ${name}.${k} "$(${cmd} 2>&1)"`),
    );
  }
  writeFileSync(join(dir, "run.sh"), lines.join("\n") + "\n");
  const p = Bun.spawnSync(["docker", "run", "--rm", "-v", `${dir}:/t`, IMAGE, "bash", "/t/run.sh"], { stdout: "pipe", stderr: "pipe" });
  for (const line of p.stdout.toString().split("\n")) {
    const m = line.match(/^@@([^\t]+)\t(.*)$/);
    if (m) facts.set(m[1]!, Buffer.from(m[2]!, "base64").toString());
  }
  if (!facts.size) throw new Error(`container run failed: ${p.stderr.toString()}`);
}, 300_000);

const states = (name: string) => parseProbe(fact(`${name}.probe`), scenarios[name]!.resources);

describe.skipIf(!docker)("paths in a home, as root in a container", () => {
  test("a user that is gone, with its home and a link into /etc left: the plan stops, the apply fails, /etc keeps its file", () => {
    for (const name of ["orphan", "orphanRecursive"]) {
      expect(() => states(name)).toThrow("user");
      try {
        states(name);
      } catch (e) {
        expect((e as { code?: string }).code).toBe("home_without_user");
      }
      expect(fact(`${name}.exit`)).not.toBe("0");
      expect(fact(`${name}.kept`)).toBe(SECRET);
      expect(fact(`${name}.backup-secret`)).toBe("");
    }
    // the message names user and path, and nothing of what lies behind the link
    expect(fact("orphan.out")).toContain("refusing to touch /home/orphan/config/obsolete as root: user orphan does not exist, but /home/orphan is still there");
    expect(fact("orphan.probe") + fact("orphan.out")).not.toContain(SECRET);
  });

  test("with its user there, the user removes it — and cannot remove root's file behind the link", () => {
    expect(states("present")).toEqual({ "absent:/home/present/config/obsolete": "present" });
    expect(fact("present.exit")).not.toBe("0");
    expect(fact("present.out")).toContain("Permission denied");
    expect(fact("present.kept")).toBe(SECRET);
    expect(fact("present.backup-secret")).toBe("");
  });

  test("the user's own files and directories go, kept as the user's tar", () => {
    expect(fact("presentOwn.exit")).toBe("0");
    expect(fact("presentOwn.left")).toBe("");
    expect(fact("presentOwn.backups").split("\n").sort()).toEqual(["_home_own_old.txt.tar", "_home_own_olddir.tar"]);
  });

  test("a link at the end of the path is removed as a link, also recursively", () => {
    expect(fact("directLink.exit")).toBe("0");
    expect(fact("directLink.links")).toBe("");
    expect(fact("directLink.kept")).toBe(`${SECRET}\n${SECRET}`);
    expect(fact("directLink.backup-secret")).toBe("");
  });

  test("without user and home there is nothing to remove", () => {
    expect(states("gone")).toEqual({ "absent:/home/nobody-here/x": "absent", "absent:/home/nobody-here/dir": "absent" });
    expect(fact("gone.exit")).toBe("0");
  });

  test("a path outside /home goes as before, with root's backup", () => {
    expect(states("system")).toEqual({ "absent:/etc/fornax-test-old": "present" });
    expect(fact("system.exit")).toBe("0");
    expect(fact("system.left")).toContain("No such file");
    expect(fact("system.backup")).toBe("old");
  });

  test("a file in a home is probed as its user: root's hash of what the link reaches never shows", () => {
    const state = states("fileProbe")["file:/home/fprobe/conf/obsolete"]!;
    expect(state).not.toContain(SECRET_SHA);
    expect(fact("fileProbe.kept")).toBe(SECRET);
    expect(() => states("fileOrphan")).toThrow("user forphan does not exist");
    expect(fact("fileOrphan.exit")).not.toBe("0");
    expect(fact("fileOrphan.kept")).toBe(SECRET);
  });
});
