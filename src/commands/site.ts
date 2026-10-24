import { defineCommand, requireConfirm } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { assertPolicies, editServerFile, findSite, getServer, isProtected, loadFleet, repoOwner } from "../core/fleet.ts";
import { previewName } from "../core/names.ts";
import { PRESETS } from "../core/schema.ts";
import type { Fleet } from "../core/fleet.ts";

/** Every name a site of the fleet answers to (domains, aliases, www, proxies). */
function fleetNames(fleet: Fleet): string[] {
  return [...fleet.servers.values()].flatMap((s) => Object.entries(s.sites).flatMap(([d, x]) => [d, ...x.aliases, ...(x.www_redirect ? [`www.${d}`] : []), ...x.proxies.map((p) => p.domain)]));
}

/** A fresh two-word name under the fleet's preview_domain. */
function newPreviewName(fleet: Fleet): string {
  const pd = fleet.config.preview_domain;
  if (!pd) fail("no_preview_domain", "this fleet has no preview_domain", "set preview_domain: <a domain whose subdomains reach your servers, e.g. through a wildcard record> in fornax.yaml");
  return previewName(pd!, fleetNames(fleet));
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
    preview: { type: "boolean", help: "a made-up name under preview_domain (e.g. quiet-harbor.example.com): the site's domain without one, else an extra alias" },
    repo: { type: "string", help: "git repo: owner/name (GitHub), git@…, https://… or file:///…" },
    branch: { type: "string", help: "branch to deploy", default: "main" },
    preset: { type: "string", help: `deploy preset: ${PRESETS.join(", ")}`, default: "laravel" },
    php: { type: "string", help: "PHP version (default: the server's default)" },
    user: { type: "string", help: "Linux user (default: first label of the domain)" },
    db: { type: "string", help: "create a database: mysql | postgres" },
    alias: { type: "list", help: "additional domains" },
    tls: { type: "string", help: "letsencrypt | selfsigned | none (default: fleet setting)" },
    www: { type: "boolean", help: "redirect www.<domain> to <domain>" },
    daemon: { type: "list", help: "daemon command(s), e.g. 'php artisan horizon'" },
    schedule: { type: "boolean", help: "run the Laravel scheduler every minute" },
  },
  examples: [
    "fornax site add web-1 shop.example.com --repo acme/shop --db postgres --schedule --daemon 'php8.4 artisan horizon'",
    "fornax site add web-1 docs.example.com --repo acme/docs --preset static",
    "fornax site add web-1 --preview --repo acme/demo   # e.g. quiet-harbor.example.com",
  ],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    if (!input.domain && !input.preview) fail("missing_argument", "a domain is needed (or --preview for a made-up one)", undefined, `fornax site add ${server.server} --preview`);
    const preview = input.preview ? newPreviewName(fleet) : undefined;
    const domain = (input.domain ? String(input.domain) : preview!).toLowerCase();
    if (input.domain && preview) input.alias = [...((input.alias as string[] | undefined) ?? []), preview];
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) fail("invalid_argument", `"${domain}" is not a domain name`);
    for (const s of fleet.servers.values()) {
      if (s.sites[domain]) fail("exists", `site ${domain} already exists on ${s.server}`, undefined, `fornax explain ${domain} --offline`);
    }
    if (!(PRESETS as readonly string[]).includes(String(input.preset))) fail("invalid_option", `unknown preset "${input.preset}"`, `one of: ${PRESETS.join(", ")}`);
    const allowed = fleet.config.policies.allowed_repo_owners;
    if (input.repo && allowed) {
      const owner = repoOwner(String(input.repo));
      if (!owner || !allowed.includes(owner)) {
        fail("policy_violation", `repo "${input.repo}" is not owned by ${allowed.join(" or ")}`, "this fleet's policies.allowed_repo_owners forbids it");
      }
    }
    const site: Record<string, unknown> = {};
    if (input.repo) site.repo = String(input.repo);
    if (input.branch !== "main") site.branch = input.branch;
    if (input.preset !== "laravel") site.preset = input.preset;
    if (input.php) site.php = String(input.php);
    if (input.user) site.user = String(input.user);
    if (input.db) {
      if (!["mysql", "postgres"].includes(String(input.db))) fail("invalid_option", "--db must be mysql or postgres");
      site.db = { engine: String(input.db) };
    }
    if ((input.alias as string[] | undefined)?.length) site.aliases = input.alias;
    if (input.tls) site.tls = { issuer: String(input.tls) };
    if (input.www) site.www_redirect = true;
    if (input.schedule) site.schedule = true;
    if ((input.daemon as string[] | undefined)?.length) site.daemons = (input.daemon as string[]).map((cmd) => ({ cmd }));
    const path = editServerFile(fleet, server.server, (doc) => doc.setIn(["sites", domain], doc.createNode(site)));
    // validate the result as a whole (user collisions, php versions, policies)
    const after = loadFleet(ctx);
    assertPolicies(after, getServer(after, server.server));
    const { site: resolved } = findSite(after, domain);
    return {
      data: { added: domain, server: server.server, file: path, user: resolved.user, php: resolved.php, root: resolved.root, next: `fornax plan ${server.server} --site ${domain}` },
      human: `added ${domain} to ${server.server} (${path})\nuser ${resolved.user}, php ${resolved.php}, root ${resolved.root}\nnext: fornax plan ${server.server} --site ${domain}`,
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
    const add = [...((input.add as string[] | undefined) ?? []).map((n) => n.toLowerCase()), ...(input.preview ? [newPreviewName(fleet)] : [])];
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
  args: [{ name: "domain", help: "site domain", required: true }],
  options: { purge: { type: "boolean", help: "also delete the Linux user, home directory, database and certificate" } },
  examples: ["fornax site remove old.example.com --confirm=old.example.com", "fornax site remove old.example.com --purge --confirm=old.example.com"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.domain));
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
