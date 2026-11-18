import { describe, expect, test } from "bun:test";
import { envPermissions } from "../../src/modules/site.ts";

// On red-star five adopted .env files were 664 (readable by every site user) and plan said nothing:
// the bootstrap check only asked whether .env exists. The mode is now a resource of its own.
describe("env-mode resource", () => {
  const r = envPermissions("shop", "/home/shop/shop.example.com", "shop.example.com", { owner: "site:shop.example.com" });

  test("is a check per site that wants the .env files closed", () => {
    expect(r.id).toBe("check:env-mode:shop.example.com");
    expect(r.desired).toBe("ok");
    expect(r.owner).toBe("site:shop.example.com");
  });

  test("looks at .env and its copies, flags group-writable or other-accessible files", () => {
    expect(r.probe).toContain(".env*");
    expect(r.probe).toContain("-perm /g=w,o=rwx");
    expect(r.probe).toContain("-maxdepth 1");
  });

  test("only changes the mode, as the site user (root never acts in a home)", () => {
    expect(r.apply).toContain("chmod g-w,o-rwx");
    expect(r.apply).toContain("setpriv --reuid='shop'");
    // the only rm is the cleanup of its own temp file
    expect(r.apply.match(/\brm\b[^;\n]*/g)).toEqual(["rm -f -- \"$t\""]);
    expect(r.apply).not.toMatch(/>\s*'?\/home/);
  });

  // alpaluft.de had a 644 root:root .env.bak: the site user cannot chmod it and the apply broke off
  test("replaces a copy the site user does not own by its own copy, same content, tightened mode", () => {
    expect(r.apply).toContain(`if [ -O "$f" ]; then chmod`);
    expect(r.apply).toContain(`elif [ -r "$f" ]`);
    expect(r.apply).toContain(`cat -- "$f" > "$t"`);
    expect(r.apply).toContain(`chmod --reference="$f"`);
    expect(r.apply).toContain(`mv -f -T -- "$t" "$f"`);
  });

  test("stops with a clear message on a copy the site user cannot even read", () => {
    expect(r.apply).toContain("tighten its mode as root by hand");
    expect(r.apply).toContain("set -o pipefail");
  });
});
