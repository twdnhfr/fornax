import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FornaxError } from "../../src/core/errors.ts";
import { assertVerified, splitSignature, verifyRange } from "../../src/core/peers.ts";

// git must not read the developer's own config (signing program, hooks, identity)
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const keys = mkdtempSync(join(tmpdir(), "fornax-peer-keys-"));
const key = (name: string) => {
  Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", name, "-f", join(keys, name)]);
  return readFileSync(join(keys, `${name}.pub`), "utf8").trim();
};

let laptop: string, phone: string, attacker: string;
beforeAll(() => {
  laptop = key("laptop");
  phone = key("phone");
  attacker = key("attacker");
});

/** A fleet repo whose commits are made and (optionally) signed with the named key. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "fornax-peer-repo-"));
  const g = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
    return p.stdout.toString().trim();
  };
  g("init", "-q", "-b", "main");
  const write = (signers: string[], rootKeys: string[] = []) => {
    writeFileSync(join(dir, "fornax.yaml"), `fleet: t\npeers:\n  enabled: true\n  signers:\n${signers.map((s) => `    - ${s}`).join("\n")}\n`);
    mkdirSync(join(dir, "servers"), { recursive: true });
    writeFileSync(join(dir, "servers", "web-1.yaml"), `server: web-1\nhost: 192.0.2.10\nssh:\n  root_keys:\n${rootKeys.map((k) => `    - ${k}`).join("\n") || "    []"}\n`);
  };
  const commit = (msg: string, signer?: string) => {
    g("add", "-A");
    const sign = signer ? ["-c", `user.signingkey=${join(keys, signer)}`, "commit", "-q", "-S", "--allow-empty", "-m", msg] : ["commit", "-q", "--allow-empty", "-m", msg];
    g(...sign);
    return g("rev-parse", "HEAD");
  };
  return { dir, g, write, commit };
}

describe("peers: commit signatures", () => {
  test("splitting a signed commit gives back exactly what git signed", () => {
    const r = repo();
    r.write([laptop]);
    r.commit("start", "laptop");
    const raw = Bun.spawnSync(["git", "-C", r.dir, "cat-file", "commit", "HEAD"]).stdout.toString();
    const { payload, signature } = splitSignature(raw);
    expect(signature).toContain("BEGIN SSH SIGNATURE");
    expect(payload).not.toContain("gpgsig");
    expect(payload.endsWith("start\n")).toBe(true);
  });

  test("commits signed by a signer hold, and say who signed", () => {
    const r = repo();
    r.write([laptop, phone]);
    const anchor = r.commit("start", "laptop");
    r.write([laptop, phone], ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2fake root"]);
    r.commit("a root key", "phone");
    r.write([laptop, phone], []);
    const head = r.commit("root key gone", "laptop");
    const checks = verifyRange(r.dir, anchor, head);
    expect(checks.map((c) => [c.ok, c.signer])).toEqual([
      [true, "phone"],
      [true, "laptop"],
    ]);
    expect(checks.every((c) => c.trustChange)).toBe(true);
  });

  test("a commit signed with a key that logs in as root is marked: it could come from a host", () => {
    const r = repo();
    r.write([laptop, phone], [phone]);
    const anchor = r.commit("start", "laptop");
    r.commit("from the laptop", "laptop");
    const head = r.commit("from a host, with the forwarded key", "phone");
    expect(verifyRange(r.dir, anchor, head).map((c) => c.viaLoginKey)).toEqual([false, true]);
    // no root keys named: any signature may have travelled
    const r2 = repo();
    r2.write([laptop]);
    const a2 = r2.commit("start", "laptop");
    const h2 = r2.commit("change", "laptop");
    expect(verifyRange(r2.dir, a2, h2)[0]!.viaLoginKey).toBe(true);
  });

  test("an unsigned commit is refused (unsigned_fleet)", () => {
    const r = repo();
    r.write([laptop]);
    const anchor = r.commit("start", "laptop");
    const head = r.commit("unsigned change");
    expect(verifyRange(r.dir, anchor, head)[0]).toMatchObject({ ok: false, reason: "not signed" });
    expect(() => assertVerified(r.dir, anchor, head)).toThrow(expect.objectContaining({ code: "unsigned_fleet" }) as unknown as Error);
  });

  test("a commit signed by someone else is refused (not_a_signer)", () => {
    const r = repo();
    r.write([laptop]);
    const anchor = r.commit("start", "laptop");
    const head = r.commit("change", "attacker");
    expect(() => assertVerified(r.dir, anchor, head)).toThrow(expect.objectContaining({ code: "not_a_signer" }) as unknown as Error);
  });

  test("a key cannot sign itself in: the parent's signers decide", () => {
    const r = repo();
    r.write([laptop]);
    const anchor = r.commit("start", "laptop");
    r.write([laptop, attacker]);
    const head = r.commit("add me", "attacker");
    const [c] = verifyRange(r.dir, anchor, head);
    expect(c).toMatchObject({ ok: false, trustChange: true });
  });

  test("a key added by a signer counts from the next commit on", () => {
    const r = repo();
    r.write([laptop]);
    const anchor = r.commit("start", "laptop");
    r.write([laptop, phone]);
    r.commit("add the phone", "laptop");
    const head = r.commit("first from the phone", "phone");
    expect(verifyRange(r.dir, anchor, head).map((c) => c.ok)).toEqual([true, true]);
  });

  test("a removed key no longer counts", () => {
    const r = repo();
    r.write([laptop, phone]);
    const anchor = r.commit("start", "laptop");
    r.write([laptop]);
    r.commit("phone lost", "laptop");
    const head = r.commit("after the loss", "phone");
    expect(verifyRange(r.dir, anchor, head).map((c) => c.ok)).toEqual([true, false]);
  });

  test("an older state, or one off to the side, is refused (fleet_rollback)", () => {
    const r = repo();
    r.write([laptop]);
    const old = r.commit("start", "laptop");
    const trusted = r.commit("newer", "laptop");
    expect(() => verifyRange(r.dir, trusted, old)).toThrow(FornaxError);
    try {
      verifyRange(r.dir, trusted, old);
    } catch (e) {
      expect((e as FornaxError).code).toBe("fleet_rollback");
    }
  });

  test("a merge commit is refused: the history is linear", () => {
    const r = repo();
    r.write([laptop]);
    const anchor = r.commit("start", "laptop");
    r.g("checkout", "-q", "-b", "side");
    r.commit("side", "laptop");
    r.g("checkout", "-q", "main");
    r.commit("main", "laptop");
    r.g("-c", `user.signingkey=${join(keys, "laptop")}`, "merge", "-q", "-S", "--no-edit", "side");
    const head = r.g("rev-parse", "HEAD");
    expect(verifyRange(r.dir, anchor, head).some((c) => !c.ok)).toBe(true);
  });
});

describe("--on", () => {
  test("takes the server out and leaves the command for the host", async () => {
    const { splitOn } = await import("../../src/cli.ts");
    expect(splitOn(["--on", "web-1", "plan", "web-2", "--json"])).toEqual({ server: "web-1", fleetDir: undefined, rest: ["plan", "web-2", "--json"] });
    expect(splitOn(["plan", "web-2", "--on=web-1"])).toEqual({ server: "web-1", fleetDir: undefined, rest: ["plan", "web-2"] });
    // --fleet names this machine's fleet; the host uses its own copy
    expect(splitOn(["--fleet", "/f", "--on", "web-1", "apply", "p1"])).toEqual({ server: "web-1", fleetDir: "/f", rest: ["apply", "p1"] });
    // after -- it belongs to the command run there
    expect(splitOn(["run", "web-1", "--", "echo", "--on", "x"])).toBeUndefined();
    expect(() => splitOn(["--on"])).toThrow(FornaxError);
  });
});

describe("the fleet repo on a server", () => {
  test("its setup leaves /var/lib/fornax as the server module keeps it (the webhook and ACME live below it)", async () => {
    const { peerRepoScript } = await import("../../src/modules/peers.ts");
    const script = peerRepoScript("web-1");
    expect(script).not.toMatch(/install -d -m 0700[^\n]*\/var\/lib\/fornax(\s|$)/m);
    expect(script).toContain('install -d -m 0700 -o root -g root "$d"');
  });
});
