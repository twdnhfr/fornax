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
    path: z.string().startsWith("/"),
    source: z.string().optional(),
    content: z.string().optional(),
    mode: z.string().regex(/^0?[0-7]{3,4}$/).default("0644"),
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
  name: z.string().regex(/^[a-z0-9-]+$/).optional(),
  cmd: Line,
  processes: z.number().int().min(1).default(1),
  stopwait: z.number().int().min(1).default(60),
  /** Relative to the current release unless absolute. */
  directory: PlainPath.optional(),
  /** Supervisor program name, when it is not fornax's own (adopted Forge daemons: daemon-<id>). */
  program: Name.optional(),
});

/** Five cron fields or an @keyword; the command is one line. */
const CronAt = z.string().regex(/^(@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)|[\w*,/-]+( +[\w*,/-]+){4})$/, "five cron fields or @daily etc.");

export const CronSchema = z.strictObject({
  at: CronAt,
  cmd: Line,
});

export const SiteSchema = z.strictObject({
  /** owner/name on GitHub or a git URL (never starting with "-": git would read an option). */
  repo: z.string().regex(/^[\w@:/.~+-]+$/, "owner/name or a git URL").refine((r) => !r.startsWith("-"), "must not start with -").optional(),
  branch: z.string().regex(/^[\w./+-]+$/, "a git branch name").refine((b) => !b.startsWith("-") && !b.includes(".."), "a git branch name").default("main"),
  user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).optional(),
  aliases: z.array(SiteName).default([]),
  /**
   * Extra names that proxy to a local port instead of serving the app (e.g. a Reverb websocket
   * server on ws.<domain>). Covered by the site's certificate; cert/key only for tls "existing".
   */
  proxies: z
    .array(
      z.strictObject({
        domain: SiteName,
        port: z.number().int().min(1).max(65535),
        websocket: z.boolean().default(true),
        cert: z.string().optional(),
        key: z.string().optional(),
      }),
    )
    .default([]),
  php: z.string().optional(),
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
      start: z
        .string()
        .regex(/^[\w ./=:@+,-]+$/, "a plain command: letters, digits, spaces and . / = : @ + , - _ only")
        .refine((c) => c.trim() !== "" && !c.trim().startsWith("-"), "a command"),
      port: z.number().int().min(1024).max(65534).optional(),
    })
    .optional(),
  /** Document root relative to the release. */
  web_dir: InsidePath.optional(),
  shared: z.array(InsidePath).optional(),
  /** Secret reference of composer's auth.json (private package repos, e.g. Flux Pro, Nova, Spark). */
  composer_auth: z.string().optional(),
  db: z
    .strictObject({
      engine: z.enum(["mysql", "postgres"]),
      name: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional(),
      user: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional(),
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
      instance: z.enum(["own", "shared", "none"]).optional(),
      /** Memory limit of an own instance; keys with an expiry (cache, sessions) give way first, queues never. */
      maxmemory: z.string().regex(/^\d+(kb|mb|gb)$/i, "a size such as 256mb").default("256mb"),
    })
    .default({ maxmemory: "256mb" }),
  schedule: z.boolean().default(false),
  daemons: z.array(DaemonSchema).default([]),
  cron: z.array(CronSchema).default([]),
  tls: z
    .strictObject({
      issuer: z.enum(["letsencrypt", "selfsigned", "existing", "none"]).optional(),
      cert: z.string().optional(),
      key: z.string().optional(),
    })
    .default({}),
  www_redirect: z.boolean().default(false),
  /** Names that only send visitors on to the site's domain (301, path kept) — e.g. another TLD of the brand. In the certificate. */
  redirects: z.array(SiteName).default([]),
  /** Path a new release must answer (2xx/3xx) before and after it goes live; preset node checks "/" without it. */
  health_check: z.string().regex(/^\/?[\w./~@+%=&?-]*$/, "a URL path such as /up").optional(),
  deploy: z
    .strictObject({
      enabled: z.boolean().default(true),
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
      vhost: z.boolean().default(true),
      pool: z.boolean().default(true),
      daemons: z.boolean().default(true),
      cron: z.boolean().default(true),
      logrotate: z.boolean().default(true),
    })
    .default({ vhost: true, pool: true, daemons: true, cron: true, logrotate: true }),
  nginx: z
    .strictObject({
      /** Snippet files (relative to the fleet dir) included inside the server block. */
      server: z.array(z.string()).default([]),
      /** Snippet files included at http level, before the server block. */
      http: z.array(z.string()).default([]),
      client_max_body_size: z.string().regex(/^\d+[kKmMgG]?$/, "a size such as 64M").optional(),
    })
    .default({ server: [], http: [] }),
  files: z.array(FileSchema).default([]),
  /** Files fornax removes from the server (e.g. Forge's configs after a site was converted). */
  retire: z.array(z.string().startsWith("/")).default([]),
  /** PHP-FPM pool sizing. */
  pool: z
    .strictObject({
      max_children: z.number().int().min(1).default(10),
      start_servers: z.number().int().min(1).default(2),
      min_spare_servers: z.number().int().min(1).default(1),
      max_spare_servers: z.number().int().min(1).default(3),
      max_requests: z.number().int().min(0).default(1000),
      request_terminate_timeout: z.number().int().min(0).default(120),
    })
    .default({ max_children: 10, start_servers: 2, min_spare_servers: 1, max_spare_servers: 3, max_requests: 1000, request_terminate_timeout: 120 }),
  /** Where an adopted site came from (filled by `fornax import forge`, used by `fornax site convert`). */
  origin: z
    .strictObject({
      tool: z.literal("forge"),
      site_id: z.string(),
      domain_ids: z.array(z.string()).default([]),
      zero_downtime: z.boolean().default(true),
      cron: z.array(z.strictObject({ at: Line, cmd: Line })).default([]),
    })
    .optional(),
  /** Nightly backup of this site: database dump, shared paths and .env (plus extra paths). */
  backup: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Extra absolute paths or paths relative to the site root. */
      paths: z.array(z.string()).default([]),
    })
    .default({ enabled: true, paths: [] }),
  notes: z.string().optional(),
  /**
   * Taken over from another tool (e.g. Forge): fornax manages only the listed `files`
   * byte for byte, plus deploy config once deploy.enabled is switched on.
   */
  adopted: z.boolean().default(false),
  state: z.enum(["present", "absent"]).default("present"),
  /** With state: absent, also delete the Linux user, home directory and database. */
  purge: z.boolean().default(false),
});

export const MODULES = ["base", "access", "security", "web", "php", "data"] as const;
export const SERVICES = ["mysql", "postgres", "redis", "memcached", "supervisor", "crowdsec", "fail2ban"] as const;
export const TOOLS = ["composer", "bun", "node"] as const;

export const ServerSchema = z.strictObject({
  server: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Names the server had before (`fornax server rename`): backups made under them stay listed and restorable. */
  former_names: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).default([]),
  host: z.string().regex(/^[\w.:-]+$/, "a host name or IP address"),
  provider: z
    .strictObject({
      type: z.string().default("manual"),
      id: z.union([z.string(), z.number()]).optional(),
      credentials: z.string().optional(),
    })
    .default({ type: "manual" }),
  arch: z.enum(["arm64", "x86_64"]).optional(),
  /** Public addresses (for DNS); `host` may be a private or tailnet name. */
  public_ipv4: z.string().optional(),
  public_ipv6: z.string().optional(),
  /** Server-level modules fornax manages. Adopted servers start with []. */
  modules: z.array(z.enum(MODULES)).default([...MODULES]),
  php: z.array(z.string().regex(/^\d\.\d$/)).default(["8.4"]),
  php_default: z.string().optional(),
  php_extensions: z.array(Name).default([]),
  services: z.array(z.enum(SERVICES)).default(["mysql", "postgres", "redis", "supervisor", "fail2ban"]),
  tools: z.array(z.enum(TOOLS)).default(["composer", "bun"]),
  timezone: z.string().regex(/^[\w/+-]+$/, "a time zone such as Europe/Berlin").default("UTC"),
  swap: z.string().regex(/^\d+[MG]$/).optional(),
  /** Unattended security upgrades reboot at this UTC time; false disables reboots. */
  auto_reboot: z.union([z.string().regex(/^\d\d:\d\d$/), z.literal(false)]).default("02:30"),
  apt_mirror: z.string().optional(),
  firewall: z
    .strictObject({
      allow: z
        .array(z.strictObject({ port: z.union([z.number(), z.string()]), proto: z.enum(["tcp", "udp"]).default("tcp"), from: z.string().optional() }))
        .default([]),
      /** Who may reach port 22 in access mode "ssh". */
      ssh_from: z.array(z.string()).default(["any"]),
    })
    .default({ allow: [], ssh_from: ["any"] }),
  redis: z
    .strictObject({
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
      user: z.string().optional(),
      port: z.number().int().optional(),
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
  webhook: z.strictObject({ domain: Hostname.optional(), port: z.number().int().default(9300) }).optional(),
  /** Set by `fornax detach forge`: Forge's access and leftovers are removed on apply. */
  forge_detach: z.strictObject({ ufw_ssh_ips: z.array(z.string()).default([]) }).optional(),
  /** Extra packages to install. */
  packages: z.array(z.string().regex(/^[\w.+:=~-]+$/, "an apt package name")).default([]),
  files: z.array(FileSchema).default([]),
  sites: z.record(Hostname, SiteSchema).default({}),
  notes: z.string().optional(),
});

export const FleetSchema = z.strictObject({
  /** Config version (see core/config-version.ts); written by `fornax init` and `fornax fleet upgrade`. */
  version: z.number().int().min(1).optional(),
  /** The oldest fornax this fleet may be used with, e.g. ">=0.2.0": an older one refuses it (fornax_too_old) instead of acting on parts it does not know. */
  requires: z.string().regex(/^>=\d+\.\d+\.\d+(-[\w.]+)?$/, "a minimum version such as >=0.2.0").optional(),
  fleet: z.string(),
  /**
   * A domain of yours whose subdomains reach the fleet's servers (a wildcard record, or `fornax dns
   * sync`): `--preview` hands out names from it, two words like quiet-harbor.<preview_domain> —
   * for sites without a domain of their own yet, or instead of a provider's throwaway domains.
   */
  preview_domain: SiteName.optional(),
  access: z.enum(["ssh", "tailscale"]).default("ssh"),
  /** Linux admin user on servers fornax sets up (default "fornax"; servers from before the rename keep "anvil"). */
  admin_user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).optional(),
  ssh: z
    .strictObject({
      user: z.string().default("root"),
      port: z.number().int().default(22),
      identity_file: z.string().optional(),
      /**
       * The fleet's SSH key as a secret reference (`fornax secrets setup` makes one in the fleet's
       * 1Password vault). Held in an ssh-agent of fornax's own, never written to disk; new servers
       * are ordered with it. Takes the place of identity_file.
       */
      key: z.string().optional(),
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
      options: z.record(Name, Line).default({}),
    })
    .default({ user: "root", port: 22, authorized_keys: [], options: {}, keep_open: "10m" }),
  policies: z
    .strictObject({
      allowed_repo_owners: z.array(z.string()).optional(),
      protected: z.array(z.string()).default([]),
      /**
       * UTC window "HH:MM-HH:MM" for server changes (apply, bootstrap, provision).
       * App deploys and rollbacks are not restricted: a push to the deploy branch is a deliberate act.
       */
      maintenance_window: z.string().regex(/^\d\d:\d\d-\d\d:\d\d$/).optional(),
    })
    .default({ protected: [] }),
  tls: z
    .strictObject({
      issuer: z.enum(["letsencrypt", "selfsigned", "none"]).default("letsencrypt"),
      email: z.string().optional(),
      /** ACME directory; defaults to Let's Encrypt production. */
      acme_server: z.string().optional(),
      /** CA bundle on the server to trust the ACME server (test CAs like Pebble). */
      ca_bundle: z.string().optional(),
    })
    .default({ issuer: "letsencrypt" }),
  dns: z.strictObject({ type: z.string(), credentials: z.string(), zones: z.array(z.string()).default([]) }).optional(),
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
            from: z.string().regex(/^[\w.:-]+$/, "a machine name or tag"),
            to: z.string().regex(/^[\w.:-]+$/, "a machine name or tag"),
            ports: z.array(z.number().int().min(1).max(65535)).min(1),
            why: Line,
          }),
        )
        .default([]),
    })
    .optional(),
  /** 1Password: where fornax keeps the secrets it generates (DB passwords, restic, redis …). */
  onepassword: z
    .strictObject({
      vault: z.string(),
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
      storage_box: z.strictObject({
        host: Hostname,
        user: Name,
        port: z.number().int().default(23),
        /** Secret reference; lets fornax install each server's key on the box by itself. */
        password: z.string().optional(),
        /** Base directory on the box; each server gets <path>/<fleet>/<server>. */
        path: InsidePath.default("fornax"),
      }),
      /** Daily start time, UTC. */
      at: z.string().regex(/^\d\d:\d\d$/).default("03:15"),
      keep: z
        .strictObject({ daily: z.number().int().min(1).default(7), weekly: z.number().int().min(0).default(4), monthly: z.number().int().min(0).default(6) })
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
    .strictObject({ recipients: z.array(z.string().regex(/^age1[a-z0-9]+$/, "an age recipient (age1…)")).min(1) })
    .optional(),
  /**
   * "auto" (default): deploy, rollback, backup and notify commands first bring fornax on the server
   * to this build when the server's is older. "manual": only `apply` updates it.
   */
  server_binary: z.enum(["auto", "manual"]).default("auto"),
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
          url: z.string().url(),
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
