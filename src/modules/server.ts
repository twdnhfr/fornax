import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { absent, check, dir, file, packages, service, symlink, type Resource } from "../core/resource.ts";
import { q } from "../core/shell.ts";
import { aptRepo, configFiles, DISTROS, HEADER, REPOS, SECRETS, type ModuleCtx } from "./common.ts";
import { rootKeys } from "./root-access.ts";

const H = `# ${HEADER}\n`;

// ---- base ----------------------------------------------------------------------

export function base(ctx: ModuleCtx): Resource[] {
  const s = ctx.server;
  const o = { owner: "base" };
  const r: Resource[] = [];
  if (s.apt_mirror) {
    r.push(
      file(
        "/etc/apt/sources.list.d/ubuntu.sources",
        `${H}Types: deb\nURIs: ${s.apt_mirror}\nSuites: ${ctx.facts.codename} ${ctx.facts.codename}-updates ${ctx.facts.codename}-backports ${ctx.facts.codename}-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n`,
        { ...o, handler: "apt" },
      ),
    );
  }
  r.push(
    packages("base", ["ca-certificates", "curl", "gnupg", "git", "unzip", "zip", "acl", "rsync", "jq", "sqlite3", "cron", "logrotate", "unattended-upgrades", "openssl", "htop", "sudo", ...s.packages], o),
    symlink("/etc/localtime", `/usr/share/zoneinfo/${s.timezone}`, o),
    file("/etc/timezone", `${s.timezone}\n`, o),
    file("/etc/apt/apt.conf.d/20auto-upgrades", `${H}APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n`, o),
    file(
      "/etc/apt/apt.conf.d/52fornax-upgrades",
      `${H}Unattended-Upgrade::Allowed-Origins {
    "\${distro_id}:\${distro_codename}-security";
    "\${distro_id}ESMApps:\${distro_codename}-apps-security";
    "\${distro_id}ESM:\${distro_codename}-infra-security";
};
Unattended-Upgrade::Automatic-Reboot "${s.auto_reboot === false ? "false" : "true"}";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
${s.auto_reboot === false ? "" : `Unattended-Upgrade::Automatic-Reboot-Time "${s.auto_reboot}";\n`}`,
      o,
    ),
    file("/etc/systemd/journald.conf.d/fornax.conf", `${H}[Journal]\nSystemMaxUse=500M\n`, o),
    service("cron", o),
    dir("/etc/fornax", { ...o, mode: "0755" }),
    dir(SECRETS, { ...o, mode: "0711" }),
    dir("/var/lib/fornax", { ...o, mode: "0755" }),
  );
  if (s.swap) {
    r.push(
      check(
        "swap",
        `swap file ${s.swap}`,
        "swapon --show=NAME --noheadings | grep -qx /swapfile",
        `[ -f /swapfile ] || { fallocate -l ${s.swap} /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }; swapon /swapfile; grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab`,
        o,
      ),
    );
  }
  return r;
}

// ---- access --------------------------------------------------------------------

export function ufwRules(ctx: ModuleCtx): string[] {
  const s = ctx.server;
  const rules = ["allow 80/tcp", "allow 443/tcp"];
  // the server's own SSH port (ssh.port of the server file) before the fleet's — the one fornax connects to
  const sshPort = s.ssh?.port ?? ctx.fleet.config.ssh.port;
  // From the tailnet only SSH (sshd as a fallback; Tailscale SSH answers before the firewall anyway).
  // Note: in tailscaled's default netfilter mode its own ts-input chain accepts everything from
  // tailscale0 before ufw sees it — who may reach what over the tailnet is the tailnet policy's
  // decision (acls), this rule only holds with --netfilter-mode=nodivert.
  if (ctx.fleet.config.access === "tailscale") rules.push(`allow in on tailscale0 to any port ${sshPort} proto tcp`);
  else for (const from of s.firewall.ssh_from) rules.push(from === "any" ? `allow ${sshPort}/tcp` : `allow from ${from} to any port ${sshPort} proto tcp`);
  for (const a of s.firewall.allow) {
    // written as `ufw show added` lists them, so the probe compares like with like
    if (a.on) rules.push(`allow in on ${a.on}${a.from ? ` from ${a.from}` : ""}${a.port !== undefined ? ` to any port ${a.port} proto ${a.proto}` : ""}`);
    else rules.push(a.from ? `allow from ${a.from} to any port ${a.port} proto ${a.proto}` : `allow ${a.port}/${a.proto}`);
  }
  return rules;
}

export function access(ctx: ModuleCtx): Resource[] {
  const o = { owner: "access" };
  const admin = ctx.admin;
  const r: Resource[] = [
    check("group:isolated", "group isolated (site users cannot read each other's homes)", "getent group isolated", "groupadd isolated", o),
    check(`user:${admin}`, `admin user ${admin} (runs nginx)`, `id -u ${q(admin)}`, `id -u ${q(admin)} >/dev/null 2>&1 || useradd -m -s /bin/bash ${q(admin)}`, o),
    check(`acl:/home/${admin}`, `isolate /home/${admin}`, `getfacl -p /home/${admin} 2>/dev/null | grep -q '^group:isolated:---'`, `setfacl -m g:isolated:000 /home/${admin}`, o),
  ];
  // with ssh.root_keys the file is written whole (root-access.ts); otherwise keys are only added
  for (const key of rootKeys(ctx.fleet, ctx.server) ? [] : ctx.fleet.config.ssh.authorized_keys) {
    const fp = key.trim().split(/\s+/)[1]?.slice(-16) ?? key.slice(-16);
    r.push(
      check(`root-key:${fp}`, `authorize ssh key …${fp} for root`, `grep -qF ${q(key.trim())} /root/.ssh/authorized_keys`, `install -d -m 700 /root/.ssh; echo ${q(key.trim())} >> /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys`, o),
    );
  }
  // Tailscale before the firewall: with access "tailscale" ufw lets SSH in only on tailscale0,
  // so the server has to be in the tailnet before that rule can be the only way in
  if (ctx.fleet.config.access === "tailscale") {
    const authKey = ctx.fleet.config.tailscale?.auth_key;
    const join = `{ tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; } || printf %s "$FORNAX_SECRET_TS_AUTHKEY" | tailscale up --ssh=${ctx.fleet.config.tailscale?.ssh_server !== false} --hostname=${q(ctx.server.server)} --auth-key=file:/dev/stdin`;
    r.push(
      ...aptRepo(ctx, REPOS.tailscale!, "access"),
      packages("tailscale", ["tailscale"], o),
      service("tailscaled", o),
      {
        ...check(
          "tailscale-up",
          "join the tailnet (tailscale up --ssh)",
          `tailscale status --json | grep -q '"BackendState": *"Running"'`,
          authKey ? join : `echo "tailscale is installed but not logged in: set tailscale.auth_key in fornax.yaml, or run 'tailscale up --ssh' once on the server" >&2; false`,
          o,
        ),
        ...(authKey ? { env: { FORNAX_SECRET_TS_AUTHKEY: authKey } } : {}),
      },
    );
    // the fleet key got the server into the tailnet; from then on Tailscale SSH is the way in, and one
    // key shared by every server stays on none of them (it stays in the vault for the next one)
    const key = ctx.facts.fleetKey;
    if (key && !/^[\d.]+$|:/.test(ctx.server.host)) {
      r.push(check("fleet-key-off", "remove the fleet's SSH key from root (Tailscale SSH has taken over)", `! grep -qF ${q(key)} /root/.ssh/authorized_keys`, `{ grep -vF ${q(key)} /root/.ssh/authorized_keys || true; } > /root/.ssh/authorized_keys.fornax; cat /root/.ssh/authorized_keys.fornax > /root/.ssh/authorized_keys; rm -f /root/.ssh/authorized_keys.fornax`, o));
    }
  }
  r.push(
    file(
      "/etc/ssh/sshd_config.d/00-fornax.conf",
      `${H}PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\nX11Forwarding no\n`,
      o,
    ),
  );
  // ufw: the rule file is the wish; the probe reads ufw's own rule list (`ufw show added`),
  // so hand-added rules show up as drift. Applying adds missing rules first and only then
  // deletes extra ones — there is never a moment without the SSH rule.
  const rules = ufwRules(ctx);
  const rulesFile = "/etc/fornax/ufw.rules";
  const current = `ufw show added 2>/dev/null | sed -n 's/^ufw //p' | sort | tr '\\n' ';'`;
  r.push(
    packages("access", ["ufw", "openssh-server"], o),
    file(rulesFile, `${H}${rules.join("\n")}\n`, o),
    {
      ...check(
        "ufw",
        `firewall: deny incoming except ${rules.map((x) => x.replace(/^allow /, "")).join(", ")}`,
        "true",
        `ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
grep -v '^#' ${rulesFile} | while read -r rule; do [ -n "$rule" ] && ufw $rule >/dev/null; done
ufw show added | sed -n 's/^ufw //p' | while read -r rule; do grep -qxF -- "$rule" ${rulesFile} || { ufw delete $rule >/dev/null; echo "removed firewall rule: $rule"; }; done
ufw --force enable >/dev/null
systemctl enable --now ufw >/dev/null 2>&1 || true
rm -f /var/lib/fornax/ufw.applied`,
        o,
      ),
      probe: `if ufw status 2>/dev/null | grep -q 'Status: active' && ufw status verbose | grep -q 'deny (incoming)'; then ${current}; else echo inactive; fi`,
      desired: [...rules].sort().map((x) => `${x};`).join(""),
    },
  );
  if (ctx.server.services.includes("fail2ban")) {
    r.push(
      packages("fail2ban", ["fail2ban"], o),
      file("/etc/fail2ban/jail.d/fornax.conf", `${H}[sshd]\nenabled = true\nbackend = systemd\nmaxretry = 5\nbantime = 1h\n`, o),
      service("fail2ban", o),
    );
  }
  return r;
}

// ---- security ------------------------------------------------------------------

export const CROWDSEC_PORT = 8180;

export function security(ctx: ModuleCtx): Resource[] {
  if (!ctx.server.services.includes("crowdsec")) return [];
  const o = { owner: "security" };
  const lapi = "/etc/crowdsec/config.yaml /etc/crowdsec/local_api_credentials.yaml /etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml";
  const r: Resource[] = [
    ...aptRepo(ctx, REPOS.crowdsec!, "security"),
    packages("crowdsec", ["crowdsec", "crowdsec-firewall-bouncer-iptables"], o),
    // CrowdSec's API defaults to 8080 — the port Reverb and many dev servers expect; move it like Forge does
    check(
      "crowdsec-port",
      `CrowdSec API on 127.0.0.1:${CROWDSEC_PORT} (keeps 8080 free for apps, e.g. Reverb)`,
      `! grep -qs '127.0.0.1:8080' ${lapi}`,
      `sed -i 's#127\.0\.0\.1:8080#127.0.0.1:${CROWDSEC_PORT}#' ${lapi}
systemctl restart crowdsec
systemctl restart crowdsec-firewall-bouncer || true`,
      o,
    ),
    service("crowdsec", o),
  ];
  const custom = join(ctx.fleet.dir, "crowdsec", "scenarios");
  if (existsSync(custom)) {
    for (const f of readdirSync(custom).filter((x) => x.endsWith(".yaml"))) {
      r.push(file(`/etc/crowdsec/scenarios/fornax-${f}`, readFileSync(join(custom, f), "utf8"), o));
    }
  }
  return r;
}

// ---- web -----------------------------------------------------------------------

export const nginxConf = (admin: string) => `${H}user ${admin};
worker_processes auto;
worker_rlimit_nofile 8192;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log warn;

events {
    worker_connections 2048;
    multi_accept on;
}

http {
    sendfile on;
    tcp_nopush on;
    types_hash_max_size 2048;
    server_names_hash_bucket_size 128;
    server_tokens off;
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format vhost '$host $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent" $request_time';
    access_log /var/log/nginx/access.log vhost;

    gzip on;
    gzip_comp_level 5;
    gzip_min_length 256;
    gzip_proxied any;
    gzip_vary on;
    gzip_types application/javascript application/json application/xml application/rss+xml image/svg+xml text/css text/plain text/xml;

    client_max_body_size 64m;
    fastcgi_read_timeout 120;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
`;

export const ACME_SNIPPET = `${H}location ^~ /.well-known/acme-challenge/ {
    root /var/lib/fornax/acme;
    default_type text/plain;
    try_files $uri =404;
}
`;

/** Log format of fornax's vhosts — its own name, so it never collides with a hand-made `vhost` format. */
export const LOG_FORMAT = `${H}log_format fornax '$host $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent" $request_time';
`;

/**
 * What fornax's generated vhosts include. Part of the web module, and also brought along by every
 * generated site, so a site can be converted on a server whose nginx fornax does not manage
 * (identical resources merge).
 */
export function nginxSupport(owner = "web"): Resource[] {
  const o = { owner };
  return [
    dir("/etc/nginx/fornax", o),
    dir("/var/lib/fornax", o),
    dir("/var/lib/fornax/acme", o),
    file("/etc/nginx/fornax/acme.conf", ACME_SNIPPET, o),
    file("/etc/nginx/fornax/ssl.conf", SSL_SNIPPET, o),
    file("/etc/nginx/conf.d/fornax-log.conf", LOG_FORMAT, o),
  ];
}

export const SSL_SNIPPET = `${H}ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
ssl_prefer_server_ciphers off;
ssl_session_cache shared:fornax:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;
`;

const CATCH_ALL = `${H}# Unknown hosts get nothing; ACME challenges work for any name pointing here.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    include /etc/nginx/fornax/acme.conf;
    location / { return 444; }
}
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_reject_handshake on;
}
`;

export function web(ctx: ModuleCtx): Resource[] {
  const o = { owner: "web" };
  return [
    ...aptRepo(ctx, REPOS.nginx!, "web"),
    file("/etc/apt/preferences.d/99fornax-nginx", `${H}Package: *\nPin: origin nginx.org\nPin: release o=nginx\nPin-Priority: 900\n`, { ...o, handler: "apt" }),
    packages("nginx", ["nginx"], o),
    dir("/etc/nginx/sites-available", o),
    dir("/etc/nginx/sites-enabled", o),
    file("/etc/nginx/nginx.conf", nginxConf(ctx.admin), o),
    ...nginxSupport(),
    absent("/etc/nginx/conf.d/default.conf", { ...o, summary: "remove the package's default server" }),
    file("/etc/nginx/sites-available/000-catch-all", CATCH_ALL, o),
    symlink("/etc/nginx/sites-enabled/000-catch-all", "/etc/nginx/sites-available/000-catch-all", o),
    service("nginx", o),
  ];
}

// ---- php -----------------------------------------------------------------------

const PHP_EXTENSIONS = ["fpm", "cli", "common", "mbstring", "xml", "curl", "zip", "bcmath", "intl", "gd", "mysql", "pgsql", "sqlite3", "redis", "readline", "igbinary", "msgpack"];

/** fornax's php.ini settings; a server's php_ini overrides and extends them. */
export const PHP_INI_DEFAULTS: Record<string, string> = {
  memory_limit: "512M",
  upload_max_filesize: "64M",
  post_max_size: "64M",
  max_execution_time: "60",
  expose_php: "Off",
  "opcache.enable": "1",
  "opcache.memory_consumption": "256",
  "opcache.max_accelerated_files": "20000",
  "opcache.validate_timestamps": "1",
  "opcache.revalidate_freq": "2",
};

export const phpIni = (v: string, overrides: Record<string, string> = {}, sapi: "fpm" | "cli" = "fpm") => {
  // the CLI runs queues and migrations: no time limit there, whatever the web requests get
  const ini = { ...PHP_INI_DEFAULTS, ...overrides, ...(sapi === "cli" ? { max_execution_time: "0" } : {}) };
  return `; ${HEADER}\n${Object.entries(ini).map(([k, val]) => `${k} = ${val}`).join("\n")}\n; PHP ${v}\n`;
};

export function php(ctx: ModuleCtx): Resource[] {
  const s = ctx.server;
  const o = { owner: "php" };
  // "8.5:imagick" installs an extension for one version only
  const extsFor = (v: string) => [...PHP_EXTENSIONS, ...s.php_extensions.flatMap((e) => (e.includes(":") ? (e.split(":")[0] === v ? [e.split(":")[1]!] : []) : [e]))];
  // Without the PPA (new Ubuntu releases) the distribution's own PHP is used.
  const r: Resource[] = ctx.facts.phpPpa ? [...aptRepo(ctx, REPOS.php!, "php")] : [];
  for (const v of s.php) {
    // From 8.5 on OPcache is part of the core build and has no package of its own.
    const exts = extsFor(v);
    const versionExts = Number(v) < 8.5 ? [...exts, "opcache"] : exts;
    r.push(
      packages(`php${v}`, versionExts.map((e) => `php${v}-${e}`), o),
      file(`/etc/php/${v}/fpm/conf.d/90-fornax.ini`, phpIni(v, s.php_ini), { ...o, handler: `php${v}-fpm` }),
      file(`/etc/php/${v}/cli/conf.d/90-fornax.ini`, phpIni(v, s.php_ini, "cli"), { ...o, handler: "none" }),
      service(`php${v}-fpm`, o),
    );
  }
  const def = s.php_default ?? s.php[s.php.length - 1]!;
  r.push(check("php-default", `php → php${def}`, `[ "$(readlink -f /usr/bin/php)" = /usr/bin/php${def} ]`, `update-alternatives --set php /usr/bin/php${def}`, o));
  if (s.tools.includes("composer")) {
    r.push(
      check(
        "composer",
        "composer in /usr/local/bin",
        "[ -x /usr/local/bin/composer ]",
        `cd /tmp
EXPECTED="$(curl -fsSL https://composer.github.io/installer.sig)"
curl -fsSL https://getcomposer.org/installer -o composer-setup.php
[ "$(php -r "echo hash_file('sha384', 'composer-setup.php');")" = "$EXPECTED" ] || { echo "composer installer checksum mismatch" >&2; exit 1; }
php composer-setup.php --quiet --install-dir=/usr/local/bin --filename=composer; rm -f composer-setup.php`,
        { ...o, flushBefore: true },
      ),
    );
  }
  if (s.tools.includes("bun")) {
    r.push(check("bun", "bun in /usr/local/bin", "[ -x /usr/local/bin/bun ]", "curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null; rm -rf /usr/local/_bun 2>/dev/null; true", o));
  }
  if (s.tools.includes("node")) r.push(...aptRepo(ctx, REPOS.node!, "php"), packages("node", ["nodejs"], o));
  return r;
}

// ---- data ----------------------------------------------------------------------

export function data(ctx: ModuleCtx): Resource[] {
  const s = ctx.server;
  const o = { owner: "data" };
  const r: Resource[] = [];
  if (s.services.includes("mysql")) {
    r.push(
      packages("mysql", ["mysql-server"], o),
      file("/etc/mysql/mysql.conf.d/zz-fornax.cnf", `${H}[mysqld]\nbind-address = 127.0.0.1\nmysqlx-bind-address = 127.0.0.1\n`, o),
      service("mysql", o),
    );
  }
  if (s.services.includes("postgres")) {
    const needsVector = ctx.sites.some((x) => x.db?.engine === "postgres" && x.db.extensions.includes("vector"));
    const pg = DISTROS[ctx.facts.version]!.postgres;
    r.push(packages("postgres", ["postgresql", ...(needsVector ? [`postgresql-${pg}-pgvector`] : [])], o), service("postgresql", o));
  }
  if (s.services.includes("redis")) {
    r.push(
      ...(s.redis.source === "official"
        ? [
            ...aptRepo(ctx, REPOS.redis!, "data"),
            packages("redis", ["redis-server"], o),
            // a server set up from Ubuntu's package moves to the repo's version (config kept)
            check(
              "redis-official",
              "Redis from packages.redis.io",
              `apt-cache policy redis-server | awk '/Installed:/{i=$2} /Candidate:/{c=$2} END{exit !(i==c && i ~ /rl/)}'`,
              "apt-get -o DPkg::Lock::Timeout=900 -o Dpkg::Options::=--force-confold install -y -qq redis-server redis-tools >/dev/null",
              { ...o, handler: "redis" },
            ),
          ]
        : [packages("redis", ["redis-server"], o)]),
      file("/etc/redis/fornax.conf", `${H}bind 127.0.0.1 -::1\nprotected-mode yes\n${s.redis.password ? "include /etc/redis/fornax-auth.conf\n" : ""}`, { ...o, user: "redis:redis", mode: "0640" }),
      check("redis-include", "redis.conf includes /etc/redis/fornax.conf", "grep -qx 'include /etc/redis/fornax.conf' /etc/redis/redis.conf", "echo 'include /etc/redis/fornax.conf' >> /etc/redis/redis.conf", { ...o, handler: "redis" }),
    );
    if (s.redis.password) {
      r.push(
        check(
          "redis-password",
          "redis password (stored in /etc/fornax/secrets/redis)",
          `[ -s ${SECRETS}/redis ] && grep -q '^requirepass ' /etc/redis/fornax-auth.conf`,
          `[ -s ${SECRETS}/redis ] || { umask 077; openssl rand -hex 24 > ${SECRETS}/redis; }
printf 'requirepass %s\\n' "$(cat ${SECRETS}/redis)" > /etc/redis/fornax-auth.conf; chown redis:redis /etc/redis/fornax-auth.conf; chmod 0640 /etc/redis/fornax-auth.conf`,
          { ...o, handler: "redis" },
        ),
      );
    }
    r.push(service("redis-server", o));
  }
  if (s.services.includes("memcached")) {
    // like MySQL and Redis: only this machine — the package listens on every address some panels set
    const listens = `grep -E '^-l ' /etc/memcached.conf | tr -s ' ' | LC_ALL=C sort | tr '\\n' ';'`;
    r.push(packages("memcached", ["memcached"], o), {
      ...check("memcached-bind", "memcached on 127.0.0.1 and ::1 only", "true", `sed -i '/^-l /d' /etc/memcached.conf; printf -- '-l 127.0.0.1\\n-l ::1\\n' >> /etc/memcached.conf`, { ...o, handler: "memcached" }),
      probe: listens,
      desired: "-l 127.0.0.1;-l ::1;",
    }, service("memcached", o));
  }
  if (s.services.includes("supervisor")) r.push(packages("supervisor", ["supervisor"], o), service("supervisor", o));
  return r;
}

/** server.retire: taken-over files that fornax's own configuration replaces (backed up by the apply). */
export function serverRetire(ctx: ModuleCtx): Resource[] {
  return ctx.server.retire.map((path) => absent(path, { owner: "files", summary: `retire ${path}` }));
}

export function serverFiles(ctx: ModuleCtx): Resource[] {
  return configFiles(ctx, ctx.server.files, "files");
}

export const SERVER_MODULES = { base, access, security, web, php, data } as const;
