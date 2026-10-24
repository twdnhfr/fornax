import { describe, expect, test } from "bun:test";
import { kindOf, parseEtcLog } from "../../src/commands/history.ts";

describe("/etc history", () => {
  test("who made a commit: fornax, packages, or someone outside fornax", () => {
    expect(kindOf("fornax: 3 change(s) by plan ab12cd34")).toBe("fornax");
    expect(kindOf('committing changes in /etc made by "apt install nginx"')).toBe("packages");
    expect(kindOf("committing changes in /etc after apt run")).toBe("packages");
    expect(kindOf("outside fornax: changes found before fornax run 20261024T120000-ab12cd34")).toBe("outside");
    expect(kindOf("saving uncommitted changes in /etc prior to apt run")).toBe("outside");
    expect(kindOf("daily autocommit")).toBe("outside");
  });

  test("git log output becomes commits with their files and, for fornax, who and which fleet commit", () => {
    const out = [
      "@@3f2a1c9\t2026-10-24T14:02:11+02:00\tfornax: 2 change(s) by plan ab12cd34",
      "    run: 20261024T120211-ab12cd34",
      "    fleet: 1a2b3c4+uncommitted",
      "    by: alex@laptop",
      "",
      "nginx/sites-available/shop.example.com",
      "ufw/user.rules",
      "@@9e8d7c6\t2026-10-24T13:55:00+02:00\toutside fornax: changes found before fornax run 20261024T120211-ab12cd34",
      "",
      "ufw/user.rules",
    ].join("\n");
    const c = parseEtcLog(out);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ commit: "3f2a1c9", kind: "fornax", by: "alex@laptop", fleet: "1a2b3c4+uncommitted", files: ["nginx/sites-available/shop.example.com", "ufw/user.rules"] });
    expect(c[1]).toMatchObject({ kind: "outside", by: null, files: ["ufw/user.rules"] });
  });
});
