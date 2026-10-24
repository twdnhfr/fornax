/**
 * Convert an adopted Forge site to fornax-generated configuration, one area at a time.
 * Only the fleet repo changes here; `fornax plan` + `apply` then do the work on the server.
 *
 *   cron      Forge's /etc/crontab lines  → /etc/cron.d/fornax-<site>
 *   logrotate forge-<id>                  → fornax-<site>
 *   daemons   daemon-<id>.conf            → fornax-<site>-<name>.conf
 *   web       Forge vhost + forge-conf/ + www-<user> pool → fornax vhost (+ snippets) + fornax pool
 *   tls       Forge certificate + renew cron → certbot (needs `web` applied first)
 *   deploy    fornax deploys — releases, or in place like Forge (push-to-deploy: `fornax git connect <site> --replace-forge`)
 *   finalize  drop the adopted marker and the copies of Forge's files
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";
import { fail } from "../core/errors.ts";
import { editServerFile, type Fleet } from "../core/fleet.ts";
import type { FileSpec, Server, Site } from "../core/schema.ts";
import { forgeProxy, plainAlias, vhostExtras, type VhostExtras } from "./vhost.ts";

export const AREAS = ["cron", "logrotate", "daemons", "web", "tls", "deploy", "finalize"] as const;
export type Area = (typeof AREAS)[number];

export interface ConvertResult {
  site: string;
  areas: Area[];
  changes: string[];
  warnings: string[];
  snippets: string[];
}

const isPool = (p: string) => /^\/etc\/php\/[^/]+\/fpm\/pool\.d\//.test(p);

export function convertSite(fleet: Fleet, server: Server, domain: string, areas: Area[]): ConvertResult {
  const raw = (YAML.parse(readFileSync(fleet.files.get(server.server)!, "utf8")) as { sites: Record<string, Record<string, unknown>> }).sites[domain];
  if (!raw) fail("unknown_site", `no site ${domain} on ${server.server}`);
  const site = structuredClone(raw) as Record<string, any>;
  const spec = server.sites[domain] as Site;
  if (!spec.adopted) fail("not_adopted", `${domain} is not an adopted site — nothing to convert`);
  const origin = spec.origin!;
  if (!spec.origin) fail("no_origin", `${domain} has no Forge origin data`, "re-import the server with this fornax version (fornax import forge … --force)");
  const res: ConvertResult = { site: domain, areas, changes: [], warnings: [], snippets: [] };
  site.generate = { vhost: false, pool: false, daemons: false, cron: false, logrotate: false, ...(site.generate ?? {}) };
  site.files = [...(site.files ?? [])] as FileSpec[];
  site.retire = [...(site.retire ?? [])] as string[];
  const files = () => site.files as FileSpec[];
  const retire = (pred: (f: FileSpec) => boolean, why: string) => {
    const hit = files().filter(pred);
    site.files = files().filter((f) => !pred(f));
    for (const f of hit) {
      if (!site.retire.includes(f.path)) site.retire.push(f.path);
      res.changes.push(`retire ${f.path} (${why})`);
    }
    return hit;
  };
  const user = spec.user ?? domain.split(".")[0];
  const read = (f: FileSpec) => (f.source ? readFileSync(join(fleet.dir, f.source), "utf8") : (f.content ?? ""));
  // before anything is written: hand edits in Forge's vhost must come along, or the conversion stops
  const extras = areas.includes("web") ? checkVhost(domain, spec, files(), read) : undefined;

  for (const area of areas) {
    switch (area) {
      case "cron": {
        const jobs = origin.cron ?? [];
        const schedule = jobs.some((j) => /artisan\s+schedule:run/.test(j.cmd));
        const other = jobs.filter((j) => !/artisan\s+schedule:run/.test(j.cmd));
        if (schedule) site.schedule = true;
        if (other.length) site.cron = [...(site.cron ?? []), ...other.map((j) => ({ at: j.at, cmd: j.cmd }))];
        site.generate.cron = true;
        // the same jobs leave the adopted /etc/crontab, in the same apply — never twice, never none
        const crontab = server.files.find((f) => f.path === "/etc/crontab" && f.source);
        if (crontab) {
          const p = join(fleet.dir, crontab.source!);
          const lines = readFileSync(p, "utf8").split("\n");
          const isJob = (l: string) => Boolean(l.trim()) && !l.trim().startsWith("#") && l.trim().split(/\s+/)[5] === user;
          // Forge writes "# Laravel Forge Scheduler <id>" above each job; it goes with the job
          const kept = lines.filter((l, i) => !isJob(l) && !(/^# Laravel Forge Scheduler \d+$/.test(l.trim()) && lines[i + 1] !== undefined && isJob(lines[i + 1]!)));
          writeFileSync(p, kept.join("\n"));
          res.changes.push(`move ${lines.length - kept.length} cron line(s) of ${user} from /etc/crontab to /etc/cron.d`);
        } else if (jobs.length) res.warnings.push("no adopted /etc/crontab in the server config — remove Forge's cron lines for this site by hand");
        break;
      }
      case "logrotate":
        site.generate.logrotate = true;
        retire((f) => f.path === `/etc/logrotate.d/forge-${origin.site_id}`, "replaced by fornax-<site>");
        break;
      case "daemons":
        site.generate.daemons = true;
        for (const d of (site.daemons ?? []) as Array<{ program?: string }>) {
          if (d.program) retire((f) => f.path === `/etc/supervisor/conf.d/${d.program}.conf`, "replaced by fornax's program");
          delete d.program;
        }
        break;
      case "web": {
        site.generate.vhost = true;
        site.generate.pool = true;
        retire((f) => isPool(f.path), "replaced by fornax's pool");
        // fornax writes the same vhost path itself
        site.files = files().filter((f) => f.path !== `/etc/nginx/sites-available/${domain}`);
        const forgeConf = files().filter((f) => f.path.startsWith("/etc/nginx/forge-conf/"));
        for (const f of forgeConf) {
          const rel = f.path.replace(/^\/etc\/nginx\/forge-conf\/[^/]+\//, "");
          const name = basename(f.path);
          const content = f.source ? readFileSync(join(fleet.dir, f.source), "utf8") : (f.content ?? "");
          if (rel === "site.conf") retire((x) => x.path === f.path, "covered by fornax's vhost template");
          else if (/(^|\/)before\/ssl_redirect\.conf$/.test(rel)) retire((x) => x.path === f.path, "fornax redirects http → https itself");
          else if (/(^|\/)before\/redirect\.conf$/.test(rel)) {
            if (/www\./.test(content)) site.www_redirect = true;
            retire((x) => x.path === f.path, "www redirect is the site setting www_redirect");
          } else if (/^server\//.test(rel)) {
            const snippet = writeSnippet(fleet, domain, name, content);
            site.nginx = { server: [], http: [], ...(site.nginx ?? {}) };
            if (!site.nginx.server.includes(snippet)) site.nginx.server.push(snippet);
            res.snippets.push(snippet);
            retire((x) => x.path === f.path, `now the snippet ${snippet}`);
          } else {
            const snippet = writeSnippet(fleet, domain, `${rel.replace(/\//g, "-")}`, content);
            site.nginx = { server: [], http: [], ...(site.nginx ?? {}) };
            if (!site.nginx.http.includes(snippet)) site.nginx.http.push(snippet);
            res.snippets.push(snippet);
            retire((x) => x.path === f.path, `now the http-level snippet ${snippet}`);
            res.warnings.push(`${f.path} is not a standard Forge file — kept as http-level snippet ${snippet}; check it in the plan diff`);
          }
        }
        // alias domains had vhost files of their own at Forge; fornax serves them from the main vhost
        for (const alias of spec.aliases) {
          for (const p of [`/etc/nginx/sites-available/${alias}`, `/etc/nginx/sites-enabled/${alias}`]) {
            site.files = files().filter((f) => f.path !== p);
            if (!site.retire.includes(p)) {
              site.retire.push(p);
              res.changes.push(`retire ${p} (alias is served by the main vhost)`);
            }
          }
        }
        for (const p of extras?.proxies ?? []) {
          site.aliases = (site.aliases ?? []).filter((a: string) => a !== p.domain);
          if (!site.aliases.length) delete site.aliases;
          site.proxies = [...(site.proxies ?? []).filter((x: { domain: string }) => x.domain !== p.domain), { domain: p.domain, port: p.port, ...(spec.tls.issuer === "existing" && p.cert && p.key ? { cert: p.cert, key: p.key } : {}) }];
          res.changes.push(`${p.domain} becomes a proxy to 127.0.0.1:${p.port} (websocket) instead of an alias`);
          if (p.host === "0.0.0.0") res.warnings.push(`the server behind ${p.domain} listens on 0.0.0.0:${p.port} — reachable without nginx where the firewall allows it; bind it to 127.0.0.1 (Reverb: --host=127.0.0.1)`);
        }
        if (extras?.http.length) {
          const snippet = writeSnippet(fleet, domain, "vhost-http", extras.http.join("\n\n") + "\n");
          site.nginx = { server: [], http: [], ...(site.nginx ?? {}) };
          if (!site.nginx.http.includes(snippet)) site.nginx.http.push(snippet);
          res.snippets.push(snippet);
          res.warnings.push(`hand edits outside the server block of Forge's vhost kept as ${snippet}:\n${indent(extras.http.join("\n"))}`);
        }
        if (extras?.server.length) {
          const snippet = writeSnippet(fleet, domain, "vhost-server", extras.server.join("\n\n") + "\n");
          site.nginx = { server: [], http: [], ...(site.nginx ?? {}) };
          if (!site.nginx.server.includes(snippet)) site.nginx.server.push(snippet);
          res.snippets.push(snippet);
          res.warnings.push(`hand edits inside the server block of Forge's vhost kept as ${snippet} (also used for the pre-activation health check):\n${indent(extras.server.join("\n"))}`);
        }
        res.changes.push(spec.preset === "static" ? "generate vhost (static: no PHP-FPM pool)" : "generate vhost and PHP-FPM pool (Forge's pool sizing is kept)");
        break;
      }
      case "tls": {
        if (!spec.generate.vhost) {
          fail("convert_order", `${domain}: convert and apply "web" before "tls"`, "Forge's vhost answers the ACME challenge from its own directory, so certbot cannot validate until fornax's vhost is live", `fornax site convert ${domain} --only web`);
        }
        site.tls = { issuer: fleet.config.tls.issuer === "none" ? "letsencrypt" : fleet.config.tls.issuer };
        for (const id of origin.domain_ids) {
          const p = `/etc/cron.d/letsencrypt-renew-domain-${id}`;
          if (!site.retire.includes(p)) site.retire.push(p);
          res.changes.push(`retire ${p} (Forge's renewal; certbot's timer takes over)`);
        }
        res.changes.push(`certificate from ${site.tls.issuer} (the Forge certificate stays on disk, unused)`);
        break;
      }
      case "deploy":
        if (origin.zero_downtime) {
          const p = join(fleet.dir, "adopted", server.server, "forge", `${domain}.deploy.sh`);
          const t = existsSync(p) ? forgeBuildCommands(readFileSync(p, "utf8"), `/home/${user}/${domain}`) : undefined;
          // Forge's own steps in Forge's order (e.g. no frontend build, or artisan optimize before it)
          site.deploy = { ...(site.deploy ?? {}), enabled: true, ...(t?.commands ? { commands: t.commands } : {}) };
          res.changes.push("deploys by fornax (releases/<timestamp>, health check before activation)");
          if (t?.commands) res.changes.push(`build commands from Forge's deploy script (used while the repo has no ${spec.deploy.script}):\n${t.commands.replace(/^/gm, "      ")}`);
          if (t?.dropped.length) res.changes.push(`left out (fornax does this itself): ${t.dropped.map((l) => l.trim()).join(" · ")}`);
          if (t?.afterActivation.length) res.warnings.push(`these ran after activation at Forge and now run before it: ${t.afterActivation.join(" · ")}`);
          if (t?.unknown.length) res.warnings.push(`Forge variables fornax does not set: ${t.unknown.join(", ")} — edit deploy.commands`);
        } else {
          const p = join(fleet.dir, "adopted", server.server, "forge", `${domain}.deploy.sh`);
          const t = existsSync(p) ? forgeBuildCommands(readFileSync(p, "utf8"), `/home/${user}/${domain}`) : undefined;
          site.deploy = { ...(site.deploy ?? {}), enabled: true, mode: "in_place", ...(t?.commands ? { commands: t.commands } : {}) };
          res.changes.push("deploys by fornax in place, like Forge: fetch, reset to the commit, build in the site directory");
          if (t?.commands) res.changes.push(`build commands from Forge's deploy script (used while the repo has no ${spec.deploy.script}):\n${t.commands.replace(/^/gm, "      ")}`);
          if (t?.dropped.length) res.changes.push(`left out (fornax does this itself): ${t.dropped.map((l) => l.trim()).join(" · ")}`);
          if (t?.unknown.length) res.warnings.push(`Forge variables fornax does not set: ${t.unknown.join(", ")} — edit deploy.commands`);
          if (!t) res.warnings.push(`no copy of Forge's deploy script at ${p} — set deploy.commands or add ${spec.deploy.script} to the repo`);
        }
        res.warnings.push(
          site.generate?.vhost !== false || server.webhook?.domain
            ? `push-to-deploy: run \`fornax git connect ${domain} --replace-forge\` after the apply — it adds fornax's webhook (on the site's own domain) and removes Forge's, so pushes never deploy twice`
            : `push-to-deploy needs the site's vhost from fornax (convert --only web) or webhook.domain on ${server.server}; until then deploy with \`fornax deploy ${domain}\` — and remove Forge's webhook, or Forge keeps deploying pushes`,
        );
        break;
      case "finalize": {
        const g = site.generate;
        const pending = [
          ...(["vhost", "pool", "daemons", "cron", "logrotate"] as const).filter((k) => !g[k]),
          ...(spec.tls.issuer === "existing" && site.tls?.issuer !== "letsencrypt" ? ["tls"] : []),
          ...(!(site.deploy?.enabled ?? spec.deploy.enabled) ? ["deploy"] : []),
        ];
        if (pending.length) fail("convert_incomplete", `${domain} still has Forge parts: ${pending.join(", ")}`, undefined, `fornax site convert ${domain} --only ${pending.join(",")}`);
        if (files().length) res.warnings.push(`still managed verbatim: ${files().map((f) => f.path).join(", ")}`);
        delete site.adopted;
        delete site.origin;
        res.changes.push("no longer adopted: fornax manages the whole site");
        break;
      }
    }
  }
  editServerFile(fleet, server.server, (doc) => doc.setIn(["sites", domain], doc.createNode(site)));
  return res;
}

/** After activation fornax restarts queues, Horizon, Reverb and SSR itself (supervisor programs). */
const RESTARTS = /^\$\{?FORGE_PHP\}?\s+artisan\s+(queue:restart|horizon:terminate|reverb:restart|inertia:stop-ssr|octane:reload|pulse:restart)\b/;

/**
 * Forge's deploy script as build commands: fornax clones or fetches, links shared paths, activates
 * and reloads itself. Works for in-place scripts and zero-downtime ones ($CREATE_RELEASE() …).
 */
export function forgeBuildCommands(script: string, sitePath?: string): { commands: string; dropped: string[]; unknown: string[]; afterActivation: string[] } {
  const out: string[] = [];
  const dropped: string[] = [];
  const afterActivation: string[] = [];
  let fpm = false;
  let activated = false;
  for (const l of script.replace(/\r/g, "").split("\n")) {
    const t = l.trim();
    // Forge's FPM reload: ( flock -w 10 9 || exit 1 … ) 9>/tmp/fpmlock
    if (fpm || /^\(\s*flock\b/.test(t)) {
      dropped.push(l);
      fpm = !/\)\s*9>\s*\/tmp\/fpmlock/.test(t);
      continue;
    }
    if (/^\$(CREATE_RELEASE|RESTART_QUEUES)\(\)$/.test(t) || /^cd\s+("?)\$\{?FORGE_(SITE_PATH|RELEASE_DIRECTORY)\}?\1\s*$/.test(t) || /^git\s+pull\b/.test(t) || RESTARTS.test(t)) {
      dropped.push(l);
      continue;
    }
    if (t === "$ACTIVATE_RELEASE()") {
      dropped.push(l);
      activated = true;
      continue;
    }
    if (activated && t && !t.startsWith("#")) afterActivation.push(t);
    out.push(
      l
        .replace(/\$\{?FORGE_COMPOSER\}?(?![A-Z_])/g, "$FORNAX_COMPOSER")
        .replace(/\$\{?FORGE_PHP\}?(?![A-Z_])/g, "$FORNAX_PHP")
        .replace(/\$\{?FORGE_RELEASE_DIRECTORY\}?(?![A-Z_])/g, "$FORNAX_RELEASE_PATH")
        .replace(/\$\{?FORGE_SITE_PATH\}?(?![A-Z_])/g, "$FORNAX_SITE_PATH")
        // the site's path spelled out (e.g. a shared directory) — the same on any server this way
        .split(sitePath ?? "\0")
        .join("$FORNAX_SITE_PATH"),
    );
  }
  const commands = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { commands, dropped, afterActivation, unknown: [...new Set(commands.match(/\$\{?FORGE_[A-Z_]+/g) ?? [])] };
}

const indent = (t: string) => t.replace(/^/gm, "      ");

type ForgeProxy = NonNullable<ReturnType<typeof forgeProxy>> & { domain: string };

function checkVhost(domain: string, spec: Site, files: FileSpec[], read: (f: FileSpec) => string): (VhostExtras & { proxies: ForgeProxy[] }) | undefined {
  const vhost = files.find((f) => f.path === `/etc/nginx/sites-available/${domain}`);
  if (!vhost) return undefined;
  const conf = files.find((f) => /^\/etc\/nginx\/forge-conf\/[^/]+\/site\.conf$/.test(f.path));
  const siteConf = conf ? read(conf) : "";
  const text = read(vhost);
  const x = vhostExtras(text, domain, siteConf);
  const problems = x.problems.map((p) => `${domain}: ${p}`);
  const root = text.match(/^\s*root\s+([^;]+);/m)?.[1]?.trim() ?? "";
  const proxies: ForgeProxy[] = [];
  for (const alias of spec.aliases) {
    const f = files.find((g) => g.path === `/etc/nginx/sites-available/${alias}`);
    const why = f ? plainAlias(read(f), alias, root, siteConf) : null;
    if (!why) continue;
    // Forge's websocket template (Reverb): becomes a proxy entry of the site
    const proxy = forgeProxy(read(f!), alias, siteConf);
    if (proxy) proxies.push({ domain: alias, ...proxy });
    else problems.push(`${alias} ${why}`);
  }
  if (problems.length) {
    fail(
      "convert_unsupported_vhost",
      `${domain}: Forge's nginx config has parts fornax cannot carry over safely`,
      `${problems.join("\n")}\nfornax's vhost would drop them — convert this site by hand, or remove that part on the server first. Nothing was changed.`,
    );
  }
  return { ...x, proxies };
}

function writeSnippet(fleet: Fleet, domain: string, name: string, content: string): string {
  const rel = `snippets/${domain}/${name.endsWith(".conf") ? name : `${name}.conf`}`;
  const p = join(fleet.dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return rel;
}

/** After finalize: copies of Forge files nobody references any more. */
export function unusedAdoptedFiles(fleet: Fleet, server: Server): string[] {
  const used = new Set([...server.files, ...Object.values(server.sites).flatMap((s) => s.files)].map((f) => f.source).filter(Boolean) as string[]);
  const dir = join(fleet.dir, "adopted", server.server);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of Bun.spawnSync(["find", d, "-type", "f"]).stdout.toString().split("\n").filter(Boolean)) out.push(e.slice(fleet.dir.length + 1));
  };
  walk(dir);
  return out.filter((p) => !used.has(p) && !p.includes("/forge/"));
}

export function removeFiles(fleet: Fleet, rels: string[]) {
  for (const r of rels) rmSync(join(fleet.dir, r), { force: true });
}
