import { describe, expect, test } from "bun:test";
import { presetFromFiles } from "../../src/core/detect.ts";
import { hasPublicDns, NAME_WORDS, serverName, sslipDomain } from "../../src/core/names.ts";

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

describe("names without DNS of their own", () => {
  test("sslip.io names an IP address; a CA can only check public ones", () => {
    expect(sslipDomain("192.0.2.10")).toBe("192-0-2-10.sslip.io");
    expect(hasPublicDns("quiet-harbor.203-0-113-10.sslip.io")).toBe(true);
    expect(hasPublicDns("quiet-harbor.192-168-139-130.sslip.io")).toBe(false);
    expect(hasPublicDns("10.0.0.5.nip.io")).toBe(false);
    expect(hasPublicDns("100-101-1-3.sslip.io")).toBe(false);
    expect(hasPublicDns("app.test")).toBe(false);
    expect(hasPublicDns("printer.local")).toBe(false);
    expect(hasPublicDns("shop.example.com")).toBe(true);
    expect(hasPublicDns("192.0.2.10")).toBe(false);
  });
});

describe("preset detection", () => {
  test("the file that decides", () => {
    expect(presetFromFiles(["artisan", "public/index.php", "package.json"], { scripts: { build: "vite build" } }).preset).toBe("laravel");
    expect(presetFromFiles(["composer.json", "public/index.php"])).toMatchObject({ preset: "php" });
    expect(presetFromFiles(["index.php"])).toMatchObject({ preset: "php", web_dir: "." });
    expect(presetFromFiles(["package.json", "bun.lock"], { scripts: { start: "next start" } })).toMatchObject({ preset: "node", start: "bun run start" });
    expect(presetFromFiles(["package.json", "package-lock.json"], { scripts: { start: "node server.js" } })).toMatchObject({ preset: "node", start: "npm run start" });
    expect(presetFromFiles(["index.html", "style.css"])).toMatchObject({ preset: "static" });
    expect(presetFromFiles(["package.json"], { scripts: { build: "vite build" } })).toMatchObject({ preset: "static", web_dir: "dist" });
    expect(presetFromFiles(["package.json"], { scripts: { build: "next build" }, dependencies: { next: "15" } })).toMatchObject({ preset: "static", web_dir: "out" });
  });
});
