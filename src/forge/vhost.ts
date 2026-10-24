/**
 * What a Forge vhost holds beyond Forge's own template — hand edits made on the server (an IP
 * allowlist, extra headers, a proxied path). `site convert --only web` replaces the vhost with
 * fornax's, so these have to come along as snippets, or the conversion must stop.
 */

export interface VhostExtras {
  /** Statements outside any server block (geo, map, upstream …), with their comments. */
  http: string[];
  /** Statements inside the site's server block that Forge's template does not have. */
  server: string[];
  /** Things that cannot be carried over safely. */
  problems: string[];
}

interface Chunk {
  /** Comment lines directly above the statement. */
  comments: string[];
  lines: string[];
}

/** Split nginx config text into top-level statements (one directive or one block each). */
function chunks(lines: string[]): Chunk[] {
  const out: Chunk[] = [];
  let comments: string[] = [];
  let cur: string[] | null = null;
  let depth = 0;
  for (const raw of lines) {
    const t = raw.trim();
    if (cur === null) {
      if (t === "") {
        comments = [];
        continue;
      }
      if (t.startsWith("#")) {
        comments.push(raw);
        continue;
      }
      cur = [];
    }
    cur.push(raw);
    const code = t.replace(/#.*$/, "");
    depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    if (depth <= 0 && (code.endsWith(";") || code.endsWith("}"))) {
      out.push({ comments, lines: cur });
      cur = null;
      comments = [];
      depth = 0;
    }
  }
  if (cur) out.push({ comments, lines: cur });
  return out;
}

const FORGE_COMMENT = /^#\s*FORGE (CONFIG|SSL) \(DO NOT REMOVE!\)$/;
const FORGE_INCLUDE = /^include\s+forge-conf\/[^;]+;$/;
/** Directives of Forge's vhost template (everything else comes from forge-conf/…/site.conf). */
const FORGE_SERVER_LINE = [
  /^http2\s+on;$/,
  /^listen\s+(\[::\]:)?(80|443)(\s+ssl)?(\s+http2)?(\s+default_server)?;$/,
  /^server_name\s+[^;]+;$/,
  /^server_tokens\s+off;$/,
  /^root\s+[^;]+;$/,
  /^ssl_certificate(_key)?\s+[^;]+;$/,
  FORGE_INCLUDE,
];

const norm = (s: string) => s.replace(/#.*$/gm, "").replace(/\s+/g, " ").trim();
const text = (c: Chunk) => [...c.comments, ...c.lines].join("\n");

function serverNames(c: Chunk): string[] {
  const m = c.lines.join("\n").match(/^\s*server_name\s+([^;]+);/m);
  return m ? m[1]!.trim().split(/\s+/) : [];
}

const isServer = (c: Chunk) => /^server\s*\{/.test(c.lines[0]!.trim());
const inner = (c: Chunk) => c.lines.slice(1, -1);

/**
 * @param vhost    the Forge vhost file (sites-available/<domain>)
 * @param domain   the site's main name
 * @param siteConf Forge's forge-conf/<id>/site.conf — older vhosts carry it inline, so its
 *                 statements count as Forge's too
 */
export function vhostExtras(vhost: string, domain: string, siteConf = ""): VhostExtras {
  const res: VhostExtras = { http: [], server: [], problems: [] };
  const known = norm(siteConf);
  const top = chunks(vhost.split("\n"));
  const servers = top.filter(isServer);
  const named = servers.filter((s) => serverNames(s).includes(domain));
  const main = named.find((s) => /^\s*listen\s+(\[::\]:)?443\b/m.test(s.lines.join("\n"))) ?? named[0];
  if (!main) {
    res.problems.push(`no server block for ${domain}`);
    return res;
  }
  for (const c of top) {
    if (isServer(c)) continue;
    const t = c.lines.join(" ").trim();
    if (c.lines.length === 1 && FORGE_INCLUDE.test(t)) continue;
    res.http.push(text(c));
  }
  for (const s of servers) {
    if (s === main) continue;
    const body = inner(s).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !FORGE_COMMENT.test(l));
    const redirect = body.some((l) => /^return\s+301\s/.test(l)) && body.every((l) => FORGE_SERVER_LINE.some((r) => r.test(l)) || /^return\s+301\s/.test(l) || /^ssl_/.test(l) || /^add_header/.test(l));
    if (!redirect) res.problems.push(`another server block (${serverNames(s).join(" ") || "no server_name"}) that is not a plain redirect`);
  }
  for (const c of chunks(inner(main))) {
    const t = c.lines.map((l) => l.trim()).join(" ");
    if (c.lines.length === 1 && FORGE_SERVER_LINE.some((r) => r.test(t))) continue;
    if (known && known.includes(norm(c.lines.join("\n")))) continue;
    res.server.push(text(c).replace(new RegExp(`^${indentOf(c)}`, "gm"), ""));
  }
  return res;
}

const indentOf = (c: Chunk) => (c.lines[0]!.match(/^\s*/)?.[0] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * An alias with a vhost file of its own is fine to fold into the main vhost only when it serves
 * the same thing: same root, nothing of its own. Anything else (a proxy, another root) is not an alias.
 */
export function plainAlias(vhost: string, alias: string, mainRoot: string, siteConf = ""): string | null {
  const x = vhostExtras(vhost, alias, siteConf);
  if (x.problems.length) return x.problems.join("; ");
  const root = vhost.match(/^\s*root\s+([^;]+);/m)?.[1]?.trim();
  if (root !== mainRoot) return root ? `serves ${root}, not ${mainRoot}` : "has no document root (a proxy?)";
  if (x.server.length || x.http.length) return `has its own configuration: ${[...x.http, ...x.server].map((s) => s.split("\n")[0]).join(" | ")}`;
  return null;
}

/**
 * Forge's vhost for a name that only forwards to a local port (the Reverb template: `location /`
 * with proxy_pass and websocket headers). Returns the port and the certificate it uses, or null
 * when the vhost does anything else.
 */
export function forgeProxy(vhost: string, name: string, siteConf = ""): { port: number; host: string; cert?: string; key?: string } | null {
  const x = vhostExtras(vhost, name, siteConf);
  if (x.problems.length || x.http.length) return null;
  let target: { port: number; host: string } | null = null;
  for (const stmt of x.server) {
    const body = stmt.split("\n").filter((l) => !l.trim().startsWith("#"));
    if (body.length === 1 && /^\s*(access_log|error_log|add_header)\s/.test(body[0]!)) continue;
    const m = stmt.match(/proxy_pass\s+http:\/\/(0\.0\.0\.0|127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?;/);
    const onlyProxy = /^location\s+\/\s*\{/.test(body[0]!.trim()) && body.slice(1, -1).every((l) => !l.trim() || /^\s*proxy_[a-z_]+\s/.test(l));
    if (!m || !onlyProxy || target) return null;
    target = { host: m[1]!, port: Number(m[2]) };
  }
  if (!target) return null;
  const cert = vhost.match(/^\s*ssl_certificate\s+([^;\s]+);/m)?.[1];
  const key = vhost.match(/^\s*ssl_certificate_key\s+([^;\s]+);/m)?.[1];
  return { ...target, ...(cert && key ? { cert, key } : {}) };
}
