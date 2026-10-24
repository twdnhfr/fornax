import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyManifest } from "../../src/core/fleet-copy.ts";

const key = (dir: string, name: string) => {
  Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(dir, name)]);
  return readFileSync(join(dir, `${name}.pub`), "utf8");
};
const sign = (dir: string, name: string, text: string) => {
  writeFileSync(join(dir, "m.json"), text);
  rmSync(join(dir, "m.json.sig"), { force: true }); // ssh-keygen never overwrites a signature
  Bun.spawnSync(["ssh-keygen", "-q", "-Y", "sign", "-f", join(dir, name), "-n", "fornax-fleet-copy", join(dir, "m.json")]);
  return readFileSync(join(dir, "m.json.sig"), "utf8");
};

describe("fleet copy signatures", () => {
  const dir = mkdtempSync(join(tmpdir(), "fornax-sig-"));
  const fleetKey = key(dir, "fleet");
  key(dir, "attacker");
  const manifest = '{"format":1,"fleet":"t","created":"2026-10-24T00:00:00.000Z"}\n';

  test("a copy signed with the fleet key holds", () => {
    expect(verifyManifest(manifest, sign(dir, "fleet", manifest), fleetKey)).toBe(true);
  });
  test("a copy someone else signed is refused — anyone can encrypt to the recipients", () => {
    expect(verifyManifest(manifest, sign(dir, "attacker", manifest), fleetKey)).toBe(false);
  });
  test("a changed manifest no longer matches its signature", () => {
    const sig = sign(dir, "fleet", manifest);
    expect(verifyManifest(manifest.replace("2026", "2030"), sig, fleetKey)).toBe(false);
  });
});
