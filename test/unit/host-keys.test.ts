import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveHostKey } from "../../src/commands/provider.ts";
import type { Fleet } from "../../src/core/fleet.ts";

describe("host keys follow a server to its new name", () => {
  test("the key known for the old name replaces a stale one a destroyed server left under the new name", () => {
    const dir = mkdtempSync(join(tmpdir(), "fornax-kh-"));
    const file = join(dir, "known_hosts");
    writeFileSync(file, "old.example.ts.net ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIThisServer\nnew.example.ts.net ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStaleOne\nother.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther\n");
    const fleet = { dir, config: { ssh: { known_hosts_file: file } } } as unknown as Fleet;
    moveHostKey(fleet, "old.example.ts.net", "new.example.ts.net");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("new.example.ts.net ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIThisServer");
    expect(text).not.toContain("StaleOne");
    expect(text).toContain("other.example");
  });
});
