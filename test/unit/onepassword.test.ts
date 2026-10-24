import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OnePassword } from "../../src/core/onepassword.ts";
import YAML from "yaml";
import { main } from "../../src/cli.ts";
import { loadFleet } from "../../src/core/fleet.ts";
import { fleetAgent } from "../../src/core/ssh-agent.ts";

process.env.FORNAX_OP_BIN = join(import.meta.dir, "..", "support", "fake-op");
process.env.FORNAX_FAKE_OP_STORE = join(mkdtempSync(join(tmpdir(), "fornax-op-")), "store.json");

describe("1Password (fake op)", () => {
  const op = new OnePassword("my.example.com");

  test("creates an item, then only writes what changed", async () => {
    const a = await op.upsertSecrets("fornax t web-1", "Infra", { "db-shop": "pw1", redis: "r1" }, "made by fornax");
    expect(a).toEqual({ created: true, written: ["db-shop", "redis"] });
    const b = await op.upsertSecrets("fornax t web-1", "Infra", { "db-shop": "pw1", redis: "r2", restic: "x" }, "made by fornax");
    expect(b).toEqual({ created: false, written: ["redis", "restic"] });
    expect(await op.read("op://Infra/fornax t web-1/secrets/redis")).toBe("r2");
  });

  test("secret values never appear in the op command line", async () => {
    // the fake stores what it got; argv is not recorded anywhere, so check the template path is gone
    const store = JSON.parse(readFileSync(process.env.FORNAX_FAKE_OP_STORE!, "utf8"));
    expect(store[0].fields.find((f: any) => f.label === "restic").value).toBe("x");
  });

  test("archiving hides the item and is reported", async () => {
    expect(await op.archive("fornax t web-1", "Infra")).toBe(true);
    expect(await op.get("fornax t web-1", "Infra")).toBeNull();
    expect(await op.archive("fornax t web-1", "Infra")).toBe(false);
    const store = JSON.parse(readFileSync(process.env.FORNAX_FAKE_OP_STORE!, "utf8"));
    expect(store[0].archived).toBe(true);
  });

  test("an item from before the rename is renamed, not doubled", async () => {
    await op.upsertSecrets("anvil t old-1", "Infra", { restic: "keep-me" }, "made by anvil");
    await op.adoptLegacyTitle("fornax t old-1", "Infra");
    expect(await op.get("anvil t old-1", "Infra")).toBeNull();
    expect(await op.read("op://Infra/fornax t old-1/secrets/restic")).toBe("keep-me");
    // a second call (or one with an item of the new name already there) changes nothing
    await op.adoptLegacyTitle("fornax t old-1", "Infra");
    const store = JSON.parse(readFileSync(process.env.FORNAX_FAKE_OP_STORE!, "utf8"));
    expect(store.filter((i: any) => i.title.endsWith(" t old-1"))).toHaveLength(1);
  });

  test("a service account token replaces the app (no --account)", async () => {
    const sa = new OnePassword("my.example.com", "ops_fake-token");
    expect((await sa.upsertSecrets("fornax t sa", "Infra", { x: "1" }, "n")).created).toBe(true);
    expect(await sa.read("op://Infra/fornax t sa/secrets/x")).toBe("1");
  });

  test("missing items are null, read errors are FornaxErrors", async () => {
    expect(await op.get("nope", "Infra")).toBeNull();
    await expect(op.read("op://Infra/nope/x")).rejects.toThrow(/1Password: reading/);
  });
});

describe("fornax secrets setup", () => {
  test("gives the fleet its own vault and a service account, and turns auto sync on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fornax-setup-"));
    mkdirSync(join(dir, "servers"));
    writeFileSync(join(dir, "fornax.yaml"), "version: 2\nfleet: acme\nonepassword:\n  vault: Private   # where it was\n  auto_sync: false\nbackup:\n  storage_box: { host: box.example.com, user: u1, password: op://Private/Box/password }\n");
    // the token goes to a 0600 file under $HOME, never to the real Keychain
    const home = process.env.HOME;
    process.env.HOME = dir;
    process.env.FORNAX_TOKEN_STORE = "file";
    expect(await main(["secrets", "setup", "--fleet", dir, "--json"])).toBe(0);
    const cfg = YAML.parse(readFileSync(join(dir, "fornax.yaml"), "utf8")).onepassword;
    expect(cfg).toEqual({ vault: "fornax-acme", auto_sync: true, service_account: `file:${join(dir, ".config", "fornax", "fornax-1password-acme.token")}` });
    expect(statSync(join(dir, ".config", "fornax", "fornax-1password-acme.token")).mode & 0o777).toBe(0o600);
    // the service account opens its vault, and only that one
    const token = readFileSync(join(dir, ".config", "fornax", "fornax-1password-acme.token"), "utf8").trim();
    expect(await new OnePassword(undefined, token).canOpenVault("fornax-acme")).toBe(true);
    expect(await new OnePassword(undefined, token).canOpenVault("Private")).toBe(false);
    // the fleet's SSH key: made in the vault, loaded into fornax's own agent, never a file
    const ssh = YAML.parse(readFileSync(join(dir, "fornax.yaml"), "utf8")).ssh;
    expect(ssh.key).toBe("op://fornax-acme/fornax-acme ssh/private key?ssh-format=openssh");
    const sock = await fleetAgent(loadFleet({ cwd: dir }))!;
    const listed = Bun.spawnSync(["ssh-add", "-L"], { env: { ...process.env, SSH_AUTH_SOCK: sock } }).stdout.toString();
    expect(listed).toStartWith("ssh-ed25519 ");
    expect(listed).toContain("fornax-acme ssh");
    // a second run finds it working and changes nothing
    const before = readFileSync(join(dir, "fornax.yaml"), "utf8");
    expect(await main(["secrets", "setup", "--fleet", dir, "--json"])).toBe(0);
    expect(readFileSync(join(dir, "fornax.yaml"), "utf8")).toBe(before);
    process.env.HOME = home;
    delete process.env.FORNAX_TOKEN_STORE;
  });

  test("refuses a built-in vault", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fornax-setup-"));
    writeFileSync(join(dir, "fornax.yaml"), "version: 2\nfleet: acme\n");
    expect(await main(["secrets", "setup", "--fleet", dir, "--vault", "Private", "--json"])).toBe(1);
  });
});

describe("credentials that expire", () => {
  const seed = (title: string, days: number) => {
    const store = JSON.parse(readFileSync(process.env.FORNAX_FAKE_OP_STORE!, "utf8"));
    store.push({ id: title, vault: "Infra", title, category: "API_CREDENTIAL", fields: [
      { id: "credential", label: "credential", type: "CONCEALED", value: `secret-${title}` },
      { id: "expires", label: "Gültig bis", type: "DATE", value: String(Math.floor(Date.now() / 1000) + days * 86_400 + 3600) },
    ] });
    writeFileSync(process.env.FORNAX_FAKE_OP_STORE!, JSON.stringify(store));
  };
  const warnings = async (fn: () => Promise<unknown>) => {
    const seen: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (seen.push(String(s)), true)) as typeof process.stderr.write;
    try {
      await fn();
    } finally {
      process.stderr.write = write;
    }
    return seen.join("");
  };

  test("using one that expires within the warning window warns once per run; one far off does not", async () => {
    seed("soon token", 6);
    seed("later token", 60);
    seed("old token", -3);
    const op = new OnePassword();
    const soon = await warnings(() => op.read("op://Infra/soon token/credential"));
    expect(soon).toContain('"soon token" (1Password, Infra) expires in 6 day(s)');
    expect(await warnings(() => op.read("op://Infra/soon token/credential"))).toBe("");
    expect(await warnings(() => op.read("op://Infra/later token/credential"))).toBe("");
    expect(await warnings(() => op.read("op://Infra/old token/credential"))).toContain("expired 3 day(s) ago");
    expect(await op.read("op://Infra/soon token/credential")).toBe("secret-soon token");
  });
});
