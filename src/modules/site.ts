import { basename, isAbsolute, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fail } from "../core/errors.ts";
import { siteRedis, type ResolvedSite } from "../core/fleet.ts";
import { absent, check, dir, file, homeCheck, homeUser, packages, service, symlink, type Resource } from "../core/resource.ts";
import type { Daemon, Site } from "../core/schema.ts";
import { DEPLOY_LOG_DIR, NODE_UPSTREAM_DIR, nodeSlots, nodeUpstreamConf, SITE_LOG_DIR, type NodeRuntime } from "../core/runtime.ts";
import { asUser, q, sha256 } from "../core/shell.ts";
import { configFiles, HEADER, prune, SECRETS, type ModuleCtx } from "./common.ts";
import { nginxSupport } from "./server.ts";
import { deployServerResources, deploySiteResources } from "./deploy.ts";

const H = `# ${HEADER}\n`;

export const poolPath = (s: ResolvedSite) => `/etc/php/${s.php}/fpm/pool.d/fornax-${s.slug}.conf`;
export const socketPath = (s: ResolvedSite) => `/run/php/php${s.php}-fpm-${s.slug}.sock`;
export const vhostPath = (s: ResolvedSite) => `/etc/nginx/sites-available/${s.domain}`;
export const cronPath = (s: ResolvedSite) => `/etc/cron.d/fornax-${s.slug}`;
export const snippetDir = (s: ResolvedSite) => `/etc/nginx/fornax/sites/${s.domain}`;
export const dbSecret = (s: ResolvedSite) => `${SECRETS}/db-${s.slug}`;
/** Local-only nginx endpoint serving releases/next, for health checks before activation. */
export const PREVIEW_DIR = "/run/fornax-nginx";
export const previewSocket = (s: ResolvedSite) => `${PREVIEW_DIR}/${s.slug}.sock`;

export const certPaths = (s: ResolvedSite) => certPathsFor(s.domain, s.tlsIssuer, s.spec.tls);

export function daemonName(d: Daemon, i: number): string {
  if (d.name) return d.name;
  const known: Array<[RegExp, string]> = [
    [/\bhorizon\b/, "horizon"],
    [/\bqueue:(work|listen)\b/, "queue"],
    [/\breverb:start\b/, "reverb"],
    [/\binertia:start-ssr\b/, "ssr"],
    [/\boctane:/, "octane"],
    [/\bpulse:check\b/, "pulse"],
  ];
  return known.find(([re]) => re.test(d.cmd))?.[1] ?? `d${i + 1}`;
}

export const programName = (s: ResolvedSite, d: Daemon, i: number) => d.program ?? `fornax-${s.slug}-${daemonName(d, i)}`;
export const daemonPath = (s: ResolvedSite, d: Daemon, i: number) => `/etc/supervisor/conf.d/${programName(s, d, i)}.conf`;

// ---- templates -----------------------------------------------------------------

export function poolConf(ctx: ModuleCtx, s: ResolvedSite): string {
  return `; ${HEADER}\n[${s.slug}]
user = ${s.user}
group = ${s.user}
listen = ${socketPath(s)}
listen.owner = ${ctx.admin}
listen.group = ${ctx.admin}
listen.mode = 0660
pm = dynamic
pm.max_children = ${s.spec.pool.max_children}
pm.start_servers = ${s.spec.pool.start_servers}
pm.min_spare_servers = ${s.spec.pool.min_spare_servers}
pm.max_spare_servers = ${s.spec.pool.max_spare_servers}
pm.max_requests = ${s.spec.pool.max_requests}
request_terminate_timeout = ${s.spec.pool.request_terminate_timeout}
catch_workers_output = yes
php_admin_value[error_log] = /home/${s.user}/.fornax/php-error.log
`;
}

function snippetIncludes(s: ResolvedSite, list: string[], prefix: string): string[] {
  return list.map((p) => `include ${snippetDir(s)}/${prefix}${basename(p)};`);
}

type Proxy = Site["proxies"][number];

/** A name that forwards to a local port (websocket servers like Reverb). */
function proxyServer(p: Proxy, tls: { cert: string; key: string } | undefined): string[] {
  const location = [
    "    location / {",
    `        proxy_pass http://127.0.0.1:${p.port};`,
    "        proxy_http_version 1.1;",
    "        proxy_set_header Host $http_host;",
    "        proxy_set_header Scheme $scheme;",
    "        proxy_set_header SERVER_PORT $server_port;",
    "        proxy_set_header REMOTE_ADDR $remote_addr;",
    "        proxy_set_header X-Real-IP $remote_addr;",
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
    ...(p.websocket ? ["        proxy_set_header Upgrade $http_upgrade;", '        proxy_set_header Connection "Upgrade";', "        proxy_read_timeout 3600s;"] : []),
    "    }",
  ];
  const common = [`    server_name ${p.domain};`, "    server_tokens off;", `    access_log /var/log/nginx/${p.domain}-access.log fornax;`, `    error_log /var/log/nginx/${p.domain}-error.log error;`, "    include /etc/nginx/fornax/acme.conf;"];
  if (!tls) return ["server {", "    listen 80;", "    listen [::]:80;", ...common, ...location, "}"];
  return [
    "server {", "    listen 80;", "    listen [::]:80;", `    server_name ${p.domain};`, "    include /etc/nginx/fornax/acme.conf;", `    location / { return 301 https://${p.domain}$request_uri; }`, "}",
    "server {", "    listen 443 ssl;", "    listen [::]:443 ssl;", "    http2 on;", ...common, `    ssl_certificate ${tls.cert};`, `    ssl_certificate_key ${tls.key};`, "    include /etc/nginx/fornax/ssl.conf;", ...location, "}",
  ];
}

/** A node app gets every request; websockets pass, other requests reuse kept-alive upstream connections. */
function nodeLocation(upstream: string): string[] {
  return [
    "    location / {",
    `        proxy_pass http://${upstream};`,
    "        proxy_http_version 1.1;",
    "        proxy_set_header Host $host;",
    "        proxy_set_header X-Real-IP $remote_addr;",
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
    "        proxy_set_header X-Forwarded-Host $host;",
    "        proxy_set_header Upgrade $http_upgrade;",
    "        proxy_set_header Connection $fornax_connection;",
    // as for PHP: framework responses carry large headers (cookies, RSC); nginx's 4k default answers 502
    "        proxy_buffer_size 64k;",
    "        proxy_buffers 32 32k;",
    "    }",
  ];
}

/** http level, once per server with node apps: "Connection: upgrade" only for websocket requests. */
export const NODE_MAP_PATH = "/etc/nginx/conf.d/fornax-node.conf";
export const NODE_MAP = `${H}map $http_upgrade $fornax_connection {
    default upgrade;
    ''      '';
}
`;

/**
 * One slot of a node app: the site user runs `node.start` in the release the slot link points at.
 * systemd rather than supervisor: which slot is enabled is the record of which one serves, and it
 * survives a reboot without a config rewrite per deploy.
 */
export function nodeUnitConf(s: ResolvedSite, slot: NodeRuntime["slots"][number]): string {
  const u = s.user;
  return `${H}[Unit]
Description=node app of ${s.domain}, slot ${slot.name} (fornax)
After=network.target

[Service]
User=${u}
Group=${u}
WorkingDirectory=${slot.link}
Environment=NODE_ENV=production PORT=${slot.port} HOST=127.0.0.1 HOSTNAME=127.0.0.1 HOME=/home/${u} USER=${u} PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash -c "exec ${s.node!.start}"
Restart=always
RestartSec=2
TimeoutStopSec=30
# stopped with SIGTERM after a switch (package-manager wrappers like bun run then exit 143): not a failure
SuccessExitStatus=143
StandardOutput=append:${SITE_LOG_DIR(u)}/app.log
StandardError=inherit
UMask=0027
NoNewPrivileges=yes
ProtectSystem=full
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
`;
}

/** The handler of a site's node units: the app restarts with its new unit (start command, port) — see handlerFor. */
export const nodeHandler = (s: ResolvedSite) => `fornax-node@${s.domain}`;

function nodeResources(s: ResolvedSite, o: { owner: string }): Resource[] {
  const n = nodeSlots(s, s.node!.ports);
  const [a, b] = n.slots as [NodeRuntime["slots"][number], NodeRuntime["slots"][number]];
  // which slot serves is the deploys' business: apply only makes sure the upstream names the
  // enabled one (slot a before the first deploy) — after a port change, too
  const port = `port=${a.port}; systemctl is-enabled -q ${q(b.unit)} 2>/dev/null && port=${b.port}`;
  return [
    ...n.slots.map((slot) => file(`/etc/systemd/system/${slot.unit}`, nodeUnitConf(s, slot), { ...o, handler: nodeHandler(s) })),
    file(NODE_MAP_PATH, NODE_MAP, { owner: "web", handler: "nginx" }),
    check(
      `node-upstream:${s.domain}`,
      `nginx upstream ${n.upstream.file} → the enabled slot of ${s.domain}`,
      `${port}; grep -qx ${q(`upstream ${n.upstream.name} {`)} ${q(n.upstream.file)} && grep -qx "    server 127.0.0.1:$port;" ${q(n.upstream.file)}`,
      `${port}; install -d -m 0755 ${NODE_UPSTREAM_DIR}; printf %s ${q(nodeUpstreamConf(n.upstream.name, "@PORT@"))} | sed "s/@PORT@/$port/" > ${q(n.upstream.file)}`,
      { ...o, handler: "nginx" },
    ),
  ];
}

/** The path GitHub posts pushes to, on the site's own domain: no webhook hostname per server needed. */
export const HOOK_PATH = "/.well-known/fornax-hook";

/** The webhook URL of a site (its scheme follows the site's TLS). */
export const siteHookUrl = (s: ResolvedSite) => `${s.tlsIssuer === "none" ? "http" : "https"}://${s.domain}${HOOK_PATH}`;

/** `hookPort`: where the server's webhook listens — given when the site deploys on push. */
export function vhostConf(s: ResolvedSite, hookPort?: number): string {
  const tls = certPaths(s);
  const names = [s.domain, ...s.spec.aliases];
  const www = s.spec.www_redirect ? `www.${s.domain}` : undefined;
  // names that only send visitors on to the domain: www and the site's redirects
  const away = [...(www ? [www] : []), ...s.spec.redirects];
  const node = s.node ? nodeSlots(s, s.node.ports) : undefined;
  const php = s.spec.preset !== "static" && !node;
  const nextRoot = s.webRoot.replace(`${s.root}/current`, `${s.root}/next`);
  // push-to-deploy: GitHub's webhook for this site; fornax-hook checks the signature (HMAC per site),
  // so no basic auth or IP rule of the site applies here
  const hook = hookPort
    ? [
        `    location = ${HOOK_PATH} {`,
        "        auth_basic off;",
        "        allow all;",
        `        proxy_pass http://127.0.0.1:${hookPort}/fornax/hook/${s.domain};`,
        "        proxy_set_header Host $host;",
        "        proxy_set_header X-Forwarded-For $remote_addr;",
        "        client_max_body_size 25m;",
        "    }",
      ]
    : [];
  const body = (root: string, logs: boolean) => [
    ...(node
      ? []
      : [
          `    root ${root};`,
          "    index index.html index.htm" + (php ? " index.php;" : ";"),
          "    charset utf-8;",
        ]),
    // also here, not only in fornax's nginx.conf: adopted servers keep their own nginx.conf
    "    server_tokens off;",
    // nginx may read every site: a symlink one site plants towards another's files is not followed
    // (current → releases/…, public/storage → storage/app/public belong to the site and still work)
    ...(node ? [] : ["    disable_symlinks if_not_owner;"]),
    ...(logs ? [`    access_log /var/log/nginx/${s.domain}-access.log fornax;`, `    error_log /var/log/nginx/${s.domain}-error.log error;`] : ["    access_log off;"]),
    ...(s.spec.nginx.client_max_body_size ? [`    client_max_body_size ${s.spec.nginx.client_max_body_size};`] : []),
    '    add_header X-Frame-Options "SAMEORIGIN" always;',
    '    add_header X-Content-Type-Options "nosniff" always;',
    "",
    // the site's own server snippets (basic auth, IP gates) guard the public names only: the
    // pre-activation check reaches the next release locally and must see the app, not a 401/403
    ...(logs ? snippetIncludes(s, s.spec.nginx.server, "").map((l) => `    ${l}`) : []),
    ...(logs ? hook : []),
    ...(node
      ? nodeLocation(node.upstream.name)
      : [
          php ? "    location / {\n        try_files $uri $uri/ /index.php?$query_string;\n    }" : "    location / {\n        try_files $uri $uri/ $uri.html =404;\n    }",
          "    location = /favicon.ico { access_log off; log_not_found off; }",
          "    location = /robots.txt  { access_log off; log_not_found off; }",
        ]),
    ...(node ? [] : php
      ? [
          "    error_page 404 /index.php;",
          "    location ~ \\.php$ {",
          `        fastcgi_pass unix:${socketPath(s)};`,
          "        fastcgi_split_path_info ^(.+\\.php)(/.+)$;",
          "        fastcgi_index index.php;",
          "        include fastcgi_params;",
          "        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;",
          "        fastcgi_param DOCUMENT_ROOT $realpath_root;",
          "        fastcgi_hide_header X-Powered-By;",
          // Laravel/Inertia responses carry large headers (cookies, X-Inertia); nginx's 4k default answers 502
          "        fastcgi_buffers 32 32k;",
          "        fastcgi_buffer_size 64k;",
          "    }",
        ]
      : ["    error_page 404 /404.html;"]),
    "    location ~ /\\.(?!well-known).* { deny all; }",
  ];
  const out = [H.trimEnd()];
  out.push(...snippetIncludes(s, s.spec.nginx.http, "http-"));
  // the upstream names the slot that serves; deploys rewrite that file, never this one
  if (node) out.push(`include ${node.upstream.file};`);
  if (tls) {
    out.push(
      "server {",
      "    listen 80;",
      "    listen [::]:80;",
      `    server_name ${[...names, ...(www ? [www] : [])].join(" ")};`,
      "    include /etc/nginx/fornax/acme.conf;",
      `    location / { return 301 https://${www ? s.domain : "$host"}$request_uri; }`,
      "}",
    );
    // straight to the domain, not first to https on the redirecting name
    if (s.spec.redirects.length) {
      out.push("server {", "    listen 80;", "    listen [::]:80;", `    server_name ${s.spec.redirects.join(" ")};`, "    include /etc/nginx/fornax/acme.conf;", `    location / { return 301 https://${s.domain}$request_uri; }`, "}");
    }
    if (away.length) {
      out.push(
        "server {",
        "    listen 443 ssl;",
        "    listen [::]:443 ssl;",
        "    http2 on;",
        `    server_name ${away.join(" ")};`,
        `    ssl_certificate ${tls.cert};`,
        `    ssl_certificate_key ${tls.key};`,
        "    include /etc/nginx/fornax/ssl.conf;",
        "    include /etc/nginx/fornax/acme.conf;",
        `    location / { return 301 https://${s.domain}$request_uri; }`,
        "}",
      );
    }
    out.push("server {", "    listen 443 ssl;", "    listen [::]:443 ssl;", "    http2 on;", `    server_name ${names.join(" ")};`, `    ssl_certificate ${tls.cert};`, `    ssl_certificate_key ${tls.key};`, "    include /etc/nginx/fornax/ssl.conf;",
      // proxies like Cloudflare (SSL "Full") fetch even http:// challenges from the origin over https
      "    include /etc/nginx/fornax/acme.conf;", "", ...body(s.webRoot, true), "}");
  } else {
    if (away.length) out.push("server {", "    listen 80;", "    listen [::]:80;", `    server_name ${away.join(" ")};`, `    return 301 http://${s.domain}$request_uri;`, "}");
    out.push("server {", "    listen 80;", "    listen [::]:80;", `    server_name ${names.join(" ")};`, "    include /etc/nginx/fornax/acme.conf;", "", ...body(s.webRoot, true), "}");
  }
  for (const p of s.spec.proxies) out.push(...proxyServer(p, tls && (s.tlsIssuer === "existing" && p.cert && p.key ? { cert: p.cert, key: p.key } : tls)));
  // The next release, reachable only from the server itself: `fornax release` health-checks it here
  // before switching (a node release is checked on its own port instead).
  if (!s.inPlace && !node) out.push("server {", `    listen unix:${previewSocket(s)};`, `    server_name ${s.domain};`, ...body(nextRoot, false), "}");
  return out.join("\n") + "\n";
}

export function daemonConf(s: ResolvedSite, d: Daemon, i: number): string {
  const name = programName(s, d, i);
  const directory = d.directory ? (isAbsolute(d.directory) ? d.directory : `${s.current}/${d.directory}`) : s.current;
  return `${H}[program:${name}]
command=${d.cmd}
directory=${directory}
user=${s.user}
environment=HOME="/home/${s.user}",USER="${s.user}"
process_name=%(program_name)s_%(process_num)02d
numprocs=${d.processes}
autostart=true
autorestart=true
startsecs=1
startretries=10
stopwaitsecs=${d.stopwait}
stopsignal=SIGTERM
stopasgroup=true
killasgroup=true
redirect_stderr=true
stdout_logfile=${SITE_LOG_DIR(s.user)}/${daemonName(d, i)}.log
stdout_logfile_maxbytes=5MB
stdout_logfile_backups=3
`;
}

export function cronConf(s: ResolvedSite): string | undefined {
  const lines: string[] = [];
  if (s.spec.schedule) lines.push(`* * * * * ${s.user} cd ${s.current} && php${s.php} artisan schedule:run > /home/${s.user}/.fornax/schedule.log 2>&1`);
  for (const c of s.spec.cron) lines.push(`${c.at} ${s.user} cd ${s.current} && ${c.cmd} >> /home/${s.user}/.fornax/cron.log 2>&1`);
  if (!lines.length) return undefined;
  return `${H}SHELL=/bin/bash\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n${lines.join("\n")}\n`;
}

export function logrotateConf(s: ResolvedSite): string {
  const rules = `    weekly
    maxsize 100M
    missingok
    rotate 4
    compress
    delaycompress
    notifempty
    copytruncate`;
  // the site's own logs as the site user; supervisor's (root-owned) as root
  return `${H}${s.root}/storage/logs/*.log /home/${s.user}/.fornax/*.log {
    su ${s.user} ${s.user}
${rules}
}
${SITE_LOG_DIR(s.user)}/*.log {
${rules}
}
`;
}

// ---- resources -----------------------------------------------------------------

function dbResources(ctx: ModuleCtx, s: ResolvedSite, o: { owner: string }): Resource[] {
  const db = s.db!;
  const svc = db.engine === "mysql" ? "mysql" : "postgres";
  if (!ctx.server.services.includes(svc)) fail("config_invalid", `${s.domain}: db engine ${db.engine} needs "${svc}" in the server's services`);
  const secret = dbSecret(s);
  const gen = `[ -s ${secret} ] || { umask 077; openssl rand -hex 20 > ${secret}; }; pw="$(cat ${secret})"`;
  if (db.engine === "mysql") {
    return [
      check(
        `db:mysql:${db.name}`,
        `mysql database ${db.name} + user ${db.user}`,
        `[ "$(mysql -Nse "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${db.name}'")" = 1 ] && [ "$(mysql -Nse "SELECT COUNT(*) FROM mysql.user WHERE user='${db.user}' AND host='localhost'")" = 1 ]`,
        `${gen}
mysql <<SQL
CREATE DATABASE IF NOT EXISTS \\\`${db.name}\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${db.user}'@'localhost' IDENTIFIED BY '$pw';
ALTER USER '${db.user}'@'localhost' IDENTIFIED BY '$pw';
GRANT ALL PRIVILEGES ON \\\`${db.name}\\\`.* TO '${db.user}'@'localhost';
FLUSH PRIVILEGES;
SQL`,
        o,
      ),
    ];
  }
  const psql = (sql: string, dbn = "postgres") => `runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d ${dbn} -tAc ${q(sql)}`;
  const r: Resource[] = [
    check(
      `db:postgres:${db.name}`,
      `postgres database ${db.name} + role ${db.user}`,
      `[ "$(${psql(`SELECT 1 FROM pg_roles WHERE rolname='${db.user}'`)})" = 1 ] && [ "$(${psql(`SELECT 1 FROM pg_database WHERE datname='${db.name}'`)})" = 1 ]`,
      `${gen}
runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 <<SQL
DO \\$\\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${db.user}') THEN CREATE ROLE "${db.user}" LOGIN; END IF;
END \\$\\$;
ALTER ROLE "${db.user}" LOGIN PASSWORD '$pw';
SQL
[ "$(${psql(`SELECT 1 FROM pg_database WHERE datname='${db.name}'`)})" = 1 ] || runuser -u postgres -- createdb -O ${q(db.user)} ${q(db.name)}`,
      o,
    ),
  ];
  for (const ext of db.extensions) {
    r.push(check(`db:postgres:${db.name}:${ext}`, `postgres extension ${ext} in ${db.name}`, `[ "$(${psql(`SELECT 1 FROM pg_extension WHERE extname='${ext}'`, db.name)})" = 1 ]`, psql(`CREATE EXTENSION IF NOT EXISTS "${ext}"`, db.name), o));
  }
  return r;
}

function envBootstrap(ctx: ModuleCtx, s: ResolvedSite, o: { owner: string }): Resource {
  const scheme = certPaths(s) ? "https" : "http";
  const redis = s.redis !== "none";
  // own instance: its socket (phpredis reads a path with port 0 as a unix socket), no password needed
  const redisConn =
    s.redis === "own"
      ? [`REDIS_HOST=${siteRedis(s.user).socket}`, "REDIS_PASSWORD=null", "REDIS_PORT=0"]
      : ["REDIS_HOST=127.0.0.1", ctx.server.redis.password ? `REDIS_PASSWORD=$(cat ${SECRETS}/redis)` : "REDIS_PASSWORD=null", "REDIS_PORT=6379"];
  const db = s.db;
  const dbLines = db
    ? [
        `DB_CONNECTION=${db.engine === "mysql" ? "mysql" : "pgsql"}`,
        "DB_HOST=127.0.0.1",
        `DB_PORT=${db.engine === "mysql" ? 3306 : 5432}`,
        `DB_DATABASE=${db.name}`,
        `DB_USERNAME=${db.user}`,
        `DB_PASSWORD=$(cat ${dbSecret(s)})`,
      ]
    : ["DB_CONNECTION=sqlite", `DB_DATABASE=${s.root}/storage/database.sqlite`];
  const lines = [
    `APP_NAME="${s.domain}"`,
    "APP_ENV=production",
    "APP_KEY=base64:$(openssl rand -base64 32)",
    "APP_DEBUG=false",
    `APP_URL=${scheme}://${s.domain}`,
    "",
    "LOG_CHANNEL=stack",
    "LOG_STACK=daily",
    "LOG_LEVEL=warning",
    "",
    ...dbLines,
    "",
    ...(redis
      ? ["CACHE_STORE=redis", "QUEUE_CONNECTION=redis", "SESSION_DRIVER=redis", "REDIS_CLIENT=phpredis", ...redisConn]
      : ["CACHE_STORE=file", "QUEUE_CONNECTION=database", "SESSION_DRIVER=file"]),
  ];
  const env = `${s.root}/.env`;
  return homeCheck(
    s.user,
    env,
    `env:${s.domain}`,
    `bootstrap ${env} (only if missing; afterwards it is yours — fornax env pull|push)`,
    `[ -f ${q(env)} ]`,
    // checked again at apply time: an .env that exists by then is the app's and is never replaced
    // root reads the secrets, the site user writes the file (noclobber: an .env that appeared meanwhile stays)
    `if ${asUser(s.user, `[ ! -f ${q(env)} ]`)}; then
cat <<ENV | ${asUser(s.user, `umask 027; set -C; cat > ${q(env)} && chmod 0640 ${q(env)}`)}
${lines.join("\n")}
ENV
${db ? "" : asUser(s.user, `mkdir -p ${q(s.root + "/storage")} && touch ${q(s.root + "/storage/database.sqlite")}`)}
fi`,
    "missing",
    o,
  );
}

type Issuer = ResolvedSite["tlsIssuer"];

export function certPathsFor(domain: string, issuer: Issuer, existing?: { cert?: string; key?: string }): { cert: string; key: string } | undefined {
  switch (issuer) {
    case "letsencrypt":
      return { cert: `/etc/letsencrypt/live/${domain}/fullchain.pem`, key: `/etc/letsencrypt/live/${domain}/privkey.pem` };
    case "selfsigned":
      return { cert: `/etc/fornax/tls/${domain}/fullchain.pem`, key: `/etc/fornax/tls/${domain}/privkey.pem` };
    case "existing":
      if (!existing?.cert || !existing.key) fail("config_invalid", `${domain}: tls.issuer existing needs tls.cert and tls.key`);
      return { cert: existing!.cert!, key: existing!.key! };
    default:
      return undefined;
  }
}

/** Resources that make sure a certificate for `names` exists (issued before the vhost needs it). */
export function certFor(ctx: ModuleCtx, domain: string, names: string[], issuer: Issuer, owner: string): Resource[] {
  // existing certificates are not fornax's to issue (adopted Forge sites)
  if (issuer === "existing" || issuer === "none") return [];
  const paths = certPathsFor(domain, issuer)!;
  const o = { owner };
  const sorted = [...new Set(names)].sort();
  const sans = `openssl x509 -in ${q(paths.cert)} -noout -ext subjectAltName 2>/dev/null | grep -o 'DNS:[^,]*' | sed 's/DNS://' | sort | tr '\\n' ' ' | sed 's/ $//'`;
  const test = `[ -f ${q(paths.cert)} ] && [ "$(${sans})" = ${q(sorted.join(" "))} ]`;
  if (issuer === "selfsigned") {
    const d = `/etc/fornax/tls/${domain}`;
    return [
      check(
        `tls:${domain}`,
        `self-signed certificate for ${sorted.join(", ")}`,
        test,
        `install -d -m 0750 ${q(d)}
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 -subj ${q(`/CN=${domain}`)} -addext ${q(`subjectAltName=${sorted.map((n) => `DNS:${n}`).join(",")}`)} -keyout ${q(d + "/privkey.pem")} -out ${q(d + "/fullchain.pem")} 2>/dev/null
chmod 0640 ${q(d + "/privkey.pem")}`,
        { ...o, handler: "nginx" },
      ),
    ];
  }
  const t = ctx.fleet.config.tls;
  const env = t.ca_bundle ? `REQUESTS_CA_BUNDLE=${q(t.ca_bundle)} ` : "";
  // A brand-new name has no vhost yet, and on servers fornax did not set up (Forge) no catch-all
  // answers ACME either: serve the challenge from a temporary block while certbot runs.
  const bootstrap = `/etc/nginx/sites-enabled/fornax-acme-${domain}`;
  const certbot = `${env}certbot certonly --webroot -w /var/lib/fornax/acme --cert-name ${q(domain)} --non-interactive --agree-tos --expand --quiet ${t.email ? `--email ${q(t.email)}` : "--register-unsafely-without-email"} ${t.acme_server ? `--server ${q(t.acme_server)}` : ""} ${sorted.map((n) => `-d ${q(n)}`).join(" ")}`;
  return [
    // the bootstrap block includes acme.conf, which a server fornax did not set up lacks so far
    ...nginxSupport(),
    check(
      `tls:${domain}`,
      `Let's Encrypt certificate for ${sorted.join(", ")}`,
      test,
      `served=1
for n in ${sorted.map(q).join(" ")}; do grep -lsE "server_name[^;]*[[:space:]]$n([[:space:];]|$)" /etc/nginx/sites-enabled/* >/dev/null || served=0; done
if [ $served = 0 ]; then
  printf 'server {\n    listen 80;\n    listen [::]:80;\n    server_name %s;\n    include /etc/nginx/fornax/acme.conf;\n    location / { return 404; }\n}\n' ${q(sorted.join(" "))} > ${q(bootstrap)}
  nginx -t -q || { rm -f ${q(bootstrap)}; echo "nginx rejects the temporary ACME block for ${sorted.join(" ")}" >&2; false; }
  systemctl reload nginx
fi
rc=0; ${certbot} || rc=$?
if [ -f ${q(bootstrap)} ]; then rm -f ${q(bootstrap)}; nginx -t -q && systemctl reload nginx; fi
# steps run as { } blocks inside one apply script: never exit, fail with the last command
[ $rc = 0 ]`,
      { ...o, handler: "nginx", flushBefore: true },
    ),
    // switching from self-signed to Let's Encrypt leaves the old pair behind otherwise
    absent(`/etc/fornax/tls/${domain}`, { ...o, recursive: true, summary: `remove the old self-signed certificate of ${domain}` }),
  ];
}

/** The directories root writes the site's logs into, and the move of old deploy logs out of the home. */
function logResources(s: ResolvedSite, o: { owner: string }): Resource[] {
  const u = s.user;
  const old = `/home/${u}/.fornax/deploys`;
  const dest = DEPLOY_LOG_DIR(u);
  return [
    dir(`/home/${u}/.fornax`, { ...o, user: `${u}:${u}` }),
    dir(SITE_LOG_DIR(u), { ...o, mode: "0750", user: `root:${u}` }),
    dir(dest, { ...o, mode: "0750", user: `root:${u}` }),
    // earlier versions wrote deploy logs into the home: the user hands over its regular files, nothing else comes along
    homeCheck(
      u,
      old,
      `deploy-logs:${u}`,
      `move the deploy history of ${s.domain} from ${old} to ${dest}`,
      `[ ! -e ${q(old)} ] && [ ! -L ${q(old)} ]`,
      `${asUser(u, `cd ${q(old)} && find . -maxdepth 1 -type f \\( -name '*.log' -o -name '*.json' \\) -print0 | tar --null --no-recursion -cf - -T -`)} | tar -xf - -C ${q(dest)} --no-same-owner
find ${q(dest)} -mindepth 1 ! -type f -delete
${asUser(u, `rm -rf ${q(old)}`)}`,
      "ok",
      o,
    ),
  ];
}

const tlsResources = (ctx: ModuleCtx, s: ResolvedSite, o: { owner: string }) => certFor(ctx, s.domain, s.certNames, s.tlsIssuer, o.owner);

export function siteResources(ctx: ModuleCtx, s: ResolvedSite): Resource[] {
  if (s.spec.state === "absent") return removeSite(ctx, s);
  const o = { owner: `site:${s.domain}` };
  const u = s.user;
  const g = s.spec.generate;
  // Adopted sites (from Forge) keep the user, directories and database they already have;
  // the `generate` switches decide area by area what fornax writes itself.
  const adopted = s.spec.adopted;
  const anyGenerated = g.vhost || g.pool || g.daemons || g.cron || g.logrotate;
  const r: Resource[] = adopted
    ? anyGenerated || s.spec.deploy.enabled
      ? logResources(s, o)
      : []
    : [
        check(`user:${u}`, `Linux user ${u}`, `id -u ${q(u)} && id -nG ${q(u)} | grep -qw isolated`, `id -u ${q(u)} >/dev/null 2>&1 || useradd -m -s /bin/bash ${q(u)}
if [ "$(id -u ${q(u)})" -lt 1000 ]; then echo "${u} is a system account — refusing to run a site as it" >&2; false; else usermod -aG isolated ${q(u)}; fi`, o),
        check(`acl:/home/${u}`, `isolate /home/${u} from other sites`, `getfacl -p /home/${u} 2>/dev/null | grep -q '^group:isolated:---' && [ "$(stat -c %a /home/${u})" = 755 ]`, `chmod 755 /home/${u}; setfacl -m g:isolated:000 /home/${u}`, o),
        dir(s.root, { ...o, user: `${u}:${u}` }),
        ...(s.inPlace ? [] : [dir(`${s.root}/releases`, { ...o, user: `${u}:${u}` })]),
        ...logResources(s, o),
      ];
  if (!adopted && s.db?.manage) r.push(...dbResources(ctx, s, o));
  r.push(...redisResources(s, o));
  if (!adopted && s.spec.preset === "laravel") r.push(envBootstrap(ctx, s, o));
  const auth = ctx.facts.composerAuth?.[s.domain];
  if (auth) {
    // linked into every release by `fornax release`, like .env
    const path = `${s.root}/auth.json`;
    const write = asUser(s.user, `mkdir -p ${q(s.root)} && umask 077 && printf %s "$FORNAX_SECRET_COMPOSER_AUTH" > ${q(path)} && chmod 0600 ${q(path)}`, ["FORNAX_SECRET_COMPOSER_AUTH"]);
    r.push(
      auth.ref
        ? { ...homeCheck(s.user, path, `composer-auth:${s.domain}`, `composer auth.json for ${s.domain} (from ${auth.ref})`, `[ "$(sha256sum < ${q(path)} 2>/dev/null | cut -c1-64)" = ${q(sha256(auth.value))} ]`, write, "missing", o), env: { FORNAX_SECRET_COMPOSER_AUTH: auth.ref } }
        : file(path, auth.value, { ...o, mode: "0600", user: `${s.user}:${s.user}` }),
    );
  }
  if (g.pool && s.spec.preset !== "static" && !s.node) r.push(file(poolPath(s), poolConf(ctx, s), { ...o, handler: `php${s.php}-fpm` }));
  r.push(...tlsResources(ctx, s, o));
  // before the vhost: it includes the upstream file
  if (s.node) r.push(...nodeResources(s, o));

  if (g.vhost) {
    // nginx snippets from the fleet repo
    const snippets = [
      ...s.spec.nginx.server.map((p) => ({ src: p, name: basename(p) })),
      ...s.spec.nginx.http.map((p) => ({ src: p, name: `http-${basename(p)}` })),
    ];
    for (const sn of snippets) {
      const src = isAbsolute(sn.src) ? sn.src : join(ctx.fleet.dir, sn.src);
      if (!existsSync(src)) fail("config_invalid", `${s.domain}: nginx snippet ${sn.src} does not exist`);
      r.push(file(`${snippetDir(s)}/${sn.name}`, readFileSync(src, "utf8"), { ...o, handler: "nginx" }));
    }
    r.push(prune(`snippets:${s.domain}`, `${snippetDir(s)}/*`, snippets.map((sn) => `${snippetDir(s)}/${sn.name}`), { ...o, handler: "nginx" }));
    r.push(
      ...nginxSupport(),
      // shared by all sites (identical resources are merged); /run is empty after a reboot
      file("/etc/tmpfiles.d/fornax-nginx.conf", `${H}d ${PREVIEW_DIR} 0700 root root -\n`, { owner: "web" }),
      check(`dir:${PREVIEW_DIR}`, `${PREVIEW_DIR} for pre-activation health checks`, `[ "$(stat -c %a ${PREVIEW_DIR} 2>/dev/null)" = 700 ]`, "systemd-tmpfiles --create /etc/tmpfiles.d/fornax-nginx.conf", { owner: "web" }),
      file(vhostPath(s), vhostConf(s, s.spec.deploy.enabled && s.spec.repo ? (ctx.server.webhook?.port ?? 9300) : undefined), { ...o, handler: "nginx" }),
      symlink(`/etc/nginx/sites-enabled/${s.domain}`, vhostPath(s), { ...o, handler: "nginx" }),
    );
  }
  if (g.daemons) {
    if (s.spec.daemons.length && !ctx.server.services.includes("supervisor") && !adopted) fail("config_invalid", `${s.domain}: daemons need "supervisor" in the server's services`);
    const names = new Set<string>();
    s.spec.daemons.forEach((d, i) => {
      const n = daemonName(d, i);
      if (names.has(n)) fail("config_invalid", `${s.domain}: two daemons are both called "${n}" — give one a name:`);
      names.add(n);
      r.push(file(daemonPath(s, d, i), daemonConf(s, d, i), { ...o, handler: "supervisor" }));
    });
    r.push(prune(`daemons:${s.domain}`, `/etc/supervisor/conf.d/fornax-${s.slug}-*.conf`, s.spec.daemons.map((d, i) => daemonPath(s, d, i)), { ...o, handler: "supervisor" }));
  }
  if (g.cron) {
    const cron = cronConf(s);
    r.push(cron ? file(cronPath(s), cron, o) : absent(cronPath(s), o));
  }
  if (g.logrotate) r.push(file(`/etc/logrotate.d/fornax-${s.slug}`, logrotateConf(s), o));
  r.push(...configFiles(ctx, s.spec.files, o.owner));
  // retired files go only after the new config is live (reloads flushed): old pool sockets stay
  // reachable until nginx no longer points at them. Links in sites-enabled go before what they point
  // to: every retire step validates first, and a dangling link fails `nginx -t`
  const enabledFirst = [...s.spec.retire].sort((a, b) => Number(b.includes("/sites-enabled/")) - Number(a.includes("/sites-enabled/")));
  for (const path of enabledFirst) r.push({ ...absent(path, { ...o, summary: `retire ${path}` }), flushBefore: true });
  r.push(...deploySiteResources(ctx, s));
  return r;
}

function removeSite(ctx: ModuleCtx, s: ResolvedSite): Resource[] {
  const o = { owner: `site:${s.domain}` };
  const units = s.node ? nodeSlots(s, s.node.ports) : undefined;
  const r: Resource[] = [
    absent(`/etc/nginx/sites-enabled/${s.domain}`, { ...o, handler: "nginx" }),
    // once nginx no longer sends anything to it (flushBefore: the vhost is gone)
    ...(units
      ? [
          {
            ...check(
              `node-off:${s.domain}`,
              `stop and remove the node app of ${s.domain}`,
              units.slots.map((x) => `[ ! -e /etc/systemd/system/${x.unit} ]`).join(" && "),
              `systemctl disable --now ${units.slots.map((x) => x.unit).join(" ")} 2>/dev/null || true; rm -f ${units.slots.map((x) => `/etc/systemd/system/${x.unit}`).join(" ")} ${q(units.upstream.file)}; systemctl daemon-reload`,
              o,
            ),
            flushBefore: true,
          },
          // the last node app on the server takes the websocket map along
          ...(ctx.sites.some((x) => x.node && x.spec.state === "present") ? [] : [absent(NODE_MAP_PATH, { owner: "web", handler: "nginx" })]),
        ]
      : []),
    absent(vhostPath(s), { ...o, handler: "nginx" }),
    absent(snippetDir(s), { ...o, handler: "nginx", recursive: true }),
    absent(poolPath(s), { ...o, handler: `php${s.php}-fpm` }),
    absent(cronPath(s), o),
    absent(`/etc/logrotate.d/fornax-${s.slug}`, o),
    absent(`/etc/fornax/sites/${s.domain}.json`, o),
    absent(`/etc/fornax/hook-secrets/${s.domain}`, o),
    // with purge the whole home goes with its user (also one whose user is gone already)
    ...s.spec.files.filter((f) => !(s.spec.purge && homeUser(f.path) === s.user)).map((f) => absent(f.path, o)),
    // the user's Redis stays when a site that is still here runs as the same user (a site moved to a new name)
    ...(ctx.sites.some((x) => x.user === s.user && x.spec.state === "present") ? [] : redisResources(s, o)),
  ];
  if (ctx.server.services.includes("supervisor")) r.push(prune(`daemons:${s.domain}`, `/etc/supervisor/conf.d/fornax-${s.slug}-*.conf`, [], { ...o, handler: "supervisor" }));
  if (s.spec.purge) {
    const destructive = { ...o, destructive: true };
    // a database fornax does not manage is never dropped by it
    if (s.db?.manage && s.db.engine === "mysql") {
      r.push(check(`drop:mysql:${s.db.name}`, `DROP mysql database ${s.db.name} and user ${s.db.user}`, `[ "$(mysql -Nse "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${s.db.name}'")" = 0 ]`, `mysql -e "DROP DATABASE IF EXISTS \\\`${s.db.name}\\\`; DROP USER IF EXISTS '${s.db.user}'@'localhost';"`, destructive));
    } else if (s.db?.manage && s.db.engine === "postgres") {
      r.push(
        check(
          `drop:postgres:${s.db.name}`,
          `DROP postgres database ${s.db.name} and role ${s.db.user}`,
          `[ -z "$(runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='${s.db.name}'")" ]`,
          `runuser -u postgres -- dropdb --if-exists ${q(s.db.name)}; runuser -u postgres -- psql -q -c ${q(`DROP ROLE IF EXISTS "${s.db.user}"`)}`,
          destructive,
        ),
      );
    }
    r.push(
      // rm -rf removes links in the home as links, never what they point to
      check(`deluser:${s.user}`, `DELETE Linux user ${s.user} and /home/${s.user} (all releases, storage, .env, its Redis data)`, `! id -u ${q(s.user)} && [ ! -e /home/${s.user} ] && [ ! -L /home/${s.user} ]`, `if id -u ${q(s.user)} >/dev/null 2>&1 && [ "$(id -u ${q(s.user)})" -lt 1000 ]; then echo "${s.user} is a system account — not deleting it" >&2; false; else pkill -u ${q(s.user)} || true; userdel -r ${q(s.user)} 2>/dev/null || true; rm -rf /home/${s.user} ${SITE_LOG_DIR(s.user)} ${siteRedis(s.user).data}; fi`, destructive),
      absent(dbSecret(s), { ...o, destructive: true }),
    );
    if (s.tlsIssuer === "letsencrypt") r.push(check(`certdel:${s.domain}`, `delete certificate ${s.domain}`, `[ ! -d /etc/letsencrypt/live/${s.domain} ]`, `certbot delete --cert-name ${q(s.domain)} --non-interactive`, o));
    if (s.tlsIssuer === "selfsigned") r.push(absent(`/etc/fornax/tls/${s.domain}`, { ...o, recursive: true }));
  }
  return r;
}

/**
 * One Redis server per site, run as the site user: only it reaches the socket (0700 directories in
 * /run and /var/lib), so no other site reads its cache, sessions or queues — and FLUSHDB stays its own.
 */
export const REDIS_UNIT = `${H}[Unit]
Description=Redis of site user %i (fornax)
After=network.target

[Service]
User=%i
ExecStart=/usr/bin/redis-server /etc/fornax/redis/%i.conf
RuntimeDirectory=fornax-redis/%i
RuntimeDirectoryMode=0700
StateDirectory=fornax-redis/%i
StateDirectoryMode=0700
UMask=0077
Restart=always
RestartSec=2
LimitNOFILE=10032
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX

[Install]
WantedBy=multi-user.target
`;

export function redisConf(s: ResolvedSite): string {
  const r = siteRedis(s.user);
  return `${H}port 0
unixsocket ${r.socket}
unixsocketperm 700
dir ${r.data}
maxmemory ${s.spec.redis.maxmemory}
# cache entries and sessions expire and give way first; queued jobs are never evicted
maxmemory-policy volatile-lru
save 3600 1 300 100 60 10000
appendonly no
logfile ""
`;
}

function redisResources(s: ResolvedSite, o: { owner: string }): Resource[] {
  const r = siteRedis(s.user);
  // no Redis on the server at all: nothing to stop either (a site set to "none" stops one it had, below)
  if (s.redis === "none" && s.spec.redis.instance !== "none") return [];
  if (s.redis === "own" && s.spec.state === "present") return [file(r.conf, redisConf(s), { ...o, handler: r.unit }), service(r.unit, o)];
  // switched to shared, or the site is gone: an instance it had stops; its data stays until --purge
  return [check(`redis-off:${s.user}`, `stop and disable ${r.unit}`, `[ ! -e ${q(r.conf)} ]`, `systemctl disable --now ${q(r.unit)} 2>/dev/null || true; rm -f ${q(r.conf)}`, o)];
}

/** Server-wide resources the sites need (certbot, deploy machinery, the Redis unit). */
export function deployResources(ctx: ModuleCtx): Resource[] {
  const r: Resource[] = [];
  const live = ctx.sites.filter((s) => s.spec.state === "present");
  if (live.some((s) => s.redis === "own")) r.push(dir("/etc/fornax/redis", { owner: "redis" }), file("/etc/systemd/system/fornax-redis@.service", REDIS_UNIT, { owner: "redis" }));
  if (live.some((s) => s.tlsIssuer === "letsencrypt") || (ctx.server.webhook?.domain && ctx.fleet.config.tls.issuer === "letsencrypt")) {
    r.push(
      packages("certbot", ["certbot"], { owner: "tls" }),
      file("/etc/letsencrypt/renewal-hooks/deploy/fornax-reload-nginx", `#!/bin/sh\n${H}nginx -t -q && systemctl reload nginx\n`, { owner: "tls", mode: "0755", handler: "none" }),
    );
  }
  r.push(...deployServerResources(ctx));
  return r;
}
