import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import type { z } from "zod";
import { CONFIG_VERSION, upgradesFrom } from "./config-version.ts";
import { FornaxError, fail } from "./errors.ts";
import { isIPv4, sslipDomain } from "./names.ts";
import { notice } from "./notice.ts";
import { FleetSchema, ServerSchema, type FleetConfig, type Server, type Site } from "./schema.ts";
import { resolveSecret } from "./secrets.ts";
import { onePasswordFor, opFor } from "./onepassword.ts";
import { patchYaml } from "./yaml-patch.ts";

export interface Fleet {
  dir: string;
  config: FleetConfig;
  servers: Map<string, Server>;
  /** Path of each server's YAML file, for edits. */
  files: Map<string, string>;
}

export const FLEET_FILE = "fornax.yaml";
/** Fleet repos from before the rename (the project was called anvil). */
const LEGACY_FLEET_FILE = "anvil.yaml";

export const fleetFile = (dir: string) => (existsSync(join(dir, FLEET_FILE)) ? join(dir, FLEET_FILE) : existsSync(join(dir, LEGACY_FLEET_FILE)) ? join(dir, LEGACY_FLEET_FILE) : undefined);

/** Nearest directory upwards from `start` that contains fornax.yaml — like git finds .git. */
export function findFleetDir(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (fleetFile(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * A fleet repo from before the rename: its local state (.anvil/: plans, .env copies) moves to
 * .fornax/ once, and git keeps ignoring it. anvil.yaml itself is tracked — renaming it is the user's commit.
 */
function migrateLegacyFleet(dir: string, file: string) {
  const legacyState = join(dir, ".anvil");
  if (existsSync(legacyState) && !existsSync(join(dir, ".fornax"))) renameSync(legacyState, join(dir, ".fornax"));
  const gitignore = join(dir, ".gitignore");
  if (existsSync(gitignore)) {
    const text = readFileSync(gitignore, "utf8");
    if (/^\.anvil\/?$/m.test(text) && !/^\.fornax\/?$/m.test(text)) writeFileSync(gitignore, `${text.replace(/\n?$/, "\n")}.fornax/\n`);
  }
  if (file.endsWith(LEGACY_FLEET_FILE) && !warnedLegacy) {
    warnedLegacy = true;
    notice(`note: ${file} is the old name — rename it to ${FLEET_FILE} (git mv ${LEGACY_FLEET_FILE} ${FLEET_FILE})`);
  }
}
let warnedLegacy = false;
let warnedVersion = false;

export function readDoc(path: string): YAML.Document {
  const doc = YAML.parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length) fail("config_invalid", `${path}: not valid YAML (${doc.errors[0]!.message})`);
  return doc;
}

/** The config version of a fleet file (0: from before versions existed). */
export function configVersion(doc: YAML.Document, path: string): number {
  const v = doc.get("version");
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) fail("config_invalid", `${path}: version must be a whole number`);
  if ((v as number) > CONFIG_VERSION) {
    fail("config_too_new", `${path} is config version ${v}; this fornax understands up to ${CONFIG_VERSION}`, "update fornax (the fleet was written by a newer one)");
  }
  return v as number;
}

/** Bring a document of an older config version up to date, in memory (`fornax fleet upgrade` writes it). */
export function upgradeDoc(doc: YAML.Document, from: number, kind: "fleet" | "server"): void {
  for (const u of upgradesFrom(from)) u[kind]?.(doc);
  if (kind === "fleet" && from < CONFIG_VERSION) doc.set("version", CONFIG_VERSION);
}

/**
 * The upgraded file text, changed only where the upgrade changes something: the version line is
 * edited as text, reshaped fields go through patchYaml — comments and layout stay as written.
 */
export function upgradeText(text: string, from: number, kind: "fleet" | "server"): string {
  if (from >= CONFIG_VERSION) return text;
  let out = text;
  if (kind === "fleet") {
    const line = `version: ${CONFIG_VERSION}`;
    if (/^version:.*$/m.test(out)) out = out.replace(/^version:.*$/m, line);
    else {
      // after the leading comment block, before the first key
      const lines = out.split("\n");
      const at = lines.findIndex((l) => l.trim() !== "" && !l.startsWith("#"));
      lines.splice(at === -1 ? lines.length : at, 0, line);
      out = lines.join("\n");
    }
  }
  const steps = upgradesFrom(from).filter((u) => u[kind]);
  return steps.length ? patchYaml(out, (doc) => steps.forEach((u) => u[kind]!(doc))) : out;
}

/**
 * Every value but free text must be one line: fleet values reach cron, supervisor and nginx
 * configs and root's shell, where a line break starts a new entry. The schema's field checks
 * say more; this catches fields they do not cover.
 */
const MULTILINE = new Set(["content", "commands", "notes"]);
function lineBreaks(v: unknown, path: string[]): string[] {
  if (typeof v === "string") return /[\0\r\n]/.test(v) && !(MULTILINE.has(path.at(-1) ?? "") && !v.includes("\0")) ? [path.join(".")] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => lineBreaks(x, [...path, String(i)]));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [...(/[\0\r\n]/.test(k) ? [[...path, k].join(".")] : []), ...lineBreaks(x, [...path, k])]);
  return [];
}

function parseYaml<T extends z.ZodType>(schema: T, path: string, upgradeFrom?: { version: number; kind: "fleet" | "server" }): z.infer<T> {
  const doc = readDoc(path);
  if (upgradeFrom && upgradeFrom.version < CONFIG_VERSION) upgradeDoc(doc, upgradeFrom.version, upgradeFrom.kind);
  const raw = doc.toJS() ?? {};
  const broken = lineBreaks(raw, []);
  if (broken.length) fail("config_invalid", `${path}: ${broken.map((p) => `${p}: must be a single line`).join("; ")}`, "only file contents, deploy commands and notes may span lines");
  const res = schema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new FornaxError("config_invalid", `${path}: ${issues.join("; ")}`, "fix the file and run the command again", undefined, issues);
  }
  return res.data;
}

/**
 * The fleet to use outside any fleet repo: $FORNAX_FLEET, else ~/.config/fornax/fleet — so commands
 * work from any directory when you keep one fleet in its usual place.
 */
export function defaultFleetDir(): string | undefined {
  const env = process.env.FORNAX_FLEET;
  if (env) return resolve(env);
  const home = process.env.HOME;
  const dir = home ? join(home, ".config", "fornax", "fleet") : undefined;
  return dir && fleetFile(dir) ? dir : undefined;
}

const announced = new Set<string>();

export function loadFleet(opts: { cwd: string; fleetDir?: string; tier?: "read" | "write" | "destroy" }): Fleet {
  const found = opts.fleetDir ? resolve(opts.cwd, opts.fleetDir) : findFleetDir(opts.cwd);
  const dir = found ?? defaultFleetDir();
  // reading from anywhere is a convenience; changing things in a fleet nobody pointed at is how a
  // script or an agent that took a wrong turn edits the real one — writes need a fleet named on purpose
  const writes = opts.tier === "write" || opts.tier === "destroy";
  if (writes && !found && dir && !process.env.FORNAX_FLEET) {
    fail(
      "implicit_fleet",
      `this directory is no fleet repo, and write commands do not fall back to ${dir} on their own`,
      "run it inside the fleet repo, or name the fleet: --fleet <dir> or $FORNAX_FLEET",
      `cd ${dir}`,
    );
  }
  const file = dir ? fleetFile(dir) : undefined;
  if (!dir || !file) {
    fail(
      "no_fleet",
      "no fornax.yaml found in this directory or any parent, nor in $FORNAX_FLEET or ~/.config/fornax/fleet",
      "fornax works inside a fleet repo; create one, pass --fleet <dir>, or keep it in ~/.config/fornax/fleet",
      "fornax init <dir> --fleet-name <name>",
    );
  }
  migrateLegacyFleet(dir!, file!);
  const version = configVersion(readDoc(file!), file!);
  if (version < CONFIG_VERSION && !warnedVersion) {
    warnedVersion = true;
    notice(`note: this fleet config is version ${version}, fornax uses ${CONFIG_VERSION} — read as upgraded; \`fornax fleet upgrade\` writes it`);
  }
  const config = parseYaml(FleetSchema, file!, { version, kind: "fleet" });
  const servers = new Map<string, Server>();
  const files = new Map<string, string>();
  const serverDir = join(dir!, "servers");
  if (existsSync(serverDir)) {
    for (const f of readdirSync(serverDir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      const path = join(serverDir, f);
      const server = parseYaml(ServerSchema, path, { version, kind: "server" });
      if (servers.has(server.server)) fail("config_invalid", `server "${server.server}" is defined twice (${path})`);
      servers.set(server.server, server);
      files.set(server.server, path);
    }
  }
  const fleet = { dir: dir!, config, servers, files };
  for (const server of servers.values()) validateServer(fleet, server);
  if (writes && !announced.has(dir!)) {
    announced.add(dir!);
    notice(`fleet "${config.fleet}" (${dir})`);
  }
  return fleet;
}

/**
 * Accounts a site must never run as: system users, the database and cache daemons, fornax's own
 * users and the admin user (nginx runs as it). A site named after one would take it over —
 * and `site remove --purge` would delete it.
 */
const RESERVED_USERS = new Set(
  "root daemon bin sys sync games man lp mail news uucp proxy www-data backup list irc gnats nobody syslog messagebus sshd _apt uuidd tcpdump tss landscape pollinate polkitd usbmux dnsmasq lxd ubuntu postgres mysql redis memcache fornax fornax-hook anvil anvil-hook forge".split(" "),
);

function validateServer(fleet: Fleet, server: Server): void {
  const users = new Map<string, string>();
  const dbs = new Map<string, string>();
  const admin = server.admin_user ?? fleet.config.admin_user;
  for (const domain of Object.keys(server.sites)) {
    if (isIPv4(domain)) fail("config_invalid", `${server.server}/${domain}: an IP address, not a name — a site needs one for its vhost and certificate`, `${sslipDomain(domain)} is one: sslip.io resolves it to ${domain}`);
    const site = resolveSite(fleet, server, domain);
    // Forge runs sites without isolation as its admin user "forge": taken over as they are, never purged
    const forgeAdmin = site.spec.adopted && (site.user === "forge" || site.user === admin);
    if (forgeAdmin && site.spec.purge) fail("config_invalid", `${server.server}/${domain}: purging would delete the admin account "${site.user}"`, "remove `purge: true`");
    if (!forgeAdmin && (RESERVED_USERS.has(site.user) || site.user === admin || /^(systemd-|_)/.test(site.user))) {
      fail("config_invalid", `${server.server}/${domain}: "${site.user}" is a system or admin account and cannot be a site user`, "set `user:` on the site to another name");
    }
    // a site that moved to a new name leaves its old entry absent: it may keep the user, as removing
    // it (without purge) leaves the user, its files and its database alone
    const departed = site.spec.state === "absent" && !site.spec.purge;
    const other = users.get(site.user);
    if (other && !departed) {
      fail("config_invalid", `${server.server}: sites "${other}" and "${domain}" both use Linux user "${site.user}"`, "set a distinct `user:` on one of them (or mark the old one `state: absent` without purge)");
    }
    if (!departed) users.set(site.user, domain);
    // site users a-b and a_b map to the same database name and role
    for (const key of site.db?.manage ? [`${site.db.engine} database ${site.db.name}`, `${site.db.engine} role ${site.db.user}`] : []) {
      const owner = dbs.get(key);
      if (owner) fail("config_invalid", `${server.server}: sites "${owner}" and "${domain}" both use ${key}`, "set `db.name`/`db.user` on one of them");
      dbs.set(key, domain);
    }
    if (site.spec.preset === "node") validateNode(server, site);
    else if (site.spec.node) fail("config_invalid", `${server.server}/${domain}: node: is for preset node (preset: ${site.spec.preset})`, "set `preset: node` or remove `node:`");
    else if (!server.php.includes(site.php)) {
      fail("config_invalid", `${server.server}/${domain}: PHP ${site.php} is not installed on the server (php: ${server.php.join(", ")})`);
    }
  }
  // a node app's two ports belong to it alone: no other app, proxy or the webhook listens there
  const ports = new Map<number, string>([[server.webhook?.port ?? 9300, "the deploy webhook"]]);
  const present = sites(fleet, server).filter((s) => s.spec.state === "present");
  for (const s of present) for (const p of s.spec.proxies) ports.set(p.port, `the proxy ${p.domain}`);
  for (const s of present.filter((s) => s.node)) {
    for (const p of s.node!.ports) {
      const other = ports.get(p);
      if (other) fail("config_invalid", `${server.server}/${s.domain}: port ${p} (node.port and the one above it) is already used by ${other}`, "set another `node.port` on the site (it takes that port and the next)");
      ports.set(p, `the node app of ${s.domain}`);
    }
  }
}

/** preset node: a start command, release deploys (two slots), and the runtime on the server. */
function validateNode(server: Server, site: ResolvedSite): void {
  const at = `${server.server}/${site.domain}`;
  if (!site.node) fail("config_invalid", `${at}: preset node needs node.start, the command that starts the app`, 'e.g. node: { start: "bun run start" } or { start: "node .next/standalone/server.js" }');
  if (site.inPlace) fail("config_invalid", `${at}: preset node deploys releases (a new process next to the old one); deploy.mode in_place is not possible`, "remove `deploy.mode: in_place`");
  // the start command decides the runtime; build commands may need the other one as well
  const commands = [site.node!.start, site.spec.deploy.commands ?? ""].join("\n");
  const needs = new Set<"node" | "bun">([/^\s*bun\b/.test(site.node!.start) ? "bun" : "node"]);
  if (/(^|[\s;&|(])bunx?\b/m.test(commands)) needs.add("bun");
  if (/(^|[\s;&|(])(node|npm|npx)\b/m.test(commands)) needs.add("node");
  for (const tool of needs) {
    if (!server.tools.includes(tool)) fail("config_invalid", `${at}: preset node with "${site.node!.start}" needs ${tool} on the server (tools: ${server.tools.join(", ") || "none"})`, `add ${tool} to the server's tools`);
  }
}

/** The two ports a node app switches between: node.port and the next, or a pair derived from the domain. */
export function nodePorts(domain: string, port?: number): [number, number] {
  if (port) return [port, port + 1];
  // FNV-1a: the same domain always gets the same pair; a collision is reported by validateServer
  let h = 0x811c9dc5;
  for (const c of domain) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  const p = 20000 + (h % 4000) * 2;
  return [p, p + 1];
}

export function getServer(fleet: Fleet, name: string): Server {
  const s = fleet.servers.get(name);
  if (!s) {
    fail("unknown_server", `no server "${name}" in fleet "${fleet.config.fleet}"`, `known: ${[...fleet.servers.keys()].join(", ") || "none"}`, "fornax server list");
  }
  return s!;
}

/** Site lookup by domain or alias across all servers. */
export function findSite(fleet: Fleet, domain: string): { server: Server; site: ResolvedSite } {
  for (const server of fleet.servers.values()) {
    for (const [d, s] of Object.entries(server.sites)) {
      if (d === domain || s.aliases.includes(domain)) return { server, site: resolveSite(fleet, server, d) };
    }
  }
  return fail("unknown_site", `no site "${domain}" in fleet "${fleet.config.fleet}"`, undefined, "fornax site list");
}

export interface ResolvedSite {
  domain: string;
  spec: Site;
  user: string;
  php: string;
  /** /home/<user>/<domain> — holds releases/, current, storage/, .env */
  root: string;
  /** The live code: root/current, or root itself for in-place deploys. */
  current: string;
  inPlace: boolean;
  webRoot: string;
  shared: string[];
  names: string[];
  /** names + proxy domains: what the certificate and DNS cover. */
  certNames: string[];
  tlsIssuer: "letsencrypt" | "selfsigned" | "existing" | "none";
  /** manage false: fornax only backs the database up (it belongs to the app, e.g. made by Forge). */
  db?: { engine: "mysql" | "postgres"; name: string; user: string; extensions: string[]; manage: boolean };
  /** "own": a Redis server of its own (siteRedis); "shared": the server's; "none": no Redis on the server. */
  redis: "own" | "shared" | "none";
  /** Stable identifier used in file names (e.g. "shop-example-com"). */
  slug: string;
  /** preset node: the start command and the two ports deploys switch between. */
  node?: { start: string; ports: [number, number] };
}

export function defaultUser(domain: string): string {
  const label = domain.split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const name = /^[a-z_]/.test(label) ? label : `site-${label}`;
  return name.slice(0, 32);
}

export function resolveSite(fleet: Fleet, server: Server, domain: string): ResolvedSite {
  const spec = server.sites[domain];
  if (!spec) fail("unknown_site", `no site "${domain}" on server "${server.server}"`);
  const s = spec!;
  const user = s.user ?? defaultUser(domain);
  const php = s.php ?? server.php_default ?? server.php[server.php.length - 1]!;
  const root = `/home/${user}/${domain}`;
  const inPlace = s.deploy.mode === "in_place";
  const current = inPlace ? root : `${root}/current`;
  const webDir = s.web_dir ?? (s.preset === "static" ? "." : "public");
  const webRoot = webDir === "." || webDir === "" ? current : `${current}/${webDir.replace(/^\/+/, "")}`;
  const shared = s.shared ?? (s.preset === "laravel" ? ["storage"] : []);
  const names = [domain, ...s.aliases, ...(s.www_redirect ? [`www.${domain}`] : [])];
  const certNames = [...names, ...s.redirects, ...s.proxies.map((p) => p.domain)];
  const tlsIssuer = s.tls.issuer ?? fleet.config.tls.issuer;
  const slug = domain.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const dbBase = user.replace(/-/g, "_");
  const db = s.db
    ? { engine: s.db.engine, name: s.db.name ?? dbBase, user: s.db.user ?? dbBase, extensions: s.db.extensions, manage: s.db.manage }
    : undefined;
  // sites taken over keep the shared Redis their .env points at; PHP sites get their own, static and
  // node ones none (a node app opts in with redis.instance and points its .env at the socket)
  const redis = !server.services.includes("redis") ? "none" : (s.redis.instance ?? (s.adopted ? "shared" : s.preset === "static" || s.preset === "node" ? "none" : "own"));
  const node = s.preset === "node" && s.node ? { start: s.node.start.trim(), ports: nodePorts(domain, s.node.port) } : undefined;
  return { domain, spec: s, user, php, root, current, inPlace, webRoot, shared, names, certNames, tlsIssuer, db, redis, slug, ...(node ? { node } : {}) };
}

/** The Redis server a site with its own instance runs (as the site user, reachable only by it). */
export const siteRedis = (user: string) => ({ unit: `fornax-redis@${user}`, socket: `/run/fornax-redis/${user}/redis.sock`, conf: `/etc/fornax/redis/${user}.conf`, data: `/var/lib/fornax-redis/${user}` });

export function sites(fleet: Fleet, server: Server): ResolvedSite[] {
  return Object.keys(server.sites).map((d) => resolveSite(fleet, server, d));
}

// ---- policies ----------------------------------------------------------------

/** Owner part of a repo reference: "acme/shop", git@host:acme/shop.git, https://host/acme/shop. */
export function repoOwner(repo: string): string | undefined {
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return repo.split("/")[0];
  const scp = repo.match(/^[\w.-]+@[\w.-]+:([\w.-]+)\/[\w.-]+?(\.git)?$/);
  if (scp) return scp[1];
  const url = repo.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?[\w.-]+(?::\d+)?\/([\w.-]+)\/[\w.-]+?(\.git)?\/?$/);
  if (url) return url[1];
  return undefined;
}

export interface Violation {
  server: string;
  site?: string;
  policy: string;
  message: string;
}

export function policyViolations(fleet: Fleet, server: Server): Violation[] {
  const out: Violation[] = [];
  const allowed = fleet.config.policies.allowed_repo_owners;
  if (!allowed) return out;
  for (const [domain, site] of Object.entries(server.sites)) {
    if (!site.repo || site.state === "absent") continue;
    const owner = repoOwner(site.repo);
    if (!owner || !allowed.includes(owner)) {
      out.push({
        server: server.server,
        site: domain,
        policy: "allowed_repo_owners",
        message: `repo "${site.repo}" ${owner ? `belongs to "${owner}"` : "has no recognisable owner"}; this fleet only allows ${allowed.join(", ")}`,
      });
    }
  }
  return out;
}

export function assertPolicies(fleet: Fleet, server: Server): void {
  const v = policyViolations(fleet, server);
  if (v.length) {
    throw new FornaxError("policy_violation", v.map((x) => `${x.site ?? x.server}: ${x.message}`).join("; "), "policies live in fornax.yaml under `policies:`", undefined, v);
  }
}

export const isProtected = (fleet: Fleet, name: string) => fleet.config.policies.protected.includes(name);

// ---- editing -------------------------------------------------------------------

/** Edit a server YAML in place, keeping comments and formatting. */
export function editServerFile(fleet: Fleet, server: string, edit: (doc: YAML.Document) => void): string {
  const path = fleet.files.get(server) ?? fail("unknown_server", `no server "${server}"`);
  const doc = YAML.parseDocument(readFileSync(path!, "utf8"));
  edit(doc);
  // Block style for maps and for lists of maps; short scalar lists stay inline.
  YAML.visit(doc, {
    Map(_, n) {
      n.flow = false;
    },
    Seq(_, n) {
      if (n.items.some((i) => !YAML.isScalar(i))) n.flow = false;
    },
  });
  const out = doc.toString();
  // a fleet of an older config version is checked as it loads: upgraded in memory, written as it was
  const check = YAML.parseDocument(out);
  const version = configVersion(readDoc(fleetFile(fleet.dir)!), path!);
  if (version < CONFIG_VERSION) upgradeDoc(check, version, "server");
  const res = ServerSchema.safeParse(check.toJS());
  if (!res.success) fail("config_invalid", `edit would make ${path} invalid: ${res.error.issues.map((i) => i.message).join("; ")}`);
  writeFileSync(path!, out);
  return path!;
}

export function writeServerFile(dir: string, server: Record<string, unknown>): string {
  const res = ServerSchema.safeParse(server);
  if (!res.success) fail("config_invalid", res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  mkdirSync(join(dir, "servers"), { recursive: true });
  const path = join(dir, "servers", `${server.server}.yaml`);
  if (existsSync(path)) fail("exists", `${path} already exists`);
  writeFileSync(path, YAML.stringify(server));
  return path;
}

export const stateDir = (fleet: Fleet, ...parts: string[]) => {
  const d = join(fleet.dir, ".fornax", ...parts);
  mkdirSync(d, { recursive: true });
  return d;
};

// ---- secrets ---------------------------------------------------------------------

/** Resolve a secret reference with this fleet's 1Password account. */
export async function secret(fleet: Fleet, ref: string): Promise<string> {
  if (ref.startsWith("op://") && behindApp(fleet, ref)) return opFor(fleet.config.onepassword?.account).read(ref);
  if (ref.startsWith("op://")) return (await onePassword(fleet)).read(ref);
  return resolveSecret(ref, fleet.dir, fleet.config.onepassword?.account);
}

/**
 * A reference into another vault than the service account's goes through the 1Password app — and
 * so asks for Touch ID. That is the place for the credentials that can do the most harm (a cloud
 * provider's token, the tailnet's API token): everyday commands run without a prompt, ordering or
 * deleting servers and rewriting the tailnet policy need the person at the Mac, not just the Mac.
 */
export function behindApp(fleet: Fleet, ref: string): boolean {
  const op = fleet.config.onepassword;
  if (!op?.service_account || !ref.startsWith("op://")) return false;
  return ref.slice(5).split("/")[0] !== op.vault;
}

/** 1Password as this fleet configures it (service account token from e.g. the Keychain, or the app). */
export const onePassword = (fleet: Fleet) => onePasswordFor(fleet.config.onepassword, (ref) => resolveSecret(ref, fleet.dir));

/** Values that may be a secret reference or a plain value (e.g. a heartbeat URL). */
export const secretOrPlain = (fleet: Fleet, value: string) => (isSecretRef(value) ? secret(fleet, value) : Promise.resolve(value));
export const isSecretRef = (value: string) => /^(op:\/\/|env:|file:|keychain:)/.test(value);
