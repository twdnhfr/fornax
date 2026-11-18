import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outsideClash, packedSource, readRootMember, REPLACED, replaceScript, restoredSource, rootMember, unpackedPath, unpackScript } from "../../src/remote/backup.ts";

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
// root must not unpack it into the home. Now the user unpacks it, with nothing but its own rights —
// and a snapshot from before the packing goes the same way (root tars it out of its own tmp directory).
describe("restoring the files of a snapshot", () => {
  const site = { user: "shop", root: "/home/shop/shop.example.com", paths: ["/home/shop/shop.example.com/storage", "/home/shop/shop.example.com/.env", "/var/data/shop"] };

  test("a path lands relative to the site root, one from outside under outside/ with its full path", () => {
    expect(unpackedPath(site, "/home/shop/shop.example.com/storage")).toBe("storage");
    expect(unpackedPath(site, "/home/shop/shop.example.com/.env")).toBe(".env");
    expect(unpackedPath(site, "/var/data/shop/")).toBe("outside/var/data/shop");
    expect(unpackedPath(site, "/home/shop/shop.example.com")).toBe("");
    // not a prefix match on the name: a sibling directory is not under the root
    expect(unpackedPath(site, "/home/shop/shop.example.com-old/x")).toBe("outside/home/shop/shop.example.com-old/x");
    // <root>/var/data/shop and /var/data/shop no longer land on each other
    expect(unpackedPath(site, "/home/shop/shop.example.com/var/data/shop")).not.toBe(unpackedPath(site, "/var/data/shop"));
  });

  test("a site path under the root named outside/ is refused, it would mix with the paths from outside", () => {
    expect(outsideClash(site)).toBeUndefined();
    expect(outsideClash({ ...site, paths: [...site.paths, "/home/shop/shop.example.com/outside/x"] })).toBe("/home/shop/shop.example.com/outside/x");
    expect(outsideClash({ ...site, paths: ["/home/shop/shop.example.com/outsider"] })).toBeUndefined();
  });

  test("a packed snapshot: the user's part is cut off after root's own member and unpacked as the site user", () => {
    const s = unpackScript(site, packedSource("/var/lib/fornax/restore/x/shop.example.com.tar", 1024), "/home/shop/shop.example.com/restore-1");
    expect(s).toStartWith("set -o pipefail; tail -c +1025 -- '/var/lib/fornax/restore/x/shop.example.com.tar' | ");
    expect(s).toContain("setpriv --reuid='shop'");
    // into a directory of its own that must not exist yet
    expect(s).toContain("mkdir -- '\\''/home/shop/shop.example.com/restore-1'\\''");
    expect(s).toContain("--no-same-owner");
    // everything under outside/, the root's own out of it again (dots escaped for sed); S: link targets stay
    expect(s).toContain("--transform '\\''s,^,outside/,S'\\'' --transform '\\''s,^outside/home/shop/shop\\.example\\.com/,,S'\\''");
  });

  test("a snapshot from before the packing is tarred by root out of its own tmp directory, links kept as links", () => {
    const src = restoredSource("/var/lib/fornax/restore/x", site.paths);
    expect(src).toContain("cd -- '/var/lib/fornax/restore/x'");
    expect(src).toContain("'home/shop/shop.example.com/storage' 'home/shop/shop.example.com/.env' 'var/data/shop'");
    expect(src).toContain("tar -cf - -T /dev/null");
    expect(src).not.toMatch(/tar [^|]*-h|--dereference/);
    // and root writes nothing into the home: the unpacking is the user's
    const s = unpackScript(site, src, "/home/shop/shop.example.com/restore-1");
    expect(s).not.toMatch(/rsync|chown/);
  });

  test("--replace checks every path is writable before it replaces any, then puts each back as the site user", () => {
    const s = replaceScript(site, "/home/shop/shop.example.com/.restore-1");
    expect(s).toContain("setpriv --reuid='shop'");
    const check = s.indexOf("cannot write /var/data/shop");
    const firstMove = s.indexOf("rsync");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(firstMove);
    expect(s).toContain("rsync -a --ignore-times --delete -- '\\''/home/shop/shop.example.com/.restore-1/storage/'\\'' '\\''/home/shop/shop.example.com/storage'\\''");
    expect(s).toContain("rsync -a --ignore-times -- '\\''/home/shop/shop.example.com/.restore-1/.env'\\'' '\\''/home/shop/shop.example.com/.env'\\''");
    expect(s).toContain("'\\''/home/shop/shop.example.com/.restore-1/outside/var/data/shop/'\\'' '\\''/var/data/shop'\\''");
    // each path put back is reported, so a failure can say which are replaced already
    expect(s.match(new RegExp(`${REPLACED} /home/shop/shop.example.com/storage`, "g"))?.length).toBe(2);
    // the only removal is the unpacked tree
    const removals = s.match(/rm -rf[^\n]*/g) ?? [];
    expect(removals).toHaveLength(1);
    expect(removals[0]).toStartWith("rm -rf -- '\\''/home/shop/shop.example.com/.restore-1'\\''");
  });
});
