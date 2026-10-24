import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commands } from "../../src/core/command.ts";
import "../../src/commands/index.ts";

// docs/compatibility.md promises tiers and error codes: it has to name all of them, as they are
const ROOT = join(import.meta.dir, "..", "..");
const doc = readFileSync(join(ROOT, "docs/compatibility.md"), "utf8");

describe("docs/compatibility.md", () => {
  test("the tier table lists every command with its tier", () => {
    const table: Record<string, string[]> = {};
    for (const m of doc.matchAll(/^\| `(read|write|destroy)` \| (.+) \|$/gm)) table[m[1]!] = [...m[2]!.matchAll(/`([^`]+)`/g)].map((x) => x[1]!);
    const actual: Record<string, string[]> = { read: [], write: [], destroy: [] };
    // (other test files register commands named "test …")
    for (const c of commands()) if (!c.internal && !c.name.startsWith("test ")) actual[c.tier]!.push(c.name);
    for (const tier of Object.keys(actual)) expect({ tier, commands: [...(table[tier] ?? [])].sort() }).toEqual({ tier, commands: actual[tier]!.sort() });
  });

  test("every error code fornax raises is listed", () => {
    const codes = new Set<string>();
    for (const f of new Glob("src/**/*.ts").scanSync(ROOT)) {
      for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(/(?:\bfail|new FornaxError)\(\s*"([a-z_]+)"/g)) codes.add(m[1]!);
    }
    expect(codes.size).toBeGreaterThan(50);
    const missing = [...codes].filter((c) => !doc.includes(`\`${c}\``));
    expect(missing).toEqual([]);
  });
});
