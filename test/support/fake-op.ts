/**
 * Stand-in for the 1Password CLI in tests: read, item get/create/edit, backed by a JSON file
 * ($FORNAX_FAKE_OP_STORE). Never touches a real 1Password account.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Field = { id?: string; label: string; type: string; value?: string; purpose?: string; section?: { id: string; label?: string } };
type Item = { id: string; vault: string; title: string; category: string; fields: Field[]; sections?: Array<{ id: string; label?: string }>; archived?: boolean };

const storePath = process.env.FORNAX_FAKE_OP_STORE ?? "/tmp/fornax-fake-op.json";
if (process.env.OP_SERVICE_ACCOUNT_TOKEN && process.argv.includes("--account")) {
  process.stderr.write("[ERROR] service account tokens cannot be combined with --account\n");
  process.exit(1);
}
const load = (): Item[] => (existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : []);
const save = (items: Item[]) => writeFileSync(storePath, JSON.stringify(items, null, 2));
const args = process.argv.slice(2).filter((a, i, all) => a !== "--account" && all[i - 1] !== "--account");
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
};
const die = (msg: string) => {
  process.stderr.write(`[ERROR] ${msg}\n`);
  process.exit(1);
};
const find = (items: Item[], key: string, vault?: string) => items.find((i) => !i.archived && (i.id === key || i.title === key) && (!vault || i.vault === vault));

const [cmd, sub] = args;
const items = load();
if (cmd === "read") {
  // (query options like ?ssh-format=openssh: the fake stores SSH keys in OpenSSH format already)
  const ref = args.find((a) => a.startsWith("op://"))!.replace(/\?.*$/, "");
  const [vault, item, ...rest] = ref.slice(5).split("/");
  const it = find(items, item!, vault);
  if (!it) die(`"${item}" isn't an item in the "${vault}" vault`);
  const fieldName = rest[rest.length - 1];
  const section = rest.length > 1 ? rest[0] : undefined;
  const f = it!.fields.find((x) => x.label === fieldName && (!section || x.section?.id === section || x.section?.label === section));
  if (!f) die(`item "${item}" has no field "${fieldName}"`);
  process.stdout.write(f!.value ?? "");
} else if (cmd === "item" && sub === "get") {
  const it = find(items, args[2]!, flag("--vault"));
  if (!it) die(`"${args[2]}" isn't an item in the "${flag("--vault")}" vault. Specify the item with its UUID, name, or domain.`);
  process.stdout.write(JSON.stringify(it));
} else if (cmd === "item" && sub === "create" && args.some((a) => a.startsWith("--ssh-generate-key"))) {
  // like 1Password: the key pair is made inside the "vault"
  const dir = (await import("node:fs")).mkdtempSync(`${storePath}.key-`);
  Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", flag("--title")!, "-f", `${dir}/k`]);
  const it: Item = {
    id: `fake${items.length + 1}`,
    vault: flag("--vault")!,
    title: flag("--title")!,
    category: "SSH_KEY",
    fields: [
      { id: "private_key", label: "private key", type: "SSHKEY", value: readFileSync(`${dir}/k`, "utf8") },
      { id: "public_key", label: "public key", type: "STRING", value: readFileSync(`${dir}/k.pub`, "utf8").trim() },
    ],
  };
  (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  items.push(it);
  save(items);
  process.stdout.write(JSON.stringify(it));
} else if (cmd === "item" && sub === "create") {
  const tpl = flag("--template");
  const body = JSON.parse(tpl ? readFileSync(tpl, "utf8") : await new Response(Bun.stdin.stream()).text()) as Omit<Item, "id" | "vault">;
  const it: Item = { ...body, id: `fake${items.length + 1}`, vault: flag("--vault")! };
  items.push(it);
  save(items);
  process.stdout.write(JSON.stringify(it));
} else if (cmd === "item" && sub === "edit") {
  const it = find(items, args[2]!, flag("--vault"));
  if (!it) die(`"${args[2]}" isn't an item`);
  const template = flag("--template");
  if (template) {
    const tpl = JSON.parse(readFileSync(template, "utf8")) as Item;
    Object.assign(it!, { fields: tpl.fields, sections: tpl.sections, title: tpl.title });
  }
  const title = flag("--title");
  if (title) it!.title = title;
  save(items);
  process.stdout.write(JSON.stringify(it));
} else if (cmd === "item" && sub === "delete") {
  const it = find(items, args[2]!, flag("--vault"));
  if (!it) die(`"${args[2]}" isn't an item`);
  if (args.includes("--archive")) it!.archived = true;
  else items.splice(items.indexOf(it!), 1);
  save(items);
} else if (cmd === "vault" && sub === "get") {
  const vault = args[2]!;
  const acc = loadAccounts();
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  // a service account opens only the vaults it was granted; the app every vault there is
  const ok = token ? acc.serviceAccounts.find((s) => s.token === token)?.vaults.includes(vault) : acc.vaults.includes(vault) || items.some((i) => i.vault === vault);
  if (!ok) die(`"${vault}" isn't a vault in this account`);
  process.stdout.write(JSON.stringify({ id: vault, name: vault }));
} else if (cmd === "vault" && sub === "create") {
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN) die("service accounts cannot create vaults here");
  const acc = loadAccounts();
  acc.vaults.push(args[2]!);
  saveAccounts(acc);
  process.stdout.write(JSON.stringify({ id: args[2], name: args[2] }));
} else if (cmd === "service-account" && sub === "create") {
  const acc = loadAccounts();
  const grant = flag("--vault")!.split(":")[0]!;
  if (/^(private|personal|employee)$/i.test(grant)) die(`service accounts can't be granted access to the built-in ${grant} vault`);
  const token = `ops_fake_${acc.serviceAccounts.length + 1}`;
  acc.serviceAccounts.push({ name: args[2]!, token, vaults: [grant] });
  saveAccounts(acc);
  process.stdout.write(token + "\n");
} else {
  die(`fake op: unsupported command ${args.join(" ")}`);
}

// vaults and service accounts live next to the items, so the item store keeps its format
function loadAccounts(): { vaults: string[]; serviceAccounts: Array<{ name: string; token: string; vaults: string[] }> } {
  const p = `${storePath}.accounts.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { vaults: [], serviceAccounts: [] };
}
function saveAccounts(a: ReturnType<typeof loadAccounts>) {
  writeFileSync(`${storePath}.accounts.json`, JSON.stringify(a, null, 2));
}
