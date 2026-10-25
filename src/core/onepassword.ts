import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FornaxError, fail } from "./errors.ts";
import { notice } from "./notice.ts";

/**
 * 1Password via the `op` CLI. Secret values never appear in argv: items are created from
 * JSON on stdin and edited from a 0600 template file that is removed right after.
 * FORNAX_OP_BIN replaces the binary (tests use a fake).
 */
export interface OpField {
  id?: string;
  label: string;
  type: string;
  value?: string;
  purpose?: string;
  section?: { id: string; label?: string };
}

export interface OpItem {
  id: string;
  title: string;
  category: string;
  fields: OpField[];
  sections?: Array<{ id: string; label?: string }>;
}

/**
 * The 1Password app integration handles one request at a time: parallel `op` calls (several
 * fornax processes, or one plan touching many servers) block each other until they time out.
 * So all calls on this machine queue up — in-process via a promise chain, across processes
 * via a lock directory.
 */
const LOCK = join(tmpdir(), "fornax-op.lock");
let chain: Promise<unknown> = Promise.resolve();
const readCache = new Map<string, string>();

/**
 * Credentials that expire (API tokens, auth keys) carry the date on their item: the "valid until"
 * field 1Password puts on API credentials, or any date field named like it. Whenever fornax uses
 * one that expires within `expiryWarnDays` (onepassword.warn_expiry_days), it says so — once per
 * item and run.
 */
let expiryWarnDays = 14;
export const setExpiryWarnDays = (days: number) => void (expiryWarnDays = days);
const expiryChecked = new Set<string>();

export function expiryOf(item: Pick<OpItem, "fields">): Date | null {
  const f = item.fields.find((x) => x.type === "DATE" && (x.id === "expires" || /expir|gültig bis|valid until|ablauf/i.test(x.label)));
  const seconds = Number(f?.value);
  return seconds > 0 ? new Date(seconds * 1000) : null;
}

/** Whole days from now until `date` (negative: past). */
export const daysUntil = (date: Date) => Math.floor((date.getTime() - Date.now()) / 86_400_000);

export function expiryNote(title: string, vault: string, date: Date): string {
  const days = daysUntil(date);
  const when = date.toISOString().slice(0, 10);
  return days < 0
    ? `"${title}" (1Password, ${vault}) expired ${-days} day(s) ago, on ${when} — what needs it will fail: renew it and put the new value into the item`
    : `"${title}" (1Password, ${vault}) expires in ${days} day(s), on ${when} — renew it in time and put the new value (and date) into the item`;
}

async function machineLock<T>(fn: () => Promise<T>): Promise<T> {
  const until = Date.now() + 300_000;
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 300_000) rmSync(LOCK, { recursive: true, force: true }); // stale
      } catch {
        /* gone already */
      }
      if (Date.now() > until) fail("onepassword_busy", "another fornax process has been using 1Password for 5 minutes", `remove ${LOCK} if no fornax is running`);
      await Bun.sleep(150);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

export class OnePassword {
  private readonly bin = (process.env.FORNAX_OP_BIN ?? "op").split(" ");
  /**
   * With a service account token, op talks to 1Password directly (no desktop app, no Touch ID,
   * no need to queue calls); without it, calls go through the app integration.
   */
  constructor(
    private readonly account?: string,
    private readonly serviceAccountToken?: string,
  ) {}

  private op(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
    if (this.serviceAccountToken) return this.spawn(args, stdin);
    const run = chain.then(() => machineLock(() => this.spawn(args, stdin)));
    chain = run.catch(() => undefined);
    return run;
  }

  private async spawn(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
    // --account goes first: `op … -` (read stdin) must end the argument list; a service account has no account flag
    const accountArgs = this.account && !this.serviceAccountToken ? ["--account", this.account] : [];
    const env: Record<string, string | undefined> = { ...process.env };
    if (this.serviceAccountToken) env.OP_SERVICE_ACCOUNT_TOKEN = this.serviceAccountToken;
    const p = Bun.spawn([...this.bin, ...accountArgs, ...args], {
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    // generous: the desktop app may be waiting for someone to approve the request
    const timer = setTimeout(() => p.kill(), 120_000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    clearTimeout(timer);
    return { code: await p.exited, out, err };
  }

  private failed(what: string, err: string): never {
    throw new FornaxError("onepassword_failed", `1Password: ${what} failed`, err.trim().split("\n").pop() || "is the 1Password CLI signed in? (`op signin`)");
  }

  async read(ref: string): Promise<string> {
    const key = `${this.account ?? ""}|${ref}`;
    const hit = readCache.get(key);
    if (hit !== undefined) return hit;
    const r = await this.op(["read", "--no-newline", ref]);
    if (r.code !== 0 || !r.out) this.failed(`reading ${ref}`, r.err);
    readCache.set(key, r.out);
    await this.warnIfExpiring(ref);
    return r.out;
  }

  /** The expiry date on the item a reference points into (null: none, or the item cannot be read). */
  async expiry(ref: string): Promise<{ title: string; vault: string; date: Date } | null> {
    const m = ref.match(/^op:\/\/([^/]+)\/([^/]+)\//);
    if (!m) return null;
    // without --reveal: the date is no secret, the rest stays concealed
    const r = await this.op(["item", "get", m[2]!, "--vault", m[1]!, "--format", "json"]);
    if (r.code !== 0) return null;
    const item = JSON.parse(r.out) as OpItem;
    const date = expiryOf(item);
    return date ? { title: item.title, vault: m[1]!, date } : null;
  }

  private async warnIfExpiring(ref: string) {
    const item = ref.match(/^op:\/\/([^/]+\/[^/]+)\//)?.[1];
    if (!item || expiryChecked.has(item)) return;
    expiryChecked.add(item);
    try {
      const e = await this.expiry(ref);
      if (e && daysUntil(e.date) <= expiryWarnDays) notice(`warning: ${expiryNote(e.title, e.vault, e.date)}`);
    } catch {
      /* a warning must never break the command that needed the secret */
    }
  }

  /** Whether this client can open the vault (with a service account: whether it was granted it). */
  async canOpenVault(vault: string): Promise<boolean> {
    return (await this.op(["vault", "get", vault, "--format", "json"])).code === 0;
  }

  async createVault(vault: string, description: string): Promise<void> {
    const r = await this.op(["vault", "create", vault, "--description", description, "--format", "json"]);
    if (r.code !== 0) this.failed(`creating vault "${vault}"`, r.err);
  }

  /** A service account that may read and write items in `vault` only; returns its token (shown once by 1Password). */
  async createServiceAccount(name: string, vault: string): Promise<string> {
    const r = await this.op(["service-account", "create", name, "--vault", `${vault}:read_items,write_items`, "--raw"]);
    if (r.code !== 0 || !r.out.trim()) this.failed(`creating service account "${name}"`, r.err);
    return r.out.trim();
  }

  /** An SSH key item whose key pair 1Password generates itself: the private key exists only in the vault. */
  async createSshKey(title: string, vault: string): Promise<void> {
    const r = await this.op(["item", "create", "--category", "SSH Key", "--ssh-generate-key=ed25519", "--title", title, "--vault", vault, "--format", "json"]);
    if (r.code !== 0) this.failed(`creating SSH key "${title}"`, r.err);
  }

  async get(title: string, vault: string): Promise<OpItem | null> {
    const r = await this.op(["item", "get", title, "--vault", vault, "--format", "json", "--reveal"]);
    if (r.code !== 0) {
      if (/isn't an item|not found|no item/i.test(r.err)) return null;
      this.failed(`reading item "${title}"`, r.err);
    }
    return JSON.parse(r.out) as OpItem;
  }

  /** Move an item to the 1Password archive (restorable there). Returns false when it does not exist. */
  async archive(title: string, vault: string): Promise<boolean> {
    const item = await this.get(title, vault);
    if (!item) return false;
    const r = await this.op(["item", "delete", item.id, "--vault", vault, "--archive"]);
    if (r.code !== 0) this.failed(`archiving item "${title}"`, r.err);
    return true;
  }

  /**
   * Items created before the rename are titled "anvil <fleet> <server>": rename such an item to
   * `title` (same id, same secrets) instead of letting a second one appear next to it.
   */
  /** Give an item a new title; false when there is no item `from`. */
  async renameItem(from: string, to: string, vault: string): Promise<boolean> {
    const item = await this.get(from, vault);
    if (!item) return false;
    const r = await this.op(["item", "edit", item.id, "--vault", vault, `--title=${to}`]);
    if (r.code !== 0) this.failed(`renaming item "${from}" to "${to}"`, r.err);
    return true;
  }

  async adoptLegacyTitle(title: string, vault: string): Promise<void> {
    if (!title.startsWith("fornax ") || (await this.get(title, vault))) return;
    const legacy = await this.get(`anvil ${title.slice("fornax ".length)}`, vault);
    if (!legacy) return;
    const r = await this.op(["item", "edit", legacy.id, "--vault", vault, `--title=${title}`]);
    if (r.code !== 0) this.failed(`renaming item "${legacy.title}" to "${title}"`, r.err);
  }

  /** Run op with an item JSON template (0600 temp file, removed right after). */
  private async withTemplate(args: string[], item: unknown, what: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "fornax-op-"));
    const tpl = join(dir, "item.json");
    try {
      writeFileSync(tpl, JSON.stringify(item), { mode: 0o600 });
      chmodSync(tpl, 0o600);
      const r = await this.op([...args, `--template=${tpl}`]);
      if (r.code !== 0) this.failed(what, r.err);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Make sure `title` in `vault` holds these secrets (section "secrets"). Creates the item or
   * adds/updates only the fields that differ. Returns the labels that were written.
   */
  async upsertSecrets(title: string, vault: string, secrets: Record<string, string>, notes: string): Promise<{ created: boolean; written: string[] }> {
    const field = (label: string, value: string): OpField => ({ label, type: "CONCEALED", value, section: { id: "secrets", label: "secrets" } });
    const existing = await this.get(title, vault);
    if (!existing) {
      const item = {
        title,
        category: "SECURE_NOTE",
        sections: [{ id: "secrets", label: "secrets" }],
        fields: [{ id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value: notes }, ...Object.entries(secrets).map(([k, v]) => field(k, v))],
      };
      // (a template file, not stdin: op does not reliably detect stdin when spawned from Bun)
      await this.withTemplate(["item", "create", "--vault", vault, "--format", "json"], item, `creating item "${title}"`);
      return { created: true, written: Object.keys(secrets) };
    }
    const written: string[] = [];
    const fields = [...existing.fields];
    for (const [label, value] of Object.entries(secrets)) {
      const f = fields.find((x) => x.label === label && x.section?.id === "secrets");
      if (f?.value === value) continue;
      if (f) f.value = value;
      else fields.push(field(label, value));
      written.push(label);
    }
    if (!written.length) return { created: false, written };
    const sections = [...(existing.sections ?? [])];
    if (!sections.some((s) => s.id === "secrets")) sections.push({ id: "secrets", label: "secrets" });
    await this.withTemplate(["item", "edit", existing.id, "--vault", vault, "--format", "json"], { ...existing, sections, fields }, `updating item "${title}"`);
    return { created: false, written };
  }
}

export const opFor = (account?: string) => new OnePassword(account);

const tokens = new Map<string, Promise<string>>();

/** The fleet's 1Password client: service account when configured, app integration otherwise. */
export async function onePasswordFor(
  config: { account?: string; service_account?: string; warn_expiry_days?: number } | undefined,
  resolve: (ref: string) => Promise<string>,
): Promise<OnePassword> {
  setExpiryWarnDays(config?.warn_expiry_days ?? 14);
  // on a peer host the token comes from the client for this run only (fornax --on, peers-run.ts)
  if (process.env.FORNAX_OP_TOKEN) return new OnePassword(config?.account, process.env.FORNAX_OP_TOKEN);
  const ref = config?.service_account;
  if (!ref) return new OnePassword(config?.account);
  if (!tokens.has(ref)) tokens.set(ref, resolve(ref));
  return new OnePassword(config?.account, await tokens.get(ref)!);
}

/** Item title for a server's secrets. No "/" or "|": they break op:// references. */
export const itemTitle = (fleet: string, server: string) => `fornax ${fleet} ${server}`.replace(/[/|]/g, "-");

export function needVault(vault: string | undefined): string {
  if (!vault) fail("no_onepassword", "this fleet has no 1Password vault configured", "add `onepassword: { vault: <name> }` to fornax.yaml");
  return vault!;
}
