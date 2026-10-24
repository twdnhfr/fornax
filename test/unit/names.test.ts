import { describe, expect, test } from "bun:test";
import { NAME_WORDS, serverName } from "../../src/core/names.ts";

describe("server names", () => {
  test("two words, valid as a server name, never one that is taken", () => {
    const taken = new Set(["silent-comet", "roaming-glacier"]);
    for (let i = 0; i < 500; i++) {
      const name = serverName(taken);
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
      expect(taken.has(name)).toBe(false);
    }
    expect(NAME_WORDS.adjectives * NAME_WORDS.nouns).toBeGreaterThan(5000);
  });
});
