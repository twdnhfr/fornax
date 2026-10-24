import { z } from "zod";
import { isIPv4 } from "./names.ts";

// Values from the fleet end up in root's shell, cron, supervisor and nginx configs: each field
// takes only the characters its job needs, and only the free-text fields may span lines.
/** A lower-case host name (sites, aliases, proxies, the webhook). */
export const Hostname = z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "a lower-case host name");
/** A name a site answers to: an IP address is none (no certificate, no SNI). */
const SiteName = Hostname.refine((h) => !isIPv4(h), "not an IP address (<ip with dashes>.sslip.io is a name for one, e.g. 192-0-2-10.sslip.io)");
/** A path of plain characters: no spaces, quotes, `;`, `$` or newlines. */
const PlainPath = z.string().regex(/^[\w./~@+-]*$/, "letters, digits and . / ~ @ + - _ only");
/** Relative to a site directory and staying inside it. */
const InsidePath = PlainPath.refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "a path inside the site directory (relative, no ..)");
/** One line: cron and supervisor read a newline as a new entry. */
const Line = z.string().regex(/^[^\n\r\0]*$/, "a single line");
const Name = z.string().regex(/^[\w.-]+$/, "letters, digits and . - _ only");
/** One authorized_keys line: options (optional), key type, key, comment. */
const AuthorizedKey = z.string().regex(/^([a-z-]+(="[^"\n]*")?(,[a-z-]+(="[^"\n]*")?)* )?(ssh-(ed25519|rsa)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+( [^\n]*)?$/, "an OpenSSH public key line");

/** A file fornax manages verbatim: content inline or from a path relative to the fleet dir. */
export const FileSchema = z
  .strictObject({
    /** Absolute path of the file on the server. */
    path: z.string().startsWith("/"),
    /** File whose content is written, relative to the fleet dir (or absolute). */
    source: z.string().optional(),
    /** The file's content, inline. */
    content: z.string().optional(),
    /** Octal file mode, e.g. "0600". */
    mode: z.string().regex(/^0?[0-7]{3,4}$/).default("0644"),
    /** Owner of the file as user:group. */
    owner: z.string().default("root:root"),
    /** What to reload after a change. "auto" derives it from the path. */
    handler: z.string().default("auto"),
  })
  .refine((f) => (f.source === undefined) !== (f.content === undefined), {
    message: "a file needs exactly one of source or content",
  });

export const PRESETS = ["laravel", "php", "static", "node"] as const;
export type Preset = (typeof PRESETS)[number];

export const DaemonSchema = z.strictObject({
  /**
   * Short name in the program name (fornax-<site>-<name>) and its log file; default: from the
   * command (horizon, queue, reverb, ssr, octane, pulse) or d1, d2 …
   */
  name: z.string().regex(/^[a-z0-9-]+$/).optional(),
  /** The command supervisor runs, e.g. "php artisan queue:work --tries=3". */
  cmd: Line,
  /** How many copies supervisor runs (numprocs). */
  processes: z.number().int().min(1).default(1),
  /**
   * Seconds supervisor waits after SIGTERM before it kills the process (stopwaitsecs): time for a
   * running job to finish.
   */
  stopwait: z.number().int().min(1).default(60),
  /** Relative to the current release unless absolute. */
  directory: PlainPath.optional(),
  /** Supervisor program name, when it is not fornax's own (adopted Forge daemons: daemon-<id>). */
  program: Name.optional(),
});

/** Five cron fields or an @keyword; the command is one line. */
const CronAt = z.string().regex(/^(@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)|[\w*,/-]+( +[\w*,/-]+){4})$/, "five cron fields or @daily etc.");

export const CronSchema = z.strictObject({
  /** When: five cron fields ("0 3 * * *") or @daily, @hourly etc. */
  at: CronAt,
  /** The command, run with bash in the current release. */
  cmd: Line,
});

export const SiteSchema = z.strictObject({
  /** owner/name on GitHub or a git URL (never starting with "-": git would read an option). */
  repo: z.string().regex(/^[\w@:/.~+-]+$/, "owner/name or a git URL").refine((r) => !r.startsWith("-"), "must not start with -").optional(),
  /** Git branch that is deployed; the webhook ignores pushes to other branches. */
  branch: z.string().regex(/^[\w./+-]+$/, "a git branch name").refine((b) => !b.startsWith("-") && !b.includes(".."), "a git branch name").default("main"),
  /**
   * Linux user the site runs as (PHP-FPM pool, daemons, cron, deploys); its files live in
   * /home/<user>/<domain>. Default: the domain's first label (shop.example.com: shop). Each site
   * needs its own.
   */
  user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).optional(),
  /** More names that serve the same app; in the site's vhost and certificate. */
  aliases: z.array(SiteName).default([]),
  /**
   * Extra names that proxy to a local port instead of serving the app (e.g. a Reverb websocket
   * server on ws.<domain>). Covered by the site's certificate; cert/key only for tls "existing".
   */
  proxies: z
    .array(
      z.strictObject({
        /** The name, e.g. ws.example.com. */
        domain: SiteName,
        /** Local port on 127.0.0.1 that nginx forwards to. */
        port: z.number().int().min(1).max(65535),
        /** Pass websocket upgrades and keep idle connections open for an hour; false for plain HTTP. */
        websocket: z.boolean().default(true),
        /**
         * With tls.issuer "existing": path of this name's certificate on the server (otherwise the
         * site's is used).
         */
        cert: z.string().optional(),
        /** With tls.issuer "existing": path of this name's private key on the server. */
        key: z.string().optional(),
      }),
    )
    .default([]),
  /** PHP version of the site, one of the server's `php`; default: the server's php_default. */
  php: z.string().regex(/^\d\.\d$/, "a PHP version such as 8.4").optional(),
  /**
   * What kind of app: "laravel" (artisan steps on deploy, .env and storage set up), "php" (PHP-FPM
   * without Laravel steps), "static" (files only, no PHP) or "node" (its own server, see node).
   * Decides the default build, web_dir, shared paths and Redis.
   */
  preset: z.enum(PRESETS).default("laravel"),
  /**
   * preset node: the app's own server, behind nginx. `start` runs in the release as the site user,
   * with PORT, HOST and HOSTNAME (127.0.0.1) set — e.g. "bun run start" or "node
   * .next/standalone/server.js". A deploy starts the new release on the other of two ports (`port`
   * and port+1; default: derived from the domain, 20000–27999) and switches nginx once it answers.
   */
  node: z
    .strictObject({
      // written into a systemd ExecStart: no quotes, $, %, ; or other shell syntax
      /**
       * Command that starts the app, e.g. "bun run start"; plain characters only (it goes into a
       * systemd unit).
       */
      start: z
        .string()
        .regex(/^[\w ./=:@+,-]+$/, "a plain command: letters, digits, spaces and . / = : @ + , - _ only")
        .refine((c) => c.trim() !== "" && !c.trim().startsWith("-"), "a command"),
      /** The first of the app's two ports (it takes port+1 as well); default: derived from the domain. */
      port: z.number().int().min(1024).max(65534).optional(),
    })
    .optional(),
  /** Document root relative to the release. */
  web_dir: InsidePath.optional(),
  /**
   * Paths kept in the site directory across releases and linked into each one, e.g. uploads.
   * Default: ["storage"] for preset laravel, none otherwise; .env and auth.json are always linked.
   */
  shared: z.array(InsidePath).optional(),
  /** Secret reference of composer's auth.json (private package repos, e.g. Flux Pro, Nova, Spark). */
  composer_auth: z.string().optional(),
  /**
   * A database for the site on this server: fornax creates it and its user with a generated
   * password (preset laravel: written into a new .env).
   */
  db: z
    .strictObject({
      /** "mysql" or "postgres"; the server needs the matching service. */
      engine: z.enum(["mysql", "postgres"]),
      /** Database name; default: the site user with - turned into _. */
      name: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional(),
      /** Database user (role); default: the site user with - turned into _. */
      user: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional(),
      /** PostgreSQL extensions created in the database, e.g. vector (installs pgvector). */
      extensions: z.array(z.string().regex(/^[a-z0-9_-]+$/, "an extension name")).default([]),
      /**
       * false: the database exists already (e.g. made by Forge) and stays the app's — fornax only
       * backs it up: no create, no password, no drop on --purge.
       */
      manage: z.boolean().default(true),
    })
    .optional(),
  /**
   * Redis for the site. "own" (default for preset laravel; adopted sites: "shared"; php, static and node: "none"): a Redis server only this site can
   * reach — a unix socket in a directory of the site user, so no other site reads its cache,
   * sessions or queues. "shared": the server's Redis on 127.0.0.1:6379 (all sites, one password).
   * "none": the site uses no Redis (cache, queue and sessions in the database or files).
   */
  redis: z
    .strictObject({
      /**
       * "own", "shared" or "none" (see redis); the default depends on the preset. Without redis in
       * the server's services it is always "none".
       */
      instance: z.enum(["own", "shared", "none"]).optional(),
      /** Memory limit of an own instance; keys with an expiry (cache, sessions) give way first, queues never. */
      maxmemory: z.string().regex(/^\d+(kb|mb|gb)$/i, "a size such as 256mb").default("256mb"),
    })
    .default({ maxmemory: "256mb" }),
  /**
   * Run Laravel's scheduler: a cron line runs `php artisan schedule:run` every minute as the site
   * user in the current release.
   */
  schedule: z.boolean().default(false),
  /**
   * Long-running processes (queue workers, Horizon, Reverb …) under supervisor, as the site user in
   * the current release; restarted after every deploy. Needs supervisor in the server's services.
   */
  daemons: z.array(DaemonSchema).default([]),
  /**
   * Cron jobs of the site, run as the site user in the current release; output goes to
   * ~/.fornax/cron.log.
   */
  cron: z.array(CronSchema).default([]),
  /** The site's certificate, covering the domain, aliases, www, redirects and proxies. */
  tls: z
    .strictObject({
      /**
       * "letsencrypt", "selfsigned", "existing" (a certificate fornax does not issue: tls.cert and
       * tls.key) or "none" (HTTP only); default: the fleet's tls.issuer.
       */
      issuer: z.enum(["letsencrypt", "selfsigned", "existing", "none"]).optional(),
      /** With issuer "existing": path of the certificate (full chain) on the server. */
      cert: z.string().optional(),
      /** With issuer "existing": path of the private key on the server. */
      key: z.string().optional(),
    })
    .default({}),
  /** Also answer www.<domain> and send it on to <domain> (301); www goes into the certificate. */
  www_redirect: z.boolean().default(false),
  /** Names that only send visitors on to the site's domain (301, path kept) — e.g. another TLD of the brand. In the certificate. */
  redirects: z.array(SiteName).default([]),
  /** Path a new release must answer (2xx/3xx) before and after it goes live; preset node checks "/" without it. */
  health_check: z.string().regex(/^\/?[\w./~@+%=&?-]*$/, "a URL path such as /up").optional(),
  /** How fornax deploys the site from `repo` (`fornax deploy` and on push). */
  deploy: z
    .strictObject({
      /**
       * false: fornax does not deploy the site (no deploy key, webhook or deploy config on the
       * server). Sites imported from Forge start with false.
       */
      enabled: z.boolean().default(true),
      /**
       * Build script in the repo, run with bash in the checkout. When the repo has it, it replaces
       * deploy.commands and the preset's own build; it gets FORNAX_SITE, FORNAX_SITE_PATH,
       * FORNAX_RELEASE_PATH, FORNAX_PHP and FORNAX_COMPOSER.
       */
      script: InsidePath.default(".fornax/deploy.sh"),
      /**
       * "in_place": pull and build in the site directory itself, as Forge does without
       * zero-downtime deploys — no releases/, no atomic switch, rollback rebuilds an older commit.
       */
      mode: z.enum(["releases", "in_place"]).default("releases"),
      /** Build commands (bash) for repos without a deploy script, e.g. taken over from Forge. */
      commands: z.string().optional(),
      /** How many releases stay on the server (for rollbacks). */
      keep_releases: z.number().int().min(2).default(5),
    })
    .default({ enabled: true, script: ".fornax/deploy.sh", mode: "releases", keep_releases: 5 }),
  /** Turn off generated files when they are adopted verbatim via `files`. */
  generate: z
    .strictObject({
      /** The site's nginx vhost. */
      vhost: z.boolean().default(true),
      /** The site's PHP-FPM pool. */
      pool: z.boolean().default(true),
      /** The supervisor programs of `daemons`. */
      daemons: z.boolean().default(true),
      /** The /etc/cron.d file for `schedule` and `cron`. */
      cron: z.boolean().default(true),
      /** Log rotation for the site's logs (/etc/logrotate.d). */
      logrotate: z.boolean().default(true),
    })
    .default({ vhost: true, pool: true, daemons: true, cron: true, logrotate: true }),
  /** Additions to the site's generated vhost. */
  nginx: z
    .strictObject({
      /** Snippet files (relative to the fleet dir) included inside the server block. */
      server: z.array(z.string()).default([]),
      /** Snippet files included at http level, before the server block. */
      http: z.array(z.string()).default([]),
      /** Largest request body nginx accepts for the site, e.g. 256M (fornax's nginx.conf allows 64m). */
      client_max_body_size: z.string().regex(/^\d+[kKmMgG]?$/, "a size such as 64M").optional(),
    })
    .default({ server: [], http: [] }),
  files: z.array(FileSchema).default([]),
  /** Files fornax removes from the server (e.g. Forge's configs after a site was converted). */
  retire: z.array(z.string().startsWith("/")).default([]),
  /** PHP-FPM pool sizing. */
  pool: z
    .strictObject({
      /** Most PHP workers at once (pm.max_children): the site's concurrent PHP requests. */
      max_children: z.number().int().min(1).default(10),
      /** Workers started with the pool (pm.start_servers). */
      start_servers: z.number().int().min(1).default(2),
      /** Fewest idle workers kept (pm.min_spare_servers). */
      min_spare_servers: z.number().int().min(1).default(1),
      /** Most idle workers kept (pm.max_spare_servers). */
      max_spare_servers: z.number().int().min(1).default(3),
      /** Requests a worker serves before it is replaced (pm.max_requests); 0: never. */
      max_requests: z.number().int().min(0).default(1000),
      /** Seconds a request may run before PHP-FPM ends it; 0: no limit. */
      request_terminate_timeout: z.number().int().min(0).default(120),
    })
    .default({ max_children: 10, start_servers: 2, min_spare_servers: 1, max_spare_servers: 3, max_requests: 1000, request_terminate_timeout: 120 }),
  /** Where an adopted site came from (filled by `fornax import forge`, used by `fornax site convert`). */
  origin: z
    .strictObject({
      /** The tool the site was taken over from: "forge". */
      tool: z.literal("forge"),
      /** The site's ID in Forge (its logrotate file forge-<id> is retired on convert). */
      site_id: z.string(),
      /**
       * Forge's IDs of the site's domains: their renewal cron files go when `fornax site convert
       * --only tls` switches the certificate.
       */
      domain_ids: z.array(z.string()).default([]),
      /**
       * Whether Forge deployed with releases; false makes `fornax site convert --only deploy` keep
       * deploying in place.
       */
      zero_downtime: z.boolean().default(true),
      /**
       * The site's scheduled jobs at Forge; `fornax site convert --only cron` moves them into
       * schedule and cron.
       */
      cron: z
        .array(
          z.strictObject({
            /** The schedule as Forge had it. */
            at: Line,
            /** The command as Forge had it. */
            cmd: Line,
          }),
        )
        .default([]),
    })
    .optional(),
  /** Nightly backup of this site: database dump, shared paths and .env (plus extra paths). */
  backup: z
    .strictObject({
      /** false: leave the site out of the nightly backup. */
      enabled: z.boolean().default(true),
      /** Extra absolute paths or paths relative to the site root. */
      paths: z.array(z.string()).default([]),
    })
    .default({ enabled: true, paths: [] }),
  /** Free text for people; shown by `fornax explain` (`fornax import forge` writes what it found). */
  notes: z.string().optional(),
  /**
   * Taken over from another tool (e.g. Forge): fornax manages only the listed `files`
   * byte for byte, plus deploy config once deploy.enabled is switched on.
   */
  adopted: z.boolean().default(false),
  /**
   * "absent" removes the site from the server: vhost, pool, cron, daemons, its files and its own
   * Redis. The user, home directory and database stay unless purge is set.
   */
  state: z.enum(["present", "absent"]).default("present"),
  /** With state: absent, also delete the Linux user, home directory and database. */
  purge: z.boolean().default(false),
});

export const MODULES = ["base", "access", "security", "web", "php", "data"] as const;
export const SERVICES = ["mysql", "postgres", "redis", "memcached", "supervisor", "crowdsec", "fail2ban"] as const;
export const TOOLS = ["composer", "bun", "node"] as const;

export const ServerSchema = z.strictObject({
  /**
   * The server's name in commands, backups and the tailnet (its Tailscale hostname); fornax writes
   * changes to servers/<server>.yaml. Change it with `fornax server rename`.
   */
  server: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Names the server had before (`fornax server rename`): backups made under them stay listed and restorable. */
  former_names: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).default([]),
  /**
   * What fornax connects to over SSH: an IP address or a host name (with access "tailscale" usually
   * the tailnet name).
   */
  host: z.string().regex(/^[\w.:-]+$/, "a host name or IP address"),
  /**
   * Where the server comes from: decides what fornax can do through the provider's API (destroy,
   * rename, snapshot, reinstall, reverse DNS).
   */
  provider: z
    .strictObject({
      /**
       * "manual" (any server, no API), "hetzner-cloud", "digitalocean" or "netcup" (no API either:
       * order and reinstall in its panel).
       */
      type: z.string().default("manual"),
      /**
       * The server's ID at the provider; the API commands (destroy, rename, snapshot, reinstall,
       * reverse DNS) need it.
       */
      id: z.union([z.string(), z.number()]).optional(),
      /**
       * Secret reference of the provider's API token for this server only; default:
       * provider_credentials.<type> in fornax.yaml.
       */
      credentials: z.string().optional(),
    })
    .default({ type: "manual" }),
  /**
   * "arm64" or "x86_64" (set by `fornax server create`). fornax compares it with the live server and
   * stops on a mismatch.
   */
  arch: z.enum(["arm64", "x86_64"]).optional(),
  /** Public addresses (for DNS); `host` may be a private or tailnet name. */
  public_ipv4: z.string().refine(isIPv4, "an IPv4 address").optional(),
  /** Public IPv6 address, for DNS records and reverse DNS. */
  public_ipv6: z.string().regex(/^[\da-fA-F:]+$/, "an IPv6 address").optional(),
  /** Server-level modules fornax manages. Adopted servers start with []. */
  modules: z.array(z.enum(MODULES)).default([...MODULES]),
  /**
   * PHP versions installed side by side, each with its own FPM service, e.g. ["8.3", "8.4"]. Where
   * the ondrej/php PPA does not serve the Ubuntu release, only the system's PHP is possible.
   */
  php: z.array(z.string().regex(/^\d\.\d$/)).default(["8.4"]),
  /**
   * PHP version the `php` command points to and sites without their own `php` use; default: the
   * last in `php`.
   */
  php_default: z.string().regex(/^\d\.\d$/, "a PHP version such as 8.4").optional(),
  /**
   * Extra PHP extensions for every version in `php`, by package suffix (imagick installs
   * php8.4-imagick), on top of fornax's standard set.
   */
  php_extensions: z.array(Name).default([]),
  /** php.ini settings over fornax's defaults (memory_limit 512M, upload_max_filesize and post_max_size 64M, max_execution_time 60, OPcache on), for every PHP version — e.g. { max_execution_time: "0", "opcache.validate_timestamps": "0" }. */
  php_ini: z.record(z.string().regex(/^[a-z][\w.]*$/, "a php.ini setting name"), z.string().regex(/^[^\n\r;"]*$/, "a single value without ; or quotes")).default({}),
  /** Files fornax removes from the server (taken-over configuration that fornax's own replaces, e.g. a panel's /etc/nginx/conf.d/gzip.conf); kept in the apply's backup. */
  retire: z.array(z.string().regex(/^\/[\w./@+-]+$/, "an absolute path").refine((p) => !p.split("/").includes(".."), "no ..")).default([]),
  /**
   * Services fornax installs and runs: mysql, postgres, redis (the server's own, also needed for
   * sites' own Redis), memcached, supervisor (needed for site daemons), crowdsec and fail2ban (SSH
   * jail).
   */
  services: z.array(z.enum(SERVICES)).default(["mysql", "postgres", "redis", "supervisor", "fail2ban"]),
  /**
   * Command-line tools the php module installs: composer and bun in /usr/local/bin, node (Node.js 22
   * from NodeSource). Preset node needs bun or node, depending on its start command.
   */
  tools: z.array(z.enum(TOOLS)).default(["composer", "bun"]),
  /** System time zone (/etc/localtime and /etc/timezone), e.g. Europe/Berlin. */
  timezone: z.string().regex(/^[\w/+-]+$/, "a time zone such as Europe/Berlin").default("UTC"),
  /** Size of a swap file (/swapfile) fornax creates and turns on, e.g. "2G". No swap file without it. */
  swap: z.string().regex(/^\d+[MG]$/).optional(),
  /** Unattended security upgrades reboot at this UTC time; false disables reboots. */
  auto_reboot: z.union([z.string().regex(/^\d\d:\d\d$/), z.literal(false)]).default("02:30"),
  /**
   * URL of an Ubuntu package mirror, written to /etc/apt/sources.list.d/ubuntu.sources in place of
   * the default archive.
   */
  apt_mirror: z.string().optional(),
  /**
   * ufw: incoming traffic is denied except ports 80 and 443, SSH and what is listed here. Rules
   * added by hand are removed on apply.
   */
  firewall: z
    .strictObject({
      /** Extra ufw allow rules: a port (from anywhere, or `from` one address), or everything coming `on` a network interface (e.g. tailscale0), optionally to one port. */
      allow: z
        .array(
          z
            .strictObject({
              /** A port, or a range such as "6000:6010". */
              port: z.union([z.number().int(), z.string().regex(/^\d+(:\d+)?$/, "a port or range such as 8000:8010")]).optional(),
              /** "tcp" or "udp". */
              proto: z.enum(["tcp", "udp"]).default("tcp"),
              /** Only from this address or network (e.g. 10.0.0.0/8); without it, from anywhere. */
              from: z.string().regex(/^[\da-fA-F.:/]+$/, "an address or network").optional(),
              /** Everything (or `port`) arriving on this network interface, e.g. tailscale0. */
              on: z.string().regex(/^[\w.-]+$/, "a network interface such as tailscale0").optional(),
            })
            .refine((r) => r.port !== undefined || r.on !== undefined, "a port, an interface (on), or both"),
        )
        .default([]),
      /** Who may reach port 22 in access mode "ssh". */
      ssh_from: z.array(z.string()).default(["any"]),
    })
    .default({ allow: [], ssh_from: ["any"] }),
  /** The server's shared Redis (127.0.0.1:6379). */
  redis: z
    .strictObject({
      /**
       * Require a password, generated on the server (/etc/fornax/secrets/redis) and written into new
       * Laravel .env files. false: no password.
       */
      password: z.boolean().default(true),
      /** "official": packages.redis.io (newer Redis, what Forge installs) instead of Ubuntu's package. */
      source: z.enum(["distro", "official"]).default("distro"),
    })
    .default({ password: true, source: "distro" }),
  /** Linux user nginx runs as; FPM sockets belong to it (adopted Forge servers: "forge"). */
  admin_user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).optional(),
  /** Overrides the fleet's ssh settings for this server (e.g. a non-root user with sudo). */
  ssh: z
    .strictObject({
      /** User fornax logs in as on this server; any user but root runs commands through sudo. */
      user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, "a Linux user name").optional(),
      /** SSH port of this server. */
      port: z.number().int().min(1).max(65535).optional(),
      /** For a non-root user: secret reference of its sudo password (omit for passwordless sudo). */
      sudo_password: z.string().optional(),
      /** Root keys for this server only, added to the fleet's ssh.root_keys (e.g. a panel that still manages it). */
      root_keys: z.array(AuthorizedKey).optional(),
    })
    .optional(),
  /** Set to false to switch the fleet's backups off for this server. */
  backup: z.boolean().default(true),
  /** Keep /etc in git with etckeeper — the server's history of every configuration change (fornax history). */
  history: z.boolean().default(true),
  /**
   * Push-to-deploy reaches each site through its own domain (https://<site>/.well-known/fornax-hook),
   * so a server needs nothing extra. `domain`: an extra hostname for the webhook as well (older
   * setups; sites keep working there until `fornax git connect` moves them). `port`: where the
   * webhook listens on 127.0.0.1.
   */
  webhook: z
    .strictObject({
      /** Extra hostname for the deploy webhook, with its own vhost and certificate (older setups). */
      domain: Hostname.optional(),
      /** Port on 127.0.0.1 the webhook listens on. No node app or proxy of a site may use it. */
      port: z.number().int().default(9300),
    })
    .optional(),
  /** Set by `fornax detach forge`: Forge's access and leftovers are removed on apply. */
  forge_detach: z
    .strictObject({
      /** Addresses whose ufw rules for port 22 (Forge's access) are removed on apply. */
      ufw_ssh_ips: z.array(z.string()).default([]),
    })
    .optional(),
  /** Extra packages to install. */
  packages: z.array(z.string().regex(/^[\w.+:=~-]+$/, "an apt package name")).default([]),
  files: z.array(FileSchema).default([]),
  sites: z.record(Hostname, SiteSchema).default({}),
  /** Free text for people; shown by `fornax explain`. */
  notes: z.string().optional(),
});

export const FleetSchema = z.strictObject({
  /** Config version (see core/config-version.ts); written by `fornax init` and `fornax fleet upgrade`. */
  version: z.number().int().min(1).optional(),
  /** The oldest fornax this fleet may be used with, e.g. ">=0.2.0": an older one refuses it (fornax_too_old) instead of acting on parts it does not know. */
  requires: z.string().regex(/^>=\d+\.\d+\.\d+(-[\w.]+)?$/, "a minimum version such as >=0.2.0").optional(),
  /**
   * Name of the fleet (`fornax init` sets it, default: the directory name). It appears in 1Password
   * item titles ("fornax <fleet> <server>"), in backup paths on the Storage Box
   * (<path>/<fleet>/<server>) and in the default vault name fornax-<fleet>.
   */
  fleet: z.string(),
  /**
   * A domain of yours whose subdomains reach the fleet's servers (a wildcard record, or `fornax dns
   * sync`): `--preview` hands out names from it, two words like quiet-harbor.<preview_domain> —
   * for sites without a domain of their own yet, or instead of a provider's throwaway domains.
   */
  preview_domain: SiteName.optional(),
  /**
   * How fornax reaches the servers. "ssh": over SSH on `host`, and ufw opens ssh.port (to
   * firewall.ssh_from). "tailscale": servers join the tailnet (see `tailscale`), and ufw lets SSH in
   * only from the tailnet.
   */
  access: z.enum(["ssh", "tailscale"]).default("ssh"),
  /** Linux admin user on servers fornax sets up (default "fornax"; servers from before the rename keep "anvil"). */
  admin_user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).optional(),
  /** How fornax logs in to the servers. A server's own `ssh:` overrides user, port and sudo_password. */
  ssh: z
    .strictObject({
      /** The user fornax logs in as. Any user other than root needs sudo: passwordless, or with sudo_password. */
      user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, "a Linux user name").default("root"),
      /** SSH port fornax connects to; with access "ssh", ufw keeps it open. */
      port: z.number().int().min(1).max(65535).default(22),
      /**
       * Private key file fornax logs in with (only this key, not your agent's). ~/ is your home
       * directory; other relative paths are relative to the fleet repo. Its .pub goes to servers that
       * `server create` orders. Without it (and without key): your ssh-agent and ~/.ssh/config.
       */
      identity_file: z.string().optional(),
      /**
       * The fleet's SSH key as a secret reference (`fornax secrets setup` makes one in the fleet's
       * 1Password vault). Held in an ssh-agent of fornax's own, never written to disk; new servers
       * are ordered with it. Takes the place of identity_file.
       */
      key: z.string().optional(),
      /**
       * known_hosts file for the servers' host keys (default ~/.ssh/known_hosts; relative paths are
       * relative to the fleet repo). A new host key is accepted on first contact; fornax drops stale
       * entries when it orders or reinstalls a server.
       */
      known_hosts_file: z.string().optional(),
      /** "none" ignores ~/.ssh/config (reproducible test setups). */
      config_file: z.string().optional(),
      /** Public keys that may log in as root (added, never removed). */
      authorized_keys: z.array(z.string()).default([]),
      /**
       * A hardware key (FIDO2, e.g. a YubiKey: `ssh-keygen -t ed25519-sk -O resident -O
       * verify-required`) fornax logs in with: its key handle file here. Every connection needs the
       * key touched (and its PIN, asked in a dialog); fornax keeps one connection per server open
       * for 10 minutes, so that is once per run. Someone at your unlocked laptop gets nowhere without it.
       */
      security_key: z.string().optional(),
      /**
       * How long a connection made with security_key stays open for the next command (OpenSSH
       * ControlPersist: "10m", "1h", seconds). Longer means fewer touches — and longer that
       * anything running as you on this machine can use it without one.
       */
      keep_open: z.string().regex(/^\d+[smh]?$/, 'a duration like "10m", "1h" or seconds').default("10m"),
      /**
       * Exactly these public keys may log in as root — /root/.ssh/authorized_keys is written from
       * them, anything else in it is removed (set this to your security key's public key). Without
       * root_keys, authorized_keys above only adds. Options may come first: `verify-required
       * sk-ssh-ed25519@openssh.com AAAA…` makes sshd itself insist on the key's PIN.
       */
      root_keys: z.array(AuthorizedKey).optional(),
      /** For a non-root user: secret reference of its sudo password (omit for passwordless sudo). */
      sudo_password: z.string().optional(),
      /** Extra OpenSSH options for every connection, passed as `-o Name=value`, e.g. { ServerAliveCountMax: "6" }. */
      options: z.record(Name, Line).default({}),
    })
    .default({ user: "root", port: 22, authorized_keys: [], options: {}, keep_open: "10m" }),
  /** Rules fornax checks before it changes anything. */
  policies: z
    .strictObject({
      /**
       * GitHub users or organisations whose repos sites may deploy (the owner in owner/name or a git
       * URL). Adding or changing a site, plan and apply refuse any other repo. Unset: any owner.
       */
      allowed_repo_owners: z.array(z.string()).optional(),
      /**
       * Site domains and server names fornax refuses to delete (site remove, server destroy, a plan
       * that purges a site) while they are on this list.
       */
      protected: z.array(z.string()).default([]),
      /**
       * UTC window "HH:MM-HH:MM" for server changes (apply, bootstrap, provision).
       * App deploys and rollbacks are not restricted: a push to the deploy branch is a deliberate act.
       */
      maintenance_window: z.string().regex(/^\d\d:\d\d-\d\d:\d\d$/).optional(),
    })
    .default({ protected: [] }),
  /** Certificate defaults for the fleet; a site's own tls.issuer takes precedence. */
  tls: z
    .strictObject({
      /**
       * Certificates for sites without a tls.issuer of their own, and for a webhook domain:
       * "letsencrypt" (certbot, HTTP challenge), "selfsigned" (made on the server) or "none" (plain
       * HTTP).
       */
      issuer: z.enum(["letsencrypt", "selfsigned", "none"]).default("letsencrypt"),
      /** Contact address for the ACME account (certbot --email). Without it, fornax registers with no address. */
      email: z.string().optional(),
      /** ACME directory; defaults to Let's Encrypt production. */
      acme_server: z.string().optional(),
      /** CA bundle on the server to trust the ACME server (test CAs like Pebble). */
      ca_bundle: z.string().optional(),
    })
    .default({ issuer: "letsencrypt" }),
  /**
   * DNS adapter: `fornax dns sync` points the A/AAAA records of every site name (and webhook domain)
   * at its server's public_ipv4/public_ipv6; `fornax dns status` compares them. Without it, you set
   * the records by hand.
   */
  dns: z
    .strictObject({
      /** The DNS provider; only "cloudflare" so far (records are created DNS only, not proxied). */
      type: z.string(),
      /** Secret reference to the provider's API token (Cloudflare: Zone:Read and DNS:Edit on the zones). */
      credentials: z.string(),
      /**
       * Zones fornax may use, e.g. [example.com]. When set, names outside them are refused; when
       * empty, the provider is asked for each parent domain of a name.
       */
      zones: z.array(z.string()).default([]),
    })
    .optional(),
  /** With access "tailscale": how new servers get into the tailnet (one of the two is needed for `server create`). */
  tailscale: z
    .strictObject({
      /**
       * Secret reference to a Tailscale API access token: fornax then makes a single-use auth key per
       * new server, turns off key expiry for servers, renames and removes their devices.
       */
      api_token: z.string().optional(),
      /**
       * Without an API token: a reusable auth key that tags the server with `tag` (make it so in the
       * Tailscale admin). It never reaches the server's disk or its cloud metadata.
       */
      auth_key: z.string().optional(),
      /**
       * The tag servers join with. A tagged device is no "member" device, so a compromised app on a
       * server cannot use your own-devices rules (e.g. root SSH between all of them) — your policy
       * needs `tagOwners` for it and an SSH rule from autogroup:member to it (see the README).
       * Empty string: join untagged, as a device of the key's owner (not recommended).
       */
      tag: z.string().regex(/^(tag:[\w-]+)?$/, "tag:<name> or empty").default("tag:server"),
      /**
       * Machines at home (not on the internet): tagged tag:home, they may reach everything in the
       * tailnet and SSH to the servers (e.g. a box running coding agents). `fornax tailnet sync`.
       */
      home: z.array(z.string().regex(/^[\w.-]+$/, "a machine name")).default([]),
      /**
       * Your own devices SSH into servers and home machines only after a fresh Tailscale login within
       * this period ("12h", "1h", "always") — someone at your unlocked laptop still needs your login
       * and its second factor. "off": no check. Home machines (agents) are never asked.
       */
      ssh_check: z.string().regex(/^(off|always|\d+[mh])$/, "12h, 1h, 30m, always or off").default("12h"),
      /**
       * Tailscale SSH on the servers (true) or plain sshd reached through the tailnet (false — needed
       * for ssh.security_key: only sshd checks your hardware key; Tailscale SSH trusts the device).
       */
      ssh_server: z.boolean().default(true),
      /**
       * Internet-facing servers reach nothing in the tailnet but its DNS servers — except what is
       * listed here, e.g. { from: web-1, to: gpu-box, ports: [8000], why: OCR }.
       */
      allow: z
        .array(
          z.strictObject({
            /**
             * The machine that may connect: a machine name in the tailnet (first label of its
             * MagicDNS name) or a tag such as tag:server. `fornax tailnet sync` fails on a machine it
             * cannot find.
             */
            from: z.string().regex(/^[\w.:-]+$/, "a machine name or tag"),
            /** The machine it may reach: a machine name in the tailnet or a tag. */
            to: z.string().regex(/^[\w.:-]+$/, "a machine name or tag"),
            /** Ports on `to` that `from` may reach, e.g. [8000]. */
            ports: z.array(z.number().int().min(1).max(65535)).min(1),
            /** Why the rule exists. It is for the reader of fornax.yaml and is not written into the tailnet policy. */
            why: Line,
          }),
        )
        .default([]),
    })
    .optional(),
  /** 1Password: where fornax keeps the secrets it generates (DB passwords, restic, redis …). */
  onepassword: z
    .strictObject({
      /**
       * The vault fornax writes its generated secrets to, one item per server ("fornax <fleet>
       * <server>"). `fornax secrets setup` sets it (default fornax-<fleet>). With service_account,
       * op:// references to other vaults go through the 1Password app.
       */
      vault: z.string(),
      /**
       * 1Password account for the op CLI (`op --account`) when you are signed in to more than one. Not
       * used for calls made with service_account.
       */
      account: z.string().optional(),
      /** Copy new secrets into 1Password after every apply (default on). */
      auto_sync: z.boolean().default(true),
      /**
       * Secret reference to a 1Password service account token (e.g. keychain:fornax-1password).
       * With it, fornax talks to 1Password without the desktop app — no Touch ID prompts.
       */
      service_account: z.string().optional(),
      /** Warn this many days before a credential fornax uses expires (the expiry date on its item). */
      warn_expiry_days: z.number().int().min(0).default(14),
    })
    .optional(),
  /** Nightly backups with restic to a Hetzner Storage Box. */
  backup: z
    .strictObject({
      /**
       * The Hetzner Storage Box the restic repositories live on, reached over SFTP. Each server logs
       * in with a key of its own.
       */
      storage_box: z.strictObject({
        /** Host name of the box, e.g. u123456.your-storagebox.de. */
        host: Hostname,
        /** Login of the box, e.g. u123456 (or a sub-account). */
        user: Name,
        /** SSH port of the box (Hetzner Storage Boxes: 23). */
        port: z.number().int().default(23),
        /** Secret reference; lets fornax install each server's key on the box by itself. */
        password: z.string().optional(),
        /** Base directory on the box; each server gets <path>/<fleet>/<server>. */
        path: InsidePath.default("fornax"),
      }),
      /** Daily start time, UTC. */
      at: z.string().regex(/^\d\d:\d\d$/).default("03:15"),
      /** Which snapshots restic keeps for each site after a backup (restic forget --prune). */
      keep: z
        .strictObject({
          /** Number of daily snapshots to keep. */
          daily: z.number().int().min(1).default(7),
          /** Number of weekly snapshots to keep. */
          weekly: z.number().int().min(0).default(4),
          /** Number of monthly snapshots to keep. */
          monthly: z.number().int().min(0).default(6),
        })
        .default({ daily: 7, weekly: 4, monthly: 6 }),
      /** Pinged after a successful run, "<url>/fail" after a failed one (healthchecks.io style). Plain URL or secret reference. */
      heartbeat: z.string().optional(),
    })
    .optional(),
  /** Secret references per provider type, e.g. { "hetzner-cloud": "op://Infra/Hetzner/token" }. */
  provider_credentials: z.record(z.string(), z.string()).default({}),
  /**
   * An encrypted copy of this fleet repo on the servers (fleet-copy.ts): after every apply the server
   * gets the repo — history included, .fornax/ left out — encrypted to these age recipients and
   * signed with ssh.key. Servers cannot read it; `fornax fleet restore` brings it back with any one
   * of the identities (e.g. a FIDO2 key through age-plugin-fido2-hmac, plus a paper key for emergencies).
   */
  fleet_copy: z
    .strictObject({
      /** age public keys (age1…) the copy is encrypted to; any one of their identities decrypts it. */
      recipients: z.array(z.string().regex(/^age1[a-z0-9]+$/, "an age recipient (age1…)")).min(1),
    })
    .optional(),
  /**
   * "auto" (default): deploy, rollback, backup and notify commands first bring fornax on the server
   * to this build when the server's is older. "manual": only `apply` updates it.
   */
  server_binary: z.enum(["auto", "manual"]).default("auto"),
  /** Where deploy results go. With ntfy, failed nightly backups are reported there too. */
  notify: z
    .strictObject({
      /** POSTs a JSON event for every deploy (ntfy, Slack-compatible webhooks, own endpoints). */
      webhook: z.string().optional(),
      /** Set a GitHub commit status; the server needs a token at /etc/fornax/secrets/github-token. */
      github_status: z.boolean().default(false),
      /**
       * Push notification via ntfy (https://ntfy.sh/<topic> or your own server); with `email`,
       * ntfy also sends each message as mail — no mail setup on the servers needed.
       */
      ntfy: z
        .strictObject({
          /** The topic URL messages are POSTed to, e.g. https://ntfy.sh/<topic>. */
          url: z.string().url(),
          /** Address ntfy also mails each message to. If ntfy refuses the mail, the push goes out without it. */
          email: z.string().optional(),
          /** Secret reference of an ntfy access token (ntfy.sh only forwards mail for accounts). */
          token: z.string().optional(),
        })
        .optional(),
      /** "failure" (default): failed and rolled-back deploys only; "always": every deploy. */
      on: z.enum(["failure", "always"]).default("failure"),
    })
    .default({ github_status: false, on: "failure" }),
});

export type FileSpec = z.infer<typeof FileSchema>;
export type Site = z.infer<typeof SiteSchema>;
export type Server = z.infer<typeof ServerSchema>;
export type FleetConfig = z.infer<typeof FleetSchema>;
export type Daemon = z.infer<typeof DaemonSchema>;
