import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { docComments, REFERENCE_FILE, renderReference, SCHEMA_FILE } from "../../scripts/config-reference.ts";

describe("config reference", () => {
  const ref = renderReference();

  test("docs/config.md matches the schema (`bun run docs` regenerates it)", () => {
    expect(readFileSync(REFERENCE_FILE, "utf8")).toBe(ref.markdown);
  });

  test("every doc comment in schema.ts belongs to a key of the reference", () => {
    expect(ref.unmatched).toEqual([]);
    // and a comment the reference cannot place is reported
    const source = readFileSync(SCHEMA_FILE, "utf8").replace("  state: z.enum", "  /** Not in the schema. */\n  ghost: z.string(),\n  state: z.enum");
    expect(renderReference(source).unmatched).toEqual(["SiteSchema.ghost"]);
  });

  test("keys, nested keys and lists carry their comments and defaults", () => {
    expect(ref.markdown).toContain("### `sites.<domain>.deploy.keep_releases`\n\nwhole number, at least 2 · default `5`\n\nHow many releases stay on the server (for rollbacks).");
    expect(ref.markdown).toContain("### `ssh.root_keys`\n\nlist of strings (an OpenSSH public key line) · optional\n\nExactly these public keys");
    expect(ref.markdown).toContain("### `tailscale.allow[].ports`\n\nlist of whole numbers from 1 to 65535, at least 1 entry · required");
    expect(ref.markdown).toContain("relative to the fleet dir. A file needs exactly one of source or content.");
    expect(ref.undocumented).toContain("fleet");
  });

  test("comments are tied to the key below them, by key path", () => {
    const source = [
      "/** A name. */",
      'const Name = z.string().regex(/^[a-z]{1,3}$/, "{ x: y }");',
      "export const Thing = z.strictObject({",
      "  /** Top. */",
      "  top: z.string(),",
      "  nested: z",
      "    .strictObject({",
      "      /** Deep, after a regex with braces: /{/. */",
      "      deep: z.string().regex(/^[{(]+$/),",
      "      list: z.array(z.strictObject({ /** In a list. */ item: z.number() })),",
      "    })",
      '    .default({ deep: "x" }),',
      "  /** After the nested object. */",
      "  after: z.boolean(),",
      "});",
      "/** Above nothing. */",
      "foo();",
    ].join("\n");
    const c = docComments(source);
    expect([...c.keys]).toEqual([
      ["Thing.top", "Top."],
      ["Thing.nested.deep", "Deep, after a regex with braces: /{/."],
      ["Thing.nested.list.item", "In a list."],
      ["Thing.after", "After the nested object."],
    ]);
    expect([...c.consts]).toEqual([["Name", "A name."]]);
    expect(c.orphans).toEqual(["line 16: Above nothing."]);
  });
});
