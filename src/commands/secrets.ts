import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type YAML from "yaml";
import { defineCommand } from "../core/command.ts";
import { FornaxError, fail } from "../core/errors.ts";
import { fleetFile, getServer, loadFleet, onePassword, sites, type Fleet } from "../core/fleet.ts";
import { itemTitle, needVault, OnePassword, opFor } from "../core/onepassword.ts";
import { patchYaml } from "../core/yaml-patch.ts";
import { resolveSecret } from "../core/secrets.ts";
import { DEPLOY_KEY } from "../core/runtime.ts";
import type { Server } from "../core/schema.ts";
import { asUser, q } from "../core/shell.ts";
import { runnerFor } from "../core/ssh.ts";
import { BOX_KEY } from "../modules/backup.ts";

/**
 * Credentials fornax made on the server, by 1Password field label: generated passwords and keys,
 * webhook secrets, the backup key and the sites' deploy keys.
 */
async function serverSecrets(fleet: Fleet, server: Server): Promise<Record<string, string>> {
  // deploy keys live in the sites' homes: read as the site user, like everything there
  const deployKeys = sites(fleet, server)
    .filter((s) => s.spec.state === "present")
    .map((s) => `k=$(${asUser(s.user, `[ -f ${q(DEPLOY_KEY(s.user))} ] && base64 -w0 ${q(DEPLOY_KEY(s.user))}`)} 2>/dev/null) && printf '%s\\t%s\\n' ${q(`deploy-key-${s.domain}`)} "$k"`)
    .join("\n");
  const out = await runnerFor(fleet, server).run(`for f in /etc/fornax/secrets/* /etc/fornax/hook-secrets/* ${BOX_KEY}; do
  [ -f "$f" ] || continue
  # copies of values that came from the fleet config (and so are in 1Password already), not generated here
  case "$f" in /etc/fornax/secrets/backup-heartbeat|/etc/fornax/secrets/ntfy-token) continue;; /etc/fornax/hook-secrets/*) n="hook-$(basename "$f")";; ${BOX_KEY}) n="storagebox-key";; *) n="$(basename "$f")";; esac
  printf '%s\\t%s\\n' "$n" "$(base64 -w0 "$f")"
done
${deployKeys}
true`);
  const res: Record<string, string> = {};
  for (const line of out.stdout.split("\n")) {
    const [k, v] = line.split("\t");
    if (k && v !== undefined) res[k] = Buffer.from(v, "base64").toString("utf8").trim();
  }
  return res;
}

function describeSecrets(fleet: Fleet, server: Server): string {
  const lines = [
    `Secrets fornax generated on ${server.server} (${server.host}), fleet ${fleet.config.fleet}.`,
    "Written by `fornax secrets sync`; the copies on the server under /etc/fornax/secrets stay the source.",
    "",
    "redis — requirepass of the local Redis",
    "restic — password of the backup repository (without it the backups cannot be read)",
    "hook-<site> — webhook secret shared with the git host",
    "deploy-key-<site> — private SSH deploy key of the site (read-only key at the git host)",
    "storagebox-key — private SSH key the server logs in to the Storage Box with",
  ];
  for (const s of sites(fleet, server)) if (s.db?.manage) lines.push(`db-${s.slug} — ${s.db.engine} database ${s.db.name}, user ${s.db.user} (${s.domain})`);
  return lines.join("\n");
}

export interface SyncResult {
  item: string;
  vault: string;
  created: boolean;
  written: string[];
  total: number;
}

export async function syncSecrets(fleet: Fleet, server: Server): Promise<SyncResult> {
  const vault = needVault(fleet.config.onepassword?.vault);
  const secrets = await serverSecrets(fleet, server);
  const title = itemTitle(fleet.config.fleet, server.server);
  const op = await onePassword(fleet);
  await op.adoptLegacyTitle(title, vault);
  const r = await op.upsertSecrets(title, vault, secrets, describeSecrets(fleet, server));
  return { item: title, vault, created: r.created, written: r.written, total: Object.keys(secrets).length };
}

/** After an apply: copy new secrets to 1Password when the fleet wants that. Never hides a failure. */
export async function autoSync(fleet: Fleet, server: Server, applied: unknown): Promise<SyncResult | null> {
  const op = fleet.config.onepassword;
  if (!op || op.auto_sync === false) return null;
  try {
    return await syncSecrets(fleet, server);
  } catch (e) {
    throw new FornaxError(
      "secrets_sync_failed",
      `the changes were applied, but copying the secrets to 1Password failed: ${(e as Error).message}`,
      (e as FornaxError).hint ?? "sign in to 1Password (`op signin`) and sync again",
      `fornax secrets sync ${server.server}`,
      { applied },
    );
  }
}

defineCommand({
  name: "secrets list",
  summary: "secrets fornax generated on a server and whether 1Password has the same value (values are never shown)",
  tier: "read",
  args: [{ name: "server", help: "server name", required: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    const secrets = await serverSecrets(fleet, server);
    const vault = fleet.config.onepassword?.vault;
    const title = itemTitle(fleet.config.fleet, server.server);
    const op = vault ? await onePassword(fleet) : null;
    if (op) await op.adoptLegacyTitle(title, vault!);
    const item = op ? await op.get(title, vault!) : null;
    const rows = Object.entries(secrets).map(([name, value]) => {
      const f = item?.fields.find((x) => x.label === name && x.section?.id === "secrets");
      return { name, in_1password: vault ? (f ? (f.value === value ? "same" : "differs") : "missing") : "no vault configured" };
    });
    const human = rows.map((r) => `${r.name.padEnd(36)} ${r.in_1password}`).join("\n") || "no secrets on this server yet";
    return { data: { server: server.server, item: vault ? `${vault}/${title}` : null, secrets: rows }, human: human + (vault ? `\n1Password item: op://${vault}/${title}` : "") };
  },
});

/** Keep a service account token on this machine: macOS Keychain, else a 0600 file. Returns its reference. */
function storeToken(fleetName: string, token: string): string {
  const name = `fornax-1password-${fleetName.replace(/[^\w.-]+/g, "-")}`;
  if (process.platform === "darwin" && process.env.FORNAX_TOKEN_STORE !== "file") {
    // through `security -i` on stdin: the token never shows up in a process list
    Bun.spawnSync(["security", "-i"], { stdin: new Blob([`add-generic-password -U -s ${name} -a fornax -l "fornax 1Password service account (${name})" -w "${token}"\n`]), stdout: "ignore", stderr: "pipe" });
    const back = Bun.spawnSync(["security", "find-generic-password", "-s", name, "-w"], { stdout: "pipe", stderr: "ignore" });
    if (back.stdout.toString().trim() !== token) fail("secret_unavailable", `could not store the service account token in the Keychain (${name})`);
    return `keychain:${name}`;
  }
  const dir = join(process.env.HOME || homedir(), ".config", "fornax");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.token`);
  writeFileSync(path, token + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return `file:${path}`;
}

/** Built-in vaults service accounts can never open. */
const BUILTIN_VAULT = /^(private|personal|employee|mitarbeiter)$/i;

defineCommand({
  name: "secrets setup",
  summary: "give the fleet its own 1Password vault and a service account: every credential fornax creates lands there after each apply, without Touch ID prompts",
  tier: "write",
  options: {
    vault: { type: "string", help: "vault for the fleet's credentials (default: the configured one, else fornax-<fleet>; created if missing)" },
    account: { type: "string", help: "1Password account (sign-in address) if you have several" },
  },
  examples: ["fornax secrets setup", "fornax secrets setup --vault infra-acme --account acme.1password.com"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const cfg = fleet.config.onepassword;
    const account = (input.account as string | undefined) ?? cfg?.account;
    const vault = String(input.vault ?? (cfg?.vault && !BUILTIN_VAULT.test(cfg.vault) ? cfg.vault : `fornax-${fleet.config.fleet}`));
    if (BUILTIN_VAULT.test(vault)) fail("invalid_option", `service accounts cannot open the built-in vault "${vault}"`, `use a vault of its own: --vault fornax-${fleet.config.fleet}`);
    const done: string[] = [];
    let ref = cfg?.service_account;
    // already set up for this vault: keep the account and its token
    let working = false;
    if (ref && cfg?.vault === vault) {
      try {
        working = await (await onePassword(fleet)).canOpenVault(vault);
      } catch {}
    }
    if (!working) {
      // the one time the desktop app (and Touch ID) is needed
      const app = opFor(account);
      if (!(await app.canOpenVault(vault))) {
        await app.createVault(vault, `Credentials of the fornax fleet "${fleet.config.fleet}" (written by fornax)`);
        done.push(`created vault ${vault}`);
      }
      const name = `fornax-${fleet.config.fleet}`;
      const token = await app.createServiceAccount(name, vault);
      if (!(await new OnePassword(undefined, token).canOpenVault(vault))) fail("onepassword_failed", `the new service account ${name} cannot open vault ${vault}`);
      ref = storeToken(fleet.config.fleet, token);
      done.push(`service account ${name} (read + write on ${vault} only), token in ${ref}`);
    }
    // the fleet's SSH key: new servers are ordered with it (one key for the fleet, not one per server)
    let sshKey = fleet.config.ssh.key;
    if (!sshKey) {
      const sa = new OnePassword(undefined, await resolveSecret(ref!, fleet.dir));
      const title = `fornax-${fleet.config.fleet} ssh`;
      if (!(await sa.get(title, vault))) {
        await sa.createSshKey(title, vault);
        done.push(`SSH key "${title}" in ${vault} (generated by 1Password, the private key never leaves the vault and fornax's agent)`);
      }
      sshKey = `op://${vault}/${title}/private key?ssh-format=openssh`;
    }
    // the fleet config: this vault, this account, credentials copied after every apply
    const file = fleetFile(fleet.dir)!;
    const text = readFileSync(file, "utf8");
    const next = patchYaml(text, (doc) => {
      const op = (doc.get("onepassword") as YAML.YAMLMap | undefined) ?? (doc.set("onepassword", doc.createNode({})), doc.get("onepassword") as YAML.YAMLMap);
      if (account) op.set("account", account);
      op.set("vault", vault);
      op.set("service_account", ref);
      op.set("auto_sync", true);
      const ssh = (doc.get("ssh") as YAML.YAMLMap | undefined) ?? (doc.set("ssh", doc.createNode({})), doc.get("ssh") as YAML.YAMLMap);
      ssh.set("key", sshKey);
    });
    if (next !== text) {
      writeFileSync(file, next);
      done.push(`${basename(file)}: onepassword → vault ${vault}, service account, auto_sync on; ssh.key → the fleet key`);
    }
    // references into other vaults still go through the app (and its prompts)
    const elsewhere = [file, ...fleet.files.values()].flatMap((f) => [...readFileSync(f, "utf8").matchAll(/op:\/\/([^/\s]+)\/[^\s"']+/g)].filter((m) => m[1] !== vault).map((m) => `${basename(f)}: ${m[0]}`));
    const human = [
      done.length ? done.map((d) => `✓ ${d}`).join("\n") : `already set up: vault ${vault}, service account ${ref}`,
      ...(elsewhere.length ? ["", `these references point into other vaults and still need the 1Password app — move the items into ${vault}:`, ...elsewhere.map((e) => `  ${e}`)] : []),
      "",
      "new credentials (database passwords, webhook secrets, keys) are copied to 1Password after every apply; now: fornax secrets sync <server>",
    ].join("\n");
    return { data: { vault, service_account: ref, done, elsewhere }, human };
  },
});

defineCommand({
  name: "secrets sync",
  summary: "copy the secrets fornax generated on a server into its 1Password item (only changed fields are written)",
  tier: "write",
  args: [{ name: "server", help: "server name", required: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    const r = await syncSecrets(fleet, server);
    return {
      data: r,
      human: r.written.length
        ? `${r.created ? "created" : "updated"} op://${r.vault}/${r.item}: wrote ${r.written.join(", ")} (${r.total} secrets)`
        : `op://${r.vault}/${r.item} is up to date (${r.total} secrets)`,
    };
  },
});
