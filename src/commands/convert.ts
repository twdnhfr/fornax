import { defineCommand } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { findSite, loadFleet } from "../core/fleet.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { assertPolicies, editServerFile, getServer } from "../core/fleet.ts";
import { MODULES } from "../core/schema.ts";
import { AREAS, convertSite, removeFiles, unusedAdoptedFiles, type Area } from "../forge/convert.ts";
import { planConversion, readServer, type ServerArea } from "../forge/server-convert.ts";

defineCommand({
  name: "site convert",
  summary: "switch an adopted (Forge) site to fornax-generated config, area by area — edits the fleet repo; plan + apply do the rest",
  tier: "write",
  args: [{ name: "site", help: "site domain", required: true }],
  options: { only: { type: "list", help: `areas, in this order: ${AREAS.join(",")}` } },
  examples: [
    "fornax site check shop.example.com            # before",
    "fornax site convert shop.example.com --only cron,logrotate,daemons",
    "fornax plan web-1 && fornax apply <id>",
    "fornax site convert shop.example.com --only web   # then plan/apply/check again; then tls, deploy, finalize",
  ],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    const areas = (input.only as string[] | undefined) ?? [];
    if (!areas.length) fail("missing_option", "--only is required", `convert step by step, in this order: ${AREAS.join(", ")}`, `fornax site convert ${site.domain} --only cron,logrotate,daemons`);
    for (const a of areas) if (!(AREAS as readonly string[]).includes(a)) fail("invalid_option", `unknown area "${a}"`, `one of: ${AREAS.join(", ")}`);
    if (areas.includes("web") && areas.includes("tls")) {
      fail("convert_order", "web and tls cannot be converted in one go", "apply web first: certbot can only validate once fornax's vhost answers", `fornax site convert ${site.domain} --only web`);
    }
    const ordered = AREAS.filter((a) => areas.includes(a)) as Area[];
    const res = convertSite(fleet, server, site.domain, ordered);
    let removed: string[] = [];
    if (ordered.includes("finalize")) {
      const after = loadFleet(ctx);
      removed = unusedAdoptedFiles(after, after.servers.get(server.server)!);
      removeFiles(after, removed);
    }
    const next = `fornax plan ${server.server} --site ${site.domain}`;
    return {
      data: { ...res, removed_copies: removed, next },
      human: [
        `${site.domain}: converted ${ordered.join(", ")} in the fleet repo`,
        ...res.changes.map((c) => `  ${c}`),
        ...res.snippets.map((s) => `  snippet ${s}`),
        ...res.warnings.map((w) => `  ! ${w}`),
        removed.length ? `  removed ${removed.length} copies of Forge files from the fleet repo` : "",
        `next: fornax site check ${site.domain}  →  ${next}  →  fornax apply <id>  →  fornax site check ${site.domain}`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

defineCommand({
  name: "site check",
  summary: "request a site through its server's address: status codes, redirects, certificate — run before and after changes and compare",
  tier: "read",
  args: [{ name: "site", help: "site domain", required: true }],
  options: {
    path: { type: "list", help: "paths to request (default: / and the health check)" },
    via: { type: "string", help: "host (how fornax reaches the server, default) or public (its public IPv4)", default: "host" },
    body: { type: "boolean", help: "also show the start of what the site's own domain answers (first 400 characters)" },
  },
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    if (!["host", "public"].includes(String(input.via))) fail("invalid_option", "--via must be host or public");
    if (input.via === "public" && !server.public_ipv4) fail("no_public_ip", `${server.server} has no public_ipv4 in its config`, `--via public asks the server's public address, as visitors reach it; give it one: fornax server set ${server.server} --public-ipv4 <ip> (--via host, the default, uses ${server.host})`);
    const addr = input.via === "public" ? server.public_ipv4! : server.host;
    const paths = (input.path as string[] | undefined) ?? ["/", ...(site.spec.health_check ? [site.spec.health_check] : [])];
    const results: { url: string; status: number | null; redirect: string | null; seconds: number; error?: string; body?: string }[] = [];
    const MARK = "\n@@fornax-check@@ ";
    // tls none: the site has no HTTPS to ask for
    const schemes = site.tlsIssuer === "none" ? (["http"] as const) : (["http", "https"] as const);
    for (const name of site.names) {
      for (const scheme of schemes) {
        for (const p of name === site.domain ? paths : ["/"]) {
          const port = scheme === "https" ? 443 : 80;
          // the body only where it is asked for: the final scheme of the site's own domain
          const withBody = Boolean(input.body) && name === site.domain && scheme === schemes[schemes.length - 1];
          const r = Bun.spawnSync([
            "curl", "-sSk", ...(withBody ? [] : ["-o", "/dev/null"]), "--max-time", "15", "--connect-to", `${name}:${port}:${addr}:${port}`,
            "-w", `${MARK}%{http_code} %{redirect_url} %{time_total}`, `${scheme}://${name}${p}`,
          ]);
          const out = r.stdout.toString();
          const at = out.lastIndexOf(MARK);
          const [code, redirect, time] = out.slice(at + MARK.length).split(" ");
          const body = withBody ? out.slice(0, at).slice(0, 400) : undefined;
          // no answer: curl says why (refused, timed out, TLS handshake …)
          const error = Number(code) ? undefined : r.stderr.toString().trim().split("\n").pop()?.replace(/^curl: \(\d+\) /, "") || `curl exit ${r.exitCode}`;
          results.push({ url: `${scheme}://${name}${p}`, status: Number(code) || null, redirect: redirect || null, seconds: Number(time), ...(error ? { error } : {}), ...(body !== undefined && !error ? { body } : {}) });
        }
      }
    }
    const cert = site.tlsIssuer === "none" ? "" : Bun.spawnSync(["bash", "-c", `openssl s_client -connect ${addr}:443 -servername ${site.domain} 2>/dev/null | openssl x509 -noout -issuer -enddate -ext subjectAltName 2>/dev/null`], { stdin: "ignore", timeout: 15_000 }).stdout.toString();
    const issuer = cert.match(/issuer=.*?(?:O\s*=\s*([^,\n]+))?.*?CN\s*=\s*([^\n]+)/)?.slice(1).filter(Boolean).join(" / ") ?? null;
    const expires = cert.match(/notAfter=(.*)/)?.[1] ?? null;
    const names = cert.match(/Subject Alternative Name:[^\n]*\n\s*([^\n]+)/)?.[1]?.split(",").map((n) => n.trim().replace(/^DNS:/, "")) ?? [];
    // --verbose: how long each answer took, every name the certificate covers, and which it misses
    const missing = names.length ? site.names.filter((n) => !names.includes(n) && !names.includes(n.replace(/^[^.]+/, "*"))) : [];
    const human = [
      ...results.map((r) => `${String(r.status ?? "ERR").padEnd(4)} ${r.url}${ctx.verbose && r.status ? ` (${r.seconds.toFixed(2)}s)` : ""}${r.redirect ? ` → ${r.redirect}` : ""}${r.error ? ` — ${r.error}` : ""}${r.body !== undefined ? `\n     ${r.body.replace(/\s+/g, " ").trim() || "(empty)"}` : ""}`),
      site.tlsIssuer === "none" ? "certificate: none (tls: none, HTTP only)" : `certificate: ${issuer ?? "none"}${expires ? `, until ${expires}` : ""}`,
      ...(ctx.verbose && names.length ? [`  covers: ${names.join(", ")}`] : []),
      ...(missing.length ? [`  ! does not cover: ${missing.join(", ")}`] : []),
    ].join("\n");
    return { data: { site: site.domain, via: addr, results, certificate: { issuer, expires, names, missing } }, human, exitCode: results.some((r) => !r.status || r.status >= 500) ? 1 : 0 };
  },
});

defineCommand({
  name: "server convert",
  summary: "hand a taken-over server's own configuration (nginx.conf, PHP, firewall, Redis, MySQL …) to fornax, module by module — reads the server, keeps what it finds in the fleet repo, switches the modules on; plan + apply do the rest",
  tier: "write",
  args: [{ name: "server", help: "server name", required: true }],
  options: {
    only: { type: "list", help: `modules to switch on: ${MODULES.join(",")}` },
    "dry-run": { type: "boolean", help: "read the server and show what would go into the fleet repo, change nothing" },
  },
  examples: ["fornax server convert web-1 --only base,security --dry-run", "fornax server convert web-1 --only base,security", "fornax plan web-1 --module base,security"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    const areas = (input.only as string[] | undefined) ?? [];
    if (!areas.length) fail("missing_option", "--only is required", `convert step by step, one or a few modules at a time: ${MODULES.join(", ")}`, `fornax server convert ${server.server} --only base,security --dry-run`);
    for (const a of areas) if (!(MODULES as readonly string[]).includes(a)) fail("invalid_option", `unknown module "${a}"`, `one of: ${MODULES.join(", ")}`);
    ctx.log(`reading ${server.server} …`);
    const facts = await readServer(fleet, server);
    const conv = planConversion(fleet, server, facts, areas as ServerArea[]);
    const modules = MODULES.filter((m) => server.modules.includes(m) || areas.includes(m));
    const next = `fornax plan ${server.server} --module ${MODULES.filter((m) => areas.includes(m)).join(",")}`;
    const human = (done: string) =>
      [
        `${server.server}: ${done}`,
        ...conv.changes.map((c) => `  ${c}`),
        ...conv.warnings.map((w) => `  ! ${w}`),
        input.dryRun ? `nothing written — without --dry-run: fornax server convert ${server.server} --only ${areas.join(",")}` : `next: ${next}  (review every change, then fornax apply <plan-id>)`,
      ].join("\n");
    if (input.dryRun) return { data: { server: server.server, modules, dry_run: true, ...conv, next: null }, human: human(`would switch on ${areas.join(", ")} and keep in the fleet repo:`) };
    const path = fleet.files.get(server.server)!;
    const before = readFileSync(path, "utf8");
    editServerFile(fleet, server.server, (doc) => {
      for (const [p, v] of conv.set) doc.setIn(p, typeof v === "object" && v !== null ? doc.createNode(v) : v);
      doc.setIn(["modules"], doc.createNode(modules));
    });
    try {
      const after = loadFleet(ctx);
      assertPolicies(after, getServer(after, server.server));
    } catch (e) {
      writeFileSync(path, before);
      throw e;
    }
    return { data: { server: server.server, modules, file: path, ...conv, next }, human: human(`switched on ${areas.join(", ")} (modules: [${modules.join(", ")}]); kept from the server:`) };
  },
});
