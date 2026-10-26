import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRootMember, rootMember } from "../../src/remote/backup.ts";

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
