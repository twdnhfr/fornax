import { defineCommand } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { findSite, loadFleet } from "../core/fleet.ts";
import { AREAS, convertSite, removeFiles, unusedAdoptedFiles, type Area } from "../forge/convert.ts";

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
  },
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    if (!["host", "public"].includes(String(input.via))) fail("invalid_option", "--via must be host or public");
    if (input.via === "public" && !server.public_ipv4) fail("no_public_ip", `${server.server} has no public_ipv4 in its config`);
    const addr = input.via === "public" ? server.public_ipv4! : server.host;
    const paths = (input.path as string[] | undefined) ?? ["/", ...(site.spec.health_check ? [site.spec.health_check] : [])];
    const results: { url: string; status: number | null; redirect: string | null; seconds: number; error?: string }[] = [];
    // tls none: the site has no HTTPS to ask for
    const schemes = site.tlsIssuer === "none" ? (["http"] as const) : (["http", "https"] as const);
    for (const name of site.names) {
      for (const scheme of schemes) {
        for (const p of name === site.domain ? paths : ["/"]) {
          const port = scheme === "https" ? 443 : 80;
          const r = Bun.spawnSync([
            "curl", "-sSk", "-o", "/dev/null", "--max-time", "15", "--connect-to", `${name}:${port}:${addr}:${port}`,
            "-w", "%{http_code} %{redirect_url} %{time_total} %{ssl_verify_result}", `${scheme}://${name}${p}`,
          ]);
          const [code, redirect, time] = r.stdout.toString().split(" ");
          // no answer: curl says why (refused, timed out, TLS handshake …)
          const error = Number(code) ? undefined : r.stderr.toString().trim().split("\n").pop()?.replace(/^curl: \(\d+\) /, "") || `curl exit ${r.exitCode}`;
          results.push({ url: `${scheme}://${name}${p}`, status: Number(code) || null, redirect: redirect || null, seconds: Number(time), ...(error ? { error } : {}) });
        }
      }
    }
    const cert = site.tlsIssuer === "none" ? "" : Bun.spawnSync(["bash", "-c", `echo | openssl s_client -connect ${addr}:443 -servername ${site.domain} 2>/dev/null | openssl x509 -noout -issuer -enddate -ext subjectAltName 2>/dev/null`], { timeout: 15_000 }).stdout.toString();
    const issuer = cert.match(/issuer=.*?(?:O\s*=\s*([^,\n]+))?.*?CN\s*=\s*([^\n]+)/)?.slice(1).filter(Boolean).join(" / ") ?? null;
    const expires = cert.match(/notAfter=(.*)/)?.[1] ?? null;
    const human = [
      ...results.map((r) => `${String(r.status ?? "ERR").padEnd(4)} ${r.url}${r.redirect ? ` → ${r.redirect}` : ""}${r.error ? ` — ${r.error}` : ""}`),
      site.tlsIssuer === "none" ? "certificate: none (tls: none, HTTP only)" : `certificate: ${issuer ?? "none"}${expires ? `, until ${expires}` : ""}`,
    ].join("\n");
    return { data: { site: site.domain, via: addr, results, certificate: { issuer, expires } }, human, exitCode: results.some((r) => !r.status || r.status >= 500) ? 1 : 0 };
  },
});
