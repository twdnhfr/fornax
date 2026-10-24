import { readFileSync, writeFileSync } from "node:fs";
import { defineCommand, requireConfirm } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import type YAML from "yaml";
import { detectPreset, remoteBranches } from "../core/detect.ts";
import { assertPolicies, editServerFile, findSite, getServer, isProtected, loadFleet, repoOwner, sites } from "../core/fleet.ts";
import { everPlannedWhole } from "../core/plan.ts";
import { hasPublicDns, isIPv4, previewName, sslipDomain } from "../core/names.ts";
import { PRESETS, type Server } from "../core/schema.ts";
import type { Fleet } from "../core/fleet.ts";

/** Every name a site of the fleet answers to (domains, aliases, www, proxies). */
function fleetNames(fleet: Fleet): string[] {
  return [...fleet.servers.values()].flatMap((s) => Object.entries(s.sites).flatMap(([d, x]) => [d, ...x.aliases, ...(x.www_redirect ? [`www.${d}`] : []), ...x.proxies.map((p) => p.domain)]));
}

/**
 * A fresh two-word name under the fleet's preview_domain — without one, under the server's IP
 * through sslip.io (quiet-harbor.192-0-2-10.sslip.io), a name that needs no DNS of one's own.
 */
function newPreviewName(fleet: Fleet, server: Server): string {
  const ip = server.public_ipv4 ?? (isIPv4(server.host) ? server.host : undefined);
  const pd = fleet.config.preview_domain ?? (ip ? sslipDomain(ip) : undefined);
  if (!pd) fail("no_preview_domain", "this fleet has no preview_domain, and the server no IPv4 address to name one after", "set preview_domain: <a domain whose subdomains reach your servers, e.g. through a wildcard record> in fornax.yaml, or the server's public_ipv4");
  return previewName(pd!, fleetNames(fleet));
}

/** A public CA cannot check a name without public DNS (.test, a private IP's sslip.io name …): those get a self-signed certificate. */
function tlsFor(fleet: Fleet, names: string[]): { issuer?: "selfsigned"; note?: string } {
  const local = names.find((n) => !hasPublicDns(n));
  if (!local || fleet.config.tls.issuer !== "letsencrypt" || fleet.config.tls.acme_server) return {};
  return { issuer: "selfsigned", note: `tls selfsigned: ${local} has no public DNS a CA could check (--tls letsencrypt to override)` };
}

/** A branch the repo does not have is refused now, not at the first deploy (when the repo can be read from here). */
function assertBranch(repo: string, branch: string, retry: (b: string) => string): void {
  const branches = remoteBranches(repo);
  if (!branches || branches.includes(branch)) return;
  if (!branches.length) fail("unknown_branch", `${repo} has no branches yet — nothing to deploy`, "push a first commit");
  const guess = branches.find((b) => b === "main" || b === "master") ?? branches[0]!;
  fail("unknown_branch", `${repo} has no branch "${branch}"`, `its branches: ${branches.slice(0, 10).join(", ")}${branches.length > 10 ? ", …" : ""}`, retry(guess));
}

/** The preset a site gets: what it was told, else what its repo looks like, else laravel. */
function choosePreset(input: Record<string, unknown>, repo: string | undefined, branch: string): { preset: string; webDir?: string; start?: string; note: string } {
  let preset = input.preset ? String(input.preset) : input.start ? "node" : undefined;
  const start = input.start ? String(input.start) : undefined;
  if (preset && (preset !== "node" || start)) return { preset, start, note: "" };
  const d = repo ? detectPreset(repo, branch) : { error: "no --repo to look at" };
  if ("error" in d) return { preset: preset ?? "laravel", start, note: preset ? "" : `preset laravel by default — ${d.error}; pass --preset if it is no Laravel app` };
  if (preset === "node" && d.preset !== "node") return { preset, note: "" };
  preset ??= d.preset;
  return { preset, webDir: d.web_dir, start: d.start, note: `preset ${preset}${d.start ? `, start '${d.start}'` : ""}${d.web_dir ? `, serves ${d.web_dir}/` : ""} (found ${d.why})` };
}

/** preset node runs on bun or node: the one its start command names joins the server's tools. */
function ensureRuntime(doc: YAML.Document, server: Server, start: string): string | undefined {
  const tool = /^\s*bun\b/.test(start) ? "bun" : "node";
  if (server.tools.includes(tool)) return undefined;
  doc.setIn(["tools"], doc.createNode([...server.tools, tool]));
  return `${tool} added to ${server.server}'s tools (the start command needs it)`;
}

defineCommand({
  name: "site add",
  summary: "add a site to a server in the fleet config (then `fornax plan` + `fornax apply`); --preview names it for you under the fleet's preview_domain",
  tier: "write",
  args: [
    { name: "server", help: "server name", required: true },
    { name: "domain", help: "primary domain (leave out with --preview)" },
  ],
  options: {
    preview: { type: "boolean", help: "a made-up name under preview_domain (e.g. quiet-harbor.example.com; without preview_domain under the server's IP, e.g. quiet-harbor.192-0-2-10.sslip.io): the site's domain without one, else an extra alias" },
    repo: { type: "string", help: "git repo: owner/name (GitHub), git@…, https://… or file:///…" },
    branch: { type: "string", help: "branch to deploy", default: "main" },
    preset: { type: "string", help: "laravel | php (both serve public/ of the repo) | static (serves the repo root) | node (proxies to the app's own server); default: what the repo looks like (artisan → laravel, index.php → php, a start script → node, else static), laravel when it cannot be read from here" },
    "web-dir": { type: "string", help: "the directory nginx serves, inside the repo (default: public for laravel/php, the root for static)" },
    start: { type: "string", help: "--preset node: the command that starts the app, e.g. 'bun run start'" },
    php: { type: "string", help: "PHP version (default: the server's default)" },
    user: { type: "string", help: "Linux user (default: first label of the domain)" },
    db: { type: "string", help: "create a database: mysql | postgres" },
    alias: { type: "list", help: "additional domains" },
    redis: { type: "string", help: "own (a Redis only this site reaches) | shared (the server's) | none — default: own for laravel, none for the other presets" },
    tls: { type: "string", help: "letsencrypt | selfsigned | none (default: tls.issuer in fornax.yaml — letsencrypt in a new fleet; selfsigned for names without public DNS: .test, .local, a private IP's sslip.io name)" },
    www: { type: "boolean", help: "redirect www.<domain> to <domain>" },
    daemon: { type: "list", help: "daemon command(s), e.g. 'php artisan horizon'" },
    schedule: { type: "boolean", help: "run the Laravel scheduler every minute" },
  },
  examples: [
    "fornax site add web-1 shop.example.com --repo acme/shop --db postgres --schedule --daemon 'php8.4 artisan horizon'",
    "fornax site add web-1 docs.example.com --repo acme/docs --preset static",
    "fornax site add web-1 app.example.com --repo acme/app --preset node --start 'bun run start'",
    "fornax site add web-1 --preview --repo acme/demo   # e.g. quiet-harbor.example.com",
  ],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    if (!input.domain && !input.preview) fail("missing_argument", "a domain is needed (or --preview for a made-up one)", undefined, `fornax site add ${server.server} --preview`);
    if (input.domain && isIPv4(String(input.domain))) {
      const name = sslipDomain(String(input.domain));
      fail("invalid_argument", `${input.domain} is an IP address, not a domain — a site needs a name (for its vhost and certificate)`, `${name} is one: sslip.io resolves it to ${input.domain}, no DNS setup needed`, `fornax site add ${server.server} ${name}`);
    }
    const preview = input.preview ? newPreviewName(fleet, server) : undefined;
    const domain = (input.domain ? String(input.domain) : preview!).toLowerCase();
    if (input.domain && preview) input.alias = [...((input.alias as string[] | undefined) ?? []), preview];
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) fail("invalid_argument", `"${domain}" is not a domain name`);
    for (const s of fleet.servers.values()) {
      if (s.sites[domain]) fail("exists", `site ${domain} already exists on ${s.server}`, undefined, `fornax explain ${domain} --offline`);
    }
    if (input.preset !== undefined && !(PRESETS as readonly string[]).includes(String(input.preset))) fail("invalid_option", `unknown preset "${input.preset}"`, `one of: ${PRESETS.join(", ")}`);
    const allowed = fleet.config.policies.allowed_repo_owners;
    if (input.repo && allowed) {
      const owner = repoOwner(String(input.repo));
      if (!owner || !allowed.includes(owner)) {
        fail("policy_violation", `repo "${input.repo}" is not owned by ${allowed.join(" or ")}`, "this fleet's policies.allowed_repo_owners forbids it");
      }
    }
    if (input.repo) assertBranch(String(input.repo), String(input.branch), (b) => `fornax site add ${server.server} ${input.domain ?? "--preview"} --repo ${input.repo} --branch ${b}`);
    const chosen = choosePreset(input, input.repo ? String(input.repo) : undefined, String(input.branch));
    const site: Record<string, unknown> = {};
    if (input.repo) site.repo = String(input.repo);
    if (input.branch !== "main") site.branch = input.branch;
    if (chosen.preset !== "laravel") site.preset = chosen.preset;
    if ((chosen.preset === "node") !== Boolean(chosen.start)) {
      fail("invalid_option", chosen.start ? "--start is for --preset node" : "--preset node needs --start, the command that starts the app", "e.g. --start 'bun run start' or --start 'node .next/standalone/server.js'");
    }
    if (chosen.start) site.node = { start: chosen.start };
    if (input.php) site.php = String(input.php);
    if (input.user) site.user = String(input.user);
    if (input.db) {
      if (!["mysql", "postgres"].includes(String(input.db))) fail("invalid_option", "--db must be mysql or postgres");
      site.db = { engine: String(input.db) };
    }
    if ((input.alias as string[] | undefined)?.length) site.aliases = input.alias;
    if (input.redis !== undefined) {
      if (!["own", "shared", "none"].includes(String(input.redis))) fail("invalid_option", "--redis must be own, shared or none");
      site.redis = { instance: String(input.redis) };
    }
    const auto = input.tls ? {} : tlsFor(fleet, [domain, ...((input.alias as string[] | undefined) ?? []), ...(input.www ? [`www.${domain}`] : [])]);
    if (input.tls || auto.issuer) site.tls = { issuer: String(input.tls ?? auto.issuer) };
    if (input.www) site.www_redirect = true;
    const webDir = input.webDir ?? chosen.webDir;
    if (webDir !== undefined) site.web_dir = String(webDir);
    if (input.schedule) site.schedule = true;
    if ((input.daemon as string[] | undefined)?.length) site.daemons = (input.daemon as string[]).map((cmd) => ({ cmd }));
    let runtime: string | undefined;
    const path = editServerFile(fleet, server.server, (doc) => {
      doc.setIn(["sites", domain], doc.createNode(site));
      if (chosen.start) runtime = ensureRuntime(doc, server, chosen.start);
    });
    // validate the result as a whole (user collisions, php versions, policies)
    const after = loadFleet(ctx);
    assertPolicies(after, getServer(after, server.server));
    const { site: resolved } = findSite(after, domain);
    // the first site on a server comes with the server's own setup (nginx, PHP …); later ones are a plan
    const first = sites(after, getServer(after, server.server)).filter((x) => x.spec.state === "present").length === 1 || !everPlannedWhole(after, server.server);
    const next = first ? `fornax server provision ${server.server}` : `fornax plan ${server.server} --site ${domain}`;
    // a server set up for its first site: databases nobody asked for are said before provision installs them
    const srv = getServer(after, server.server);
    const unused = first && !/^services:/m.test(readFileSync(path, "utf8")) ? (["mysql", "postgres"] as const).filter((x) => srv.services.includes(x) && !sites(after, srv).some((y) => y.db?.engine === x)) : [];
    const lean = unused.length ? `provision would also install ${unused.join(" and ")}, which no site uses — leave ${unused.length > 1 ? "them" : "it"} out: fornax server set ${server.server} --services ${srv.services.filter((x) => !(unused as string[]).includes(x)).join(",")}` : undefined;
    // a deploy clones on the server: a path in the repo is one there, whatever fornax read here
    const local = input.repo && /^(file:\/\/|\/)/.test(String(input.repo)) ? `${input.repo} is a path on the server: the deploy clones it there (fornax read it here for the preset only) — the server needs that path, e.g. a bare repo you push to; GitHub repos deploy on every push` : undefined;
    const notes = [chosen.note, auto.note, runtime, lean, local].filter(Boolean) as string[];
    return {
      data: { added: domain, server: server.server, file: path, preset: resolved.spec.preset, user: resolved.user, php: resolved.php, root: resolved.root, serves: resolved.webRoot, tls: resolved.tlsIssuer, notes, next },
      human: [
        `added ${domain} to ${server.server} (${path})`,
        `preset ${resolved.spec.preset}, user ${resolved.user}, ${resolved.node ? `runs '${resolved.node.start}' behind nginx` : `php ${resolved.php}, serves ${resolved.webRoot}`}, tls ${resolved.tlsIssuer}`,
        ...notes.map((n) => `note: ${n}`),
        `next: ${next}${first ? "   (the server is not set up from this fleet repo yet: installs and configures everything, then the site)" : ", then fornax apply <plan-id>"}`,
      ].join("\n"),
    };
  },
});

defineCommand({
  name: "site set",
  summary: "change a site's settings in the fleet config (then `fornax plan` + `fornax apply`)",
  tier: "write",
  args: [{ name: "site", help: "site domain", required: true }],
  options: {
    preset: { type: "string", help: `${PRESETS.join(" | ")}` },
    "web-dir": { type: "string", help: "the directory nginx serves, inside the repo (. for the root)" },
    start: { type: "string", help: "preset node: the command that starts the app" },
    php: { type: "string", help: "PHP version" },
    tls: { type: "string", help: "letsencrypt | selfsigned | none" },
    repo: { type: "string", help: "git repo: owner/name (GitHub), git@…, https://… or file:///…" },
    branch: { type: "string", help: "branch to deploy" },
    www: { type: "boolean", help: "redirect www.<domain> to <domain> (--no-www: stop)" },
    schedule: { type: "boolean", help: "run the Laravel scheduler every minute (--no-schedule: stop)" },
    "health-check": { type: "string", help: "path a new release must answer before it goes live, e.g. /up" },
    redis: { type: "string", help: "own | shared | none" },
  },
  examples: ["fornax site set shop.example.com --preset php", "fornax site set docs.example.com --preset static --web-dir dist", "fornax site set app.example.com --tls selfsigned --no-www"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    const keys = ["preset", "webDir", "start", "php", "tls", "repo", "branch", "www", "schedule", "healthCheck", "redis"];
    if (input.redis !== undefined && !["own", "shared", "none"].includes(String(input.redis))) fail("invalid_option", "--redis must be own, shared or none");
    if (!keys.some((k) => input[k] !== undefined)) fail("missing_option", "nothing to change", "pass one or more options, e.g. --preset php", `fornax site set --help`);
    if (input.preset !== undefined && !(PRESETS as readonly string[]).includes(String(input.preset))) fail("invalid_option", `unknown preset "${input.preset}"`, `one of: ${PRESETS.join(", ")}`);
    if (input.tls !== undefined && !["letsencrypt", "selfsigned", "none"].includes(String(input.tls))) fail("invalid_option", "--tls must be letsencrypt, selfsigned or none");
    const allowed = fleet.config.policies.allowed_repo_owners;
    if (input.repo && allowed && !allowed.includes(repoOwner(String(input.repo)) ?? "")) fail("policy_violation", `repo "${input.repo}" is not owned by ${allowed.join(" or ")}`, "this fleet's policies.allowed_repo_owners forbids it");
    const repo = input.repo ?? site.spec.repo;
    if (repo && (input.repo !== undefined || input.branch !== undefined)) assertBranch(String(repo), String(input.branch ?? site.spec.branch), (b) => `fornax site set ${site.domain} --branch ${b}`);
    const preset = String(input.preset ?? site.spec.preset);
    let start = input.start !== undefined ? String(input.start) : site.spec.node?.start;
    let found = "";
    if (preset === "node" && !start && site.spec.repo) {
      const d = detectPreset(String(input.repo ?? site.spec.repo), String(input.branch ?? site.spec.branch));
      if (!("error" in d) && d.start) [start, found] = [d.start, `start '${d.start}' (found ${d.why})`];
    }
    if (preset === "node" && !start) fail("invalid_option", "preset node needs --start, the command that starts the app", "e.g. --start 'bun run start' or --start 'node .next/standalone/server.js'");
    if (preset !== "node" && input.start !== undefined) fail("invalid_option", "--start is for preset node", `the site's preset is ${preset}`);
    const at = (...k: string[]) => ["sites", site.domain, ...k];
    const changed: string[] = [];
    let runtime: string | undefined;
    const before = readFileSync(fleet.files.get(server.server)!, "utf8");
    const path = editServerFile(fleet, server.server, (doc) => {
      const set = (k: string[], v: unknown, label: string) => {
        doc.setIn(at(...k), typeof v === "object" ? doc.createNode(v) : v);
        changed.push(label);
      };
      if (input.preset !== undefined) set(["preset"], preset, `preset ${preset}`);
      if (preset === "node") {
        if (start !== site.spec.node?.start) set(["node", "start"], start, `start '${start}'`);
        runtime = ensureRuntime(doc, server, start!);
      } else if (site.spec.node) {
        doc.deleteIn(at("node"));
        changed.push("node: removed (not preset node)");
      }
      if (input.webDir !== undefined) set(["web_dir"], String(input.webDir) || ".", `web_dir ${String(input.webDir) || "."}`);
      if (input.php !== undefined) set(["php"], String(input.php), `php ${input.php}`);
      if (input.tls !== undefined) set(["tls", "issuer"], String(input.tls), `tls ${input.tls}`);
      if (input.repo !== undefined) set(["repo"], String(input.repo), `repo ${input.repo}`);
      if (input.branch !== undefined) set(["branch"], String(input.branch), `branch ${input.branch}`);
      if (input.www !== undefined) set(["www_redirect"], Boolean(input.www), `www_redirect ${Boolean(input.www)}`);
      if (input.schedule !== undefined) set(["schedule"], Boolean(input.schedule), `schedule ${Boolean(input.schedule)}`);
      if (input.redis !== undefined) set(["redis", "instance"], String(input.redis), `redis ${input.redis}`);
      if (input.healthCheck !== undefined) set(["health_check"], String(input.healthCheck), `health_check ${input.healthCheck}`);
    });
    // the fleet as a whole decides (PHP versions, tools, policies): a change it refuses is undone
    try {
      const after = loadFleet(ctx);
      assertPolicies(after, getServer(after, server.server));
    } catch (e) {
      writeFileSync(path, before);
      throw e;
    }
    const { site: resolved } = findSite(loadFleet(ctx), site.domain);
    const notes = [found, runtime].filter(Boolean) as string[];
    const fresh = !everPlannedWhole(loadFleet(ctx), server.server);
    const next = fresh ? `fornax server provision ${server.server}` : `fornax plan ${server.server} --site ${site.domain}`;
    return {
      data: { site: site.domain, server: server.server, file: path, changed, preset: resolved.spec.preset, serves: resolved.webRoot, tls: resolved.tlsIssuer, notes, next },
      human: [...changed.map((c) => `~ ${c}`), `${resolved.node ? `runs '${resolved.node.start}' behind nginx` : `serves ${resolved.webRoot}`}, tls ${resolved.tlsIssuer}`, ...notes.map((n) => `note: ${n}`), `next: ${next}${fresh ? "   (the server is not set up from this fleet repo yet: installs and configures everything)" : `, then fornax apply <plan-id> (and fornax deploy ${site.domain} if the build changes)`}`].join("\n"),
    };
  },
});

defineCommand({
  name: "site alias",
  summary: "add or remove names a site answers to; --preview adds a made-up one under the fleet's preview_domain (then `fornax plan` + `fornax apply`)",
  tier: "write",
  args: [{ name: "site", help: "site domain", required: true }],
  options: {
    add: { type: "list", help: "names to add" },
    remove: { type: "list", help: "names to remove" },
    preview: { type: "boolean", help: "add a made-up name under preview_domain, e.g. quiet-harbor.example.com" },
  },
  examples: ["fornax site alias shop.example.com --preview", "fornax site alias shop.example.com --add shop.example.net", "fornax site alias shop.example.com --remove old.example.net"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    const add = [...((input.add as string[] | undefined) ?? []).map((n) => n.toLowerCase()), ...(input.preview ? [newPreviewName(fleet, server)] : [])];
    const remove = ((input.remove as string[] | undefined) ?? []).map((n) => n.toLowerCase());
    if (!add.length && !remove.length) fail("missing_option", "nothing to do", "pass --add <name>, --remove <name> or --preview");
    const taken = new Set(fleetNames(fleet));
    for (const n of add) if (taken.has(n)) fail("exists", `${n} is already a name of a site in this fleet`);
    for (const n of remove) if (!site.spec.aliases.includes(n)) fail("invalid_option", `${n} is not an alias of ${site.domain}`, `aliases: ${site.spec.aliases.join(", ") || "none"}`);
    const aliases = [...site.spec.aliases.filter((n) => !remove.includes(n)), ...add];
    const path = editServerFile(fleet, server.server, (doc) => doc.setIn(["sites", site.domain, "aliases"], doc.createNode(aliases)));
    loadFleet(ctx); // validates the new names
    // what keeps a new name from working, said now rather than discovered in the browser
    const notes: string[] = [];
    if (add.length && !site.spec.generate.vhost) notes.push("the vhost is still Forge's (adopted): the new names take effect once it is converted (fornax site convert --only web)");
    if (add.length && (site.tlsIssuer === "existing" || site.tlsIssuer === "selfsigned")) notes.push(`its certificate (tls: ${site.tlsIssuer}) does not cover the new names — a Let's Encrypt one would: fornax site convert ${site.domain} --only tls, or tls.issuer letsencrypt`);
    return {
      data: { site: site.domain, added: add, removed: remove, aliases, file: path, notes, next: `fornax plan ${server.server}` },
      human: [
        ...add.map((n) => `+ ${n}`),
        ...remove.map((n) => `- ${n}`),
        ...notes.map((n) => `note: ${n}`),
        `next: fornax plan ${server.server}  (and fornax dns sync ${server.server}, unless a wildcard record already points the names at it)`,
      ].join("\n"),
    };
  },
});

defineCommand({
  name: "site remove",
  summary: "mark a site absent: removes its vhost, pool, daemons and cron on the next apply (--purge also deletes user, files, database)",
  tier: "destroy",
  args: [{ name: "site", help: "site domain", required: true }],
  options: { purge: { type: "boolean", help: "also delete the Linux user, home directory, database and certificate" } },
  examples: ["fornax site remove old.example.com --confirm=old.example.com", "fornax site remove old.example.com --purge --confirm=old.example.com"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    if (isProtected(fleet, site.domain)) fail("protected", `${site.domain} is protected by policy`, "remove it from policies.protected in fornax.yaml first");
    requireConfirm(input, site.domain);
    editServerFile(fleet, server.server, (doc) => {
      doc.setIn(["sites", site.domain, "state"], "absent");
      if (input.purge) doc.setIn(["sites", site.domain, "purge"], true);
    });
    return {
      data: { site: site.domain, server: server.server, state: "absent", purge: Boolean(input.purge), next: `fornax plan ${server.server} --site ${site.domain}` },
      human: `${site.domain} marked absent${input.purge ? " (purge)" : ""}\nnext: fornax plan ${server.server} --site ${site.domain}, then apply. Delete the entry from the YAML once applied.`,
    };
  },
});
