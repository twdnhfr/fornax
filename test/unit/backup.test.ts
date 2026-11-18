import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRootMember, rootMember, replaceScript, unpackedPath, unpackScript } from "../../src/remote/backup.ts";

describe("a site's packed snapshot", () => {
  test("starts with fornax's own member, which reads back with its size and where the site user's tar begins", () => {
    expect(readRootMember(rootMember("fornax/db.sql", 1000))).toEqual({ name: "fornax/db.sql", size: 1000, next: 512 + 1024 });
    expect(readRootMember(rootMember("fornax/db.pgdump", 512))).toEqual({ name: "fornax/db.pgdump", size: 512, next: 1024 });
    expect(readRootMember(rootMember("fornax/", 0))).toEqual({ name: "fornax/", size: 0, next: 512 });
    // dumps past 8 GiB: GNU tar's base-256
    expect(readRootMember(rootMember("fornax/db.sql", 9 * 2 ** 30))!.size).toBe(9 * 2 ** 30);
  });

  test("anything else at the start is not taken for the dump", () => {
    const changed = rootMember("fornax/db.sql", 1000);
    changed[130] = 0x37;
    expect(readRootMember(changed)).toBeNull();
    // a member of the site user's tar, however well-formed
    expect(readRootMember(rootMember("home/shop/shop.example.com/.env", 10))).toBeNull();
    expect(readRootMember(Buffer.alloc(512))).toBeNull();
    expect(readRootMember(Buffer.alloc(100))).toBeNull();
  });

  test("is a tar archive tar itself lists: the dump first, then what follows", () => {
    const dir = mkdtempSync(join(tmpdir(), "fornax-packed-"));
    const dump = Buffer.from("-- dump\n".repeat(100));
    const f = join(dir, "site.tar");
    writeFileSync(f, Buffer.concat([rootMember("fornax/db.sql", dump.length), dump, Buffer.alloc((512 - (dump.length % 512)) % 512), Buffer.alloc(1024)]));
    const p = Bun.spawnSync(["tar", "-tvf", f]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toMatch(/^-rw-------.* 800 .*fornax\/db\.sql$/m);
  });
});

// fornax could restore only the database of a packed snapshot: the files are the site user's tar, and
// root must not unpack it into the home. Now the user unpacks it, with nothing but its own rights.
describe("restoring the files of a packed snapshot", () => {
  const site = { user: "shop", root: "/home/shop/shop.example.com", paths: ["/home/shop/shop.example.com/storage", "/home/shop/shop.example.com/.env", "/var/data/shop"] };

  test("a path lands relative to the site root, one from outside under its full path", () => {
    expect(unpackedPath(site, "/home/shop/shop.example.com/storage")).toBe("storage");
    expect(unpackedPath(site, "/home/shop/shop.example.com/.env")).toBe(".env");
    expect(unpackedPath(site, "/var/data/shop/")).toBe("var/data/shop");
    expect(unpackedPath(site, "/home/shop/shop.example.com")).toBe("");
    // not a prefix match on the name: a sibling directory is not under the root
    expect(unpackedPath(site, "/home/shop/shop.example.com-old/x")).toBe("home/shop/shop.example.com-old/x");
  });

  test("the user's part is cut off after root's own member and unpacked as the site user", () => {
    const s = unpackScript(site, "/var/lib/fornax/restore/x/shop.example.com.tar", 1024, "/home/shop/shop.example.com/restore-1");
    expect(s).toStartWith("set -o pipefail; tail -c +1025 -- '/var/lib/fornax/restore/x/shop.example.com.tar' | ");
    expect(s).toContain("setpriv --reuid='shop'");
    // into a directory of its own that must not exist yet, the root's prefix stripped (dots escaped for sed)
    expect(s).toContain("mkdir -- '\\''/home/shop/shop.example.com/restore-1'\\''");
    expect(s).toContain("s,^home/shop/shop\\.example\\.com/,,");
    expect(s).toContain("--no-same-owner");
  });

  test("--replace puts every path back as the site user, every file rewritten, then removes the unpacked tree", () => {
    const s = replaceScript(site, "/home/shop/shop.example.com/.restore-1");
    expect(s).toContain("setpriv --reuid='shop'");
    expect(s).toContain("rsync -a --ignore-times --delete -- '\\''/home/shop/shop.example.com/.restore-1/storage/'\\'' '\\''/home/shop/shop.example.com/storage'\\''");
    expect(s).toContain("rsync -a --ignore-times -- '\\''/home/shop/shop.example.com/.restore-1/.env'\\'' '\\''/home/shop/shop.example.com/.env'\\''");
    expect(s).toContain("'\\''/home/shop/shop.example.com/.restore-1/var/data/shop/'\\'' '\\''/var/data/shop'\\''");
    // the only removal is the unpacked tree
    const removals = s.match(/rm -rf[^\n]*/g) ?? [];
    expect(removals).toHaveLength(1);
    expect(removals[0]).toStartWith("rm -rf -- '\\''/home/shop/shop.example.com/.restore-1'\\''");
  });
});
