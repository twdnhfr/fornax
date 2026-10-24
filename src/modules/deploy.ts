import type { ResolvedSite } from "../core/fleet.ts";
import { absent, check, dir, file, service, symlink, type Resource } from "../core/resource.ts";
import { DEPLOY_KEY, GITHUB_HOST_KEY, HOOK_SECRET_DIR, KNOWN_HOSTS, NTFY_TOKEN_FILE, REQUEST_DIR, RUNTIME_DIR, siteRuntime } from "../core/runtime.ts";
import { asUser, q, sha256 } from "../core/shell.ts";
import { ORDER_KEY_AWK, orderKey, VERSION } from "../core/version.ts";
import { HEADER, prune, SECRETS, secretFile, type ModuleCtx } from "./common.ts";
import { certFor, certPathsFor, programName } from "./site.ts";
import { nginxSupport } from "./server.ts";

const H = `# ${HEADER}\n`;
export const HOOK_USER = "fornax-hook";

const deploying = (ctx: ModuleCtx) => ctx.sites.filter((s) => s.spec.state === "present" && s.spec.deploy.enabled && s.spec.repo);
/** Where the webhook listens; nginx hands it each site's /.well-known/fornax-hook. */
export const hookPort = (ctx: Pick<ModuleCtx, "server">) => ctx.server.webhook?.port ?? 9300;

const DEPLOY_UNIT = `${H}[Unit]
Description=fornax deploy of %i
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/fornax release %i
TimeoutStartSec=1800
`;

const hookUnit = (port: number) => `${H}[Unit]
Description=fornax deploy webhook
After=network.target

[Service]
User=${HOOK_USER}
Group=${HOOK_USER}
ExecStart=/usr/local/bin/fornax hook serve --port ${port}
Restart=always
RestartSec=2
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=${REQUEST_DIR}

[Install]
WantedBy=multi-user.target
`;

// The webhook runs unprivileged; this root-owned wrapper is all it may sudo.
const TRIGGER = `#!/bin/bash
${H}set -euo pipefail
d="\${1:-}"
[[ "$d" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || { echo "invalid site name" >&2; exit 2; }
[ -f "${RUNTIME_DIR}/$d.json" ] || { echo "unknown site $d" >&2; exit 2; }
exec /usr/bin/systemctl start --no-block "fornax-deploy@$d.service"
`;

function hookVhost(ctx: ModuleCtx, domain: string, port: number): string {
  const tls = certPathsFor(domain, ctx.fleet.config.tls.issuer);
  const location = `    access_log /var/log/nginx/fornax-hook-access.log fornax;
    # /anvil/: webhooks registered before the rename
    location ~ ^/(fornax|anvil)/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        client_max_body_size 25m;
    }
    location / { return 404; }`;
  if (!tls) return `${H}server {\n    listen 80;\n    listen [::]:80;\n    server_name ${domain};\n    include /etc/nginx/fornax/acme.conf;\n${location}\n}\n`;
  return `${H}server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    include /etc/nginx/fornax/acme.conf;
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${domain};
    ssl_certificate ${tls.cert};
    ssl_certificate_key ${tls.key};
    include /etc/nginx/fornax/ssl.conf;
${location}
}
`;
}

/**
 * The probe of the server's fornax: its sha256 — or `sha` itself (in sync) when it is newer than
 * this one (`order`, see orderKey: the version first, then the build stamp), so that an apply from
 * an older fornax never downgrades it (the same rule as ensureServerBinary).
 */
export function binaryProbe(sha: string, order: string, bin = "/usr/local/bin/fornax"): string {
  return `if [ -x ${q(bin)} ]; then
  j=$(${q(bin)} --version --json 2>/dev/null)
  v=$(printf '%s' "$j" | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p')
  b=$(printf '%s' "$j" | sed -n 's/.*"build":"\\([^"]*\\)".*/\\1/p')
  k=$(printf '%s %s\\n' "$v" "$b" | ${ORDER_KEY_AWK})
  if [ -n "$v" ] && [ "$k" != ${q(order)} ] && [ "$(printf '%s\\n%s\\n' "$k" ${q(order)} | LC_ALL=C sort | tail -n1)" = "$k" ]; then echo ${q(sha)}; else sha256sum ${q(bin)} | cut -c1-64; fi
else echo missing; fi`;
}

/** The Linux build of fornax on the server — needed by deploys and backups alike (identical resources merge). */
export function binaryResource(ctx: ModuleCtx): Resource | undefined {
  const bin = ctx.facts.binary;
  if (!bin) return undefined;
  const staged = `/var/tmp/fornax-staging/${bin.sha}`;
  return {
    id: "binary:/usr/local/bin/fornax",
    kind: "check",
    owner: "fornax",
    summary: `fornax binary on the server (${bin.sha.slice(0, 12)})`,
    probe: binaryProbe(bin.sha, orderKey(VERSION, bin.build)),
    desired: bin.sha,
    apply: `install -m 0755 ${q(staged)} /usr/local/bin/fornax && rm -f ${q(staged)}`,
    handler: deploying(ctx).length ? "fornax-hook" : undefined,
    upload: { local: bin.path, remote: staged, sha: bin.sha },
  };
}

/** The ntfy access token, root-only — for deploy and backup notifications alike. */
export function ntfyTokenResources(ctx: ModuleCtx): Resource[] {
  const nt = ctx.facts.ntfyToken;
  if (!nt) return [];
  const o = { owner: "notify" };
  const write = `install -d -m 0711 ${SECRETS}; umask 077; printf %s "$FORNAX_SECRET_NTFY" > ${NTFY_TOKEN_FILE}`;
  return [
    nt.ref
      ? { ...check("ntfy-token", `ntfy access token ${NTFY_TOKEN_FILE} (from ${nt.ref})`, `[ "$(sha256sum < ${NTFY_TOKEN_FILE} 2>/dev/null | cut -c1-64)" = ${q(sha256(nt.value))} ]`, write, o), env: { FORNAX_SECRET_NTFY: nt.ref } }
      : file(NTFY_TOKEN_FILE, nt.value, { ...o, mode: "0600" }),
  ];
}

/** Server-wide deploy machinery: systemd units and (optionally) the webhook. */
export function deployServerResources(ctx: ModuleCtx): Resource[] {
  const sites = deploying(ctx);
  if (!sites.length) return [];
  const bin = ctx.facts.binary;
  if (!bin) return [];
  const o = { owner: "deploy" };
  const hookDomain = ctx.server.webhook?.domain;
  const r: Resource[] = [
    binaryResource(ctx)!,
    dir(RUNTIME_DIR, o),
    file(KNOWN_HOSTS, `${GITHUB_HOST_KEY}\n`, o),
    file("/etc/systemd/system/fornax-deploy@.service", DEPLOY_UNIT, o),
    prune("runtimes", `${RUNTIME_DIR}/*.json`, sites.map((s) => `${RUNTIME_DIR}/${s.domain}.json`), { owner: "deploy" }),
  ];
  r.push(...ntfyTokenResources(ctx));
  r.push(
    check(`user:${HOOK_USER}`, `system user ${HOOK_USER} (runs the webhook)`, `id -u ${HOOK_USER}`, `id -u ${HOOK_USER} >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ${HOOK_USER}`, o),
    dir(REQUEST_DIR, { ...o, user: `${HOOK_USER}:${HOOK_USER}` }),
    dir(HOOK_SECRET_DIR, { ...o, mode: "0750", user: `root:${HOOK_USER}` }),
    file("/usr/local/sbin/fornax-trigger", TRIGGER, { ...o, mode: "0755" }),
    file("/etc/sudoers.d/fornax-hook", `${H}${HOOK_USER} ALL=(root) NOPASSWD: /usr/local/sbin/fornax-trigger\n`, { ...o, mode: "0440" }),
    file("/etc/systemd/system/fornax-hook.service", hookUnit(hookPort(ctx)), { ...o, handler: "fornax-hook" }),
    service("fornax-hook", o),
  );
  if (hookDomain) {
    r.push(
      ...certFor(ctx, hookDomain, [hookDomain], ctx.fleet.config.tls.issuer, "deploy"),
      ...nginxSupport(),
      file("/etc/nginx/sites-available/fornax-hook", hookVhost(ctx, hookDomain, hookPort(ctx)), { ...o, handler: "nginx" }),
      symlink("/etc/nginx/sites-enabled/fornax-hook", "/etc/nginx/sites-available/fornax-hook", { ...o, handler: "nginx" }),
    );
  } else {
    // a webhook hostname that was dropped from the config: its vhost goes (the sites' own hooks stay)
    r.push(absent("/etc/nginx/sites-enabled/fornax-hook", { ...o, handler: "nginx" }), absent("/etc/nginx/sites-available/fornax-hook", { ...o, handler: "nginx" }));
  }
  return r;
}

/** Per-site deploy config, deploy key and webhook secret. */
export function deploySiteResources(ctx: ModuleCtx, s: ResolvedSite): Resource[] {
  if (!s.spec.deploy.enabled || !s.spec.repo || !ctx.facts.binary) return [];
  const o = { owner: `site:${s.domain}` };
  const programs = s.spec.daemons.map((d, i) => programName(s, d, i));
  const rt = siteRuntime(ctx.fleet, s, programs);
  // the notification URL in it can carry a token (Slack, Discord): root and the webhook only
  const hookReads = { mode: "0640", user: `root:${HOOK_USER}` };
  const r: Resource[] = [file(`${RUNTIME_DIR}/${s.domain}.json`, JSON.stringify(rt, null, 2) + "\n", { ...o, ...hookReads, sensitive: !!rt.notify.url })];
  if (rt.uses_deploy_key) {
    const key = DEPLOY_KEY(s.user);
    r.push(
      check(
        `deploy-key:${s.domain}`,
        `deploy key ${key} (read-only access to ${s.spec.repo})`,
        `[ -f ${q(key)} ]`,
        // a key that exists by now (moved from the old name in the same apply) is the one GitHub knows
        asUser(s.user, `install -d -m 0700 /home/${s.user}/.ssh && { [ -f ${q(key)} ] || ssh-keygen -q -t ed25519 -N '' -C ${q(`fornax deploy ${s.domain}`)} -f ${q(key)}; }`),
        o,
      ),
    );
  }
  r.push(secretFile(`${HOOK_SECRET_DIR}/${s.domain}`, o.owner, { group: HOOK_USER, bytes: 32 }));
  return r;
}
