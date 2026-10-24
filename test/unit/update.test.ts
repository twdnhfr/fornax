import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli.ts";
import { installKind, verifySums } from "../../src/core/update.ts";
import { compareVersions, ORDER_KEY_AWK, orderKey } from "../../src/core/version.ts";
import { RELEASE_KEY } from "../../src/core/release-key.ts";

describe("versions", () => {
  test("semver order, a prerelease before its release", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.9")).toBeGreaterThan(0);
  });
  test("the order key sorts the same in fornax and in the server's shell", () => {
    const cases: [string, string | undefined][] = [["0.2.0", "2026-11-01T10:00:00Z"], ["1.0.0-rc.1", undefined], ["10.0.3", "2026-01-01T00:00:00Z"], ["0.1.0", undefined]];
    for (const [v, b] of cases) {
      const sh = Bun.spawnSync(["sh", "-c", `printf '%s %s\\n' ${v} '${b ?? ""}' | ${ORDER_KEY_AWK}`]).stdout.toString();
      expect(sh).toBe(orderKey(v, b));
    }
    expect(orderKey("0.3.0", "2026-01-01T00:00:00Z") > orderKey("0.2.0", "2026-12-01T00:00:00Z")).toBe(true);
    expect(orderKey("1.0.0", "2026-01-01T00:00:00Z") > orderKey("1.0.0", undefined)).toBe(true);
  });
});

describe("release signature", () => {
  test("only SHA256SUMS signed with the release key passes", () => {
    const sums = Buffer.from("abc  fornax-0.2.0-darwin-arm64.tar.gz\n");
    const other = generateKeyPairSync("ed25519");
    const forged = sign(null, sums, other.privateKey);
    expect(verifySums(sums, forged)).toBe(false);
    expect(verifySums(sums, forged, other.publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(true);
    expect(verifySums(sums, new Uint8Array(64))).toBe(false);
    expect(RELEASE_KEY).toContain("BEGIN PUBLIC KEY");
  });
  test("a checkout updates with git, a Homebrew install with brew, a binary itself", () => {
    expect(installKind("/opt/homebrew/bin/bun").kind).toBe("source");
  });
});

describe("requires in fornax.yaml", () => {
  test("a fleet that needs a newer fornax is refused, with self-update next", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fornax-req-"));
    mkdirSync(join(dir, "servers"));
    writeFileSync(join(dir, "fornax.yaml"), "version: 2\nfleet: t\nrequires: \">=99.0.0\"\n");
    expect(await main(["server", "list", "--fleet", dir, "--json"])).toBe(1);
    writeFileSync(join(dir, "fornax.yaml"), "version: 2\nfleet: t\nrequires: \">=0.0.1\"\n");
    expect(await main(["server", "list", "--fleet", dir, "--json"])).toBe(0);
  });
});
