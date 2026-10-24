# Configuration reference

<!-- Generated from src/core/schema.ts by `bun run docs`. Do not edit by hand. -->

A fleet is a git repo: `fornax.yaml` at its top, one `servers/<name>.yaml` per server, and in each server file the server's sites under `sites:`. Every key of all three is listed here, in the order the schema defines them.

Unknown keys are errors, not ignored: a typo fails `fornax plan` instead of silently doing nothing. "required" means required whenever the object around the key is there; "optional" without a default means the key is simply left out. `[]` in a path stands for each entry of a list, `<domain>` and the like for each key of a map.

## Secret references

Fields that take a secret (tokens, passwords, keys) hold a reference to it, never the secret itself. fornax resolves it only when it needs the value:

| Reference | Resolves to |
| --- | --- |
| `op://Vault/Item/field` | a 1Password field, through the 1Password CLI or the fleet's service account |
| `env:NAME` | the environment variable `NAME` |
| `file:path` | the contents of a file; a relative path is relative to the fleet dir |
| `keychain:service` | a macOS Keychain generic password (`keychain:service/account` names the account too) |

See [Secrets](secrets.md) for the fleet's own 1Password vault.

## Config version

`fornax.yaml` carries `version:`, the version of the config format; `fornax init` writes the current one, 2. Server files have no version of their own: they follow `fornax.yaml`. A fleet with an older version still loads — upgraded in memory, with a note on stderr — and `fornax fleet upgrade` writes the upgrade into the fleet repo (comments and layout kept; review it with `git diff`). A version newer than the running fornax is refused.

## `fornax.yaml`

The fleet: settings for all of its servers.

### `version`

whole number, at least 1 · optional

Config version (see core/config-version.ts); written by `fornax init` and `fornax fleet upgrade`.

### `fleet`

string · required

### `preview_domain`

string (a lower-case host name) · optional

A domain of yours whose subdomains reach the fleet's servers (a wildcard record, or `fornax dns sync`): `--preview` hands out names from it, two words like quiet-harbor.&lt;preview_domain> — for sites without a domain of their own yet, or instead of a provider's throwaway domains.

### `access`

one of `"ssh"`, `"tailscale"` · default `"ssh"`

### `admin_user`

string matching `^[a-z_][a-z0-9_-]{0,31}$` · optional

Linux admin user on servers fornax sets up (default "fornax"; servers from before the rename keep "anvil").

### `ssh`

object · optional

### `ssh.user`

string · default `"root"`

### `ssh.port`

whole number · default `22`

### `ssh.identity_file`

string · optional

### `ssh.key`

string · optional

The fleet's SSH key as a secret reference (`fornax secrets setup` makes one in the fleet's 1Password vault). Held in an ssh-agent of fornax's own, never written to disk; new servers are ordered with it. Takes the place of identity_file.

### `ssh.known_hosts_file`

string · optional

### `ssh.config_file`

string · optional

"none" ignores ~/.ssh/config (reproducible test setups).

### `ssh.authorized_keys`

list of strings · default `[]`

Public keys that may log in as root (added, never removed).

### `ssh.security_key`

string · optional

A hardware key (FIDO2, e.g. a YubiKey: `ssh-keygen -t ed25519-sk -O resident -O verify-required`) fornax logs in with: its key handle file here. Every connection needs the key touched (and its PIN, asked in a dialog); fornax keeps one connection per server open for 10 minutes, so that is once per run. Someone at your unlocked laptop gets nowhere without it.

### `ssh.keep_open`

string (a duration like "10m", "1h" or seconds) · default `"10m"`

How long a connection made with security_key stays open for the next command (OpenSSH ControlPersist: "10m", "1h", seconds). Longer means fewer touches — and longer that anything running as you on this machine can use it without one.

### `ssh.root_keys`

list of strings (an OpenSSH public key line) · optional

Exactly these public keys may log in as root — /root/.ssh/authorized_keys is written from them, anything else in it is removed (set this to your security key's public key). Without root_keys, authorized_keys above only adds. Options may come first: `verify-required sk-ssh-ed25519@openssh.com AAAA…` makes sshd itself insist on the key's PIN.

### `ssh.sudo_password`

string · optional

For a non-root user: secret reference of its sudo password (omit for passwordless sudo).

### `ssh.options`

map of `<option>` to strings (a single line) · default `{}`

### `policies`

object · optional

### `policies.allowed_repo_owners`

list of strings · optional

### `policies.protected`

list of strings · default `[]`

### `policies.maintenance_window`

string matching `^\d\d:\d\d-\d\d:\d\d$` · optional

UTC window "HH:MM-HH:MM" for server changes (apply, bootstrap, provision). App deploys and rollbacks are not restricted: a push to the deploy branch is a deliberate act.

### `tls`

object · optional

### `tls.issuer`

one of `"letsencrypt"`, `"selfsigned"`, `"none"` · default `"letsencrypt"`

### `tls.email`

string · optional

### `tls.acme_server`

string · optional

ACME directory; defaults to Let's Encrypt production.

### `tls.ca_bundle`

string · optional

CA bundle on the server to trust the ACME server (test CAs like Pebble).

### `dns`

object · optional

### `dns.type`

string · required

### `dns.credentials`

string · required

### `dns.zones`

list of strings · default `[]`

### `tailscale`

object · optional

With access "tailscale": how new servers get into the tailnet (one of the two is needed for `server create`).

### `tailscale.api_token`

string · optional

Secret reference to a Tailscale API access token: fornax then makes a single-use auth key per new server, turns off key expiry for servers, renames and removes their devices.

### `tailscale.auth_key`

string · optional

Without an API token: a reusable auth key that tags the server with `tag` (make it so in the Tailscale admin). It never reaches the server's disk or its cloud metadata.

### `tailscale.tag`

string (tag:&lt;name> or empty) · default `"tag:server"`

The tag servers join with. A tagged device is no "member" device, so a compromised app on a server cannot use your own-devices rules (e.g. root SSH between all of them) — your policy needs `tagOwners` for it and an SSH rule from autogroup:member to it (see the README). Empty string: join untagged, as a device of the key's owner (not recommended).

### `tailscale.home`

list of strings (a machine name) · default `[]`

Machines at home (not on the internet): tagged tag:home, they may reach everything in the tailnet and SSH to the servers (e.g. a box running coding agents). `fornax tailnet sync`.

### `tailscale.ssh_check`

string (12h, 1h, 30m, always or off) · default `"12h"`

Your own devices SSH into servers and home machines only after a fresh Tailscale login within this period ("12h", "1h", "always") — someone at your unlocked laptop still needs your login and its second factor. "off": no check. Home machines (agents) are never asked.

### `tailscale.ssh_server`

boolean · default `true`

Tailscale SSH on the servers (true) or plain sshd reached through the tailnet (false — needed for ssh.security_key: only sshd checks your hardware key; Tailscale SSH trusts the device).

### `tailscale.allow`

list of objects · default `[]`

Internet-facing servers reach nothing in the tailnet but its DNS servers — except what is listed here, e.g. { from: web-1, to: gpu-box, ports: [8000], why: OCR }.

### `tailscale.allow[].from`

string (a machine name or tag) · required

### `tailscale.allow[].to`

string (a machine name or tag) · required

### `tailscale.allow[].ports`

list of whole numbers from 1 to 65535, at least 1 entry · required

### `tailscale.allow[].why`

string (a single line) · required

### `onepassword`

object · optional

1Password: where fornax keeps the secrets it generates (DB passwords, restic, redis …).

### `onepassword.vault`

string · required

### `onepassword.account`

string · optional

### `onepassword.auto_sync`

boolean · default `true`

Copy new secrets into 1Password after every apply (default on).

### `onepassword.service_account`

string · optional

Secret reference to a 1Password service account token (e.g. keychain:fornax-1password). With it, fornax talks to 1Password without the desktop app — no Touch ID prompts.

### `onepassword.warn_expiry_days`

whole number, at least 0 · default `14`

Warn this many days before a credential fornax uses expires (the expiry date on its item).

### `backup`

object · optional

Nightly backups with restic to a Hetzner Storage Box.

### `backup.storage_box`

object · required

### `backup.storage_box.host`

string (a lower-case host name) · required

### `backup.storage_box.user`

string (letters, digits and . - _ only) · required

### `backup.storage_box.port`

whole number · default `23`

### `backup.storage_box.password`

string · optional

Secret reference; lets fornax install each server's key on the box by itself.

### `backup.storage_box.path`

string (letters, digits and . / ~ @ + - _ only; a path inside the site directory (relative, no ..)) · default `"fornax"`

Base directory on the box; each server gets &lt;path>/&lt;fleet>/&lt;server>.

### `backup.at`

string matching `^\d\d:\d\d$` · default `"03:15"`

Daily start time, UTC.

### `backup.keep`

object · optional

### `backup.keep.daily`

whole number, at least 1 · default `7`

### `backup.keep.weekly`

whole number, at least 0 · default `4`

### `backup.keep.monthly`

whole number, at least 0 · default `6`

### `backup.heartbeat`

string · optional

Pinged after a successful run, "&lt;url>/fail" after a failed one (healthchecks.io style). Plain URL or secret reference.

### `provider_credentials`

map of `<provider>` to strings · default `{}`

Secret references per provider type, e.g. { "hetzner-cloud": "op://Infra/Hetzner/token" }.

### `fleet_copy`

object · optional

An encrypted copy of this fleet repo on the servers (fleet-copy.ts): after every apply the server gets the repo — history included, .fornax/ left out — encrypted to these age recipients and signed with ssh.key. Servers cannot read it; `fornax fleet restore` brings it back with any one of the identities (e.g. a FIDO2 key through age-plugin-fido2-hmac, plus a paper key for emergencies).

### `fleet_copy.recipients`

list of strings (an age recipient (age1…)), at least 1 entry · required

### `server_binary`

one of `"auto"`, `"manual"` · default `"auto"`

"auto" (default): deploy, rollback, backup and notify commands first bring fornax on the server to this build when the server's is older. "manual": only `apply` updates it.

### `notify`

object · optional

### `notify.webhook`

string · optional

POSTs a JSON event for every deploy (ntfy, Slack-compatible webhooks, own endpoints).

### `notify.github_status`

boolean · default `false`

Set a GitHub commit status; the server needs a token at /etc/fornax/secrets/github-token.

### `notify.ntfy`

object · optional

Push notification via ntfy (https://ntfy.sh/&lt;topic> or your own server); with `email`, ntfy also sends each message as mail — no mail setup on the servers needed.

### `notify.ntfy.url`

URL · required

### `notify.ntfy.email`

string · optional

### `notify.ntfy.token`

string · optional

Secret reference of an ntfy access token (ntfy.sh only forwards mail for accounts).

### `notify.on`

one of `"failure"`, `"always"` · default `"failure"`

"failure" (default): failed and rolled-back deploys only; "always": every deploy.

## `servers/<name>.yaml`

One server; the file name is the server's name.

### `server`

string matching `^[a-z0-9][a-z0-9-]*$` · required

### `former_names`

list of strings matching `^[a-z0-9][a-z0-9-]*$` · default `[]`

Names the server had before (`fornax server rename`): backups made under them stay listed and restorable.

### `host`

string (a host name or IP address) · required

### `provider`

object · optional

### `provider.type`

string · default `"manual"`

### `provider.id`

string or number · optional

### `provider.credentials`

string · optional

### `arch`

one of `"arm64"`, `"x86_64"` · optional

### `public_ipv4`

string · optional

Public addresses (for DNS); `host` may be a private or tailnet name.

### `public_ipv6`

string · optional

### `modules`

list, each one of `"base"`, `"access"`, `"security"`, `"web"`, `"php"`, `"data"` · default `["base", "access", "security", "web", "php", "data"]`

Server-level modules fornax manages. Adopted servers start with [].

### `php`

list of strings matching `^\d\.\d$` · default `["8.4"]`

### `php_default`

string · optional

### `php_extensions`

list of strings (letters, digits and . - _ only) · default `[]`

### `services`

list, each one of `"mysql"`, `"postgres"`, `"redis"`, `"memcached"`, `"supervisor"`, `"crowdsec"`, `"fail2ban"` · default `["mysql", "postgres", "redis", "supervisor", "fail2ban"]`

### `tools`

list, each one of `"composer"`, `"bun"`, `"node"` · default `["composer", "bun"]`

### `timezone`

string (a time zone such as Europe/Berlin) · default `"UTC"`

### `swap`

string matching `^\d+[MG]$` · optional

### `auto_reboot`

string matching `^\d\d:\d\d$` or `false` · default `"02:30"`

Unattended security upgrades reboot at this UTC time; false disables reboots.

### `apt_mirror`

string · optional

### `firewall`

object · optional

### `firewall.allow`

list of objects · default `[]`

### `firewall.allow[].port`

number or string · required

### `firewall.allow[].proto`

one of `"tcp"`, `"udp"` · default `"tcp"`

### `firewall.allow[].from`

string · optional

### `firewall.ssh_from`

list of strings · default `["any"]`

Who may reach port 22 in access mode "ssh".

### `redis`

object · optional

### `redis.password`

boolean · default `true`

### `redis.source`

one of `"distro"`, `"official"` · default `"distro"`

"official": packages.redis.io (newer Redis, what Forge installs) instead of Ubuntu's package.

### `admin_user`

string matching `^[a-z_][a-z0-9_-]{0,31}$` · optional

Linux user nginx runs as; FPM sockets belong to it (adopted Forge servers: "forge").

### `ssh`

object · optional

Overrides the fleet's ssh settings for this server (e.g. a non-root user with sudo).

### `ssh.user`

string · optional

### `ssh.port`

whole number · optional

### `ssh.sudo_password`

string · optional

### `ssh.root_keys`

list of strings (an OpenSSH public key line) · optional

Root keys for this server only, added to the fleet's ssh.root_keys (e.g. a panel that still manages it).

### `backup`

boolean · default `true`

Set to false to switch the fleet's backups off for this server.

### `history`

boolean · default `true`

Keep /etc in git with etckeeper — the server's history of every configuration change (fornax history).

### `webhook`

object · optional

Push-to-deploy reaches each site through its own domain (https://&lt;site>/.well-known/fornax-hook), so a server needs nothing extra. `domain`: an extra hostname for the webhook as well (older setups; sites keep working there until `fornax git connect` moves them). `port`: where the webhook listens on 127.0.0.1.

### `webhook.domain`

string (a lower-case host name) · optional

### `webhook.port`

whole number · default `9300`

### `forge_detach`

object · optional

Set by `fornax detach forge`: Forge's access and leftovers are removed on apply.

### `forge_detach.ufw_ssh_ips`

list of strings · default `[]`

### `packages`

list of strings (an apt package name) · default `[]`

Extra packages to install.

### `files`

list of objects · default `[]`

A file fornax manages verbatim: content inline or from a path relative to the fleet dir.

### `files[].path`

string (starting with `/`) · required

### `files[].source`

string · optional

### `files[].content`

string · optional

### `files[].mode`

string matching `^0?[0-7]{3,4}$` · default `"0644"`

### `files[].owner`

string · default `"root:root"`

### `files[].handler`

string · default `"auto"`

What to reload after a change. "auto" derives it from the path.

### `sites`

map of `<domain>` to site entries · default `{}`

The server's sites, by domain: see [Site entries](#site-entries).

### `notes`

string · optional

## Site entries

Each key under `sites:` in a server file is a site's domain; its value is the site.

### `sites.<domain>.repo`

string (owner/name or a git URL; must not start with -) · optional

owner/name on GitHub or a git URL (never starting with "-": git would read an option).

### `sites.<domain>.branch`

string (a git branch name) · default `"main"`

### `sites.<domain>.user`

string matching `^[a-z_][a-z0-9_-]{0,31}$` · optional

### `sites.<domain>.aliases`

list of strings (a lower-case host name) · default `[]`

### `sites.<domain>.proxies`

list of objects · default `[]`

Extra names that proxy to a local port instead of serving the app (e.g. a Reverb websocket server on ws.&lt;domain>). Covered by the site's certificate; cert/key only for tls "existing".

### `sites.<domain>.proxies[].domain`

string (a lower-case host name) · required

### `sites.<domain>.proxies[].port`

whole number from 1 to 65535 · required

### `sites.<domain>.proxies[].websocket`

boolean · default `true`

### `sites.<domain>.proxies[].cert`

string · optional

### `sites.<domain>.proxies[].key`

string · optional

### `sites.<domain>.php`

string · optional

### `sites.<domain>.preset`

one of `"laravel"`, `"php"`, `"static"` · default `"laravel"`

### `sites.<domain>.web_dir`

string (letters, digits and . / ~ @ + - _ only; a path inside the site directory (relative, no ..)) · optional

Document root relative to the release.

### `sites.<domain>.shared`

list of strings (letters, digits and . / ~ @ + - _ only; a path inside the site directory (relative, no ..)) · optional

### `sites.<domain>.composer_auth`

string · optional

Secret reference of composer's auth.json (private package repos, e.g. Flux Pro, Nova, Spark).

### `sites.<domain>.db`

object · optional

### `sites.<domain>.db.engine`

one of `"mysql"`, `"postgres"` · required

### `sites.<domain>.db.name`

string matching `^[a-z_][a-z0-9_]*$` · optional

### `sites.<domain>.db.user`

string matching `^[a-z_][a-z0-9_]*$` · optional

### `sites.<domain>.db.extensions`

list of strings (an extension name) · default `[]`

### `sites.<domain>.db.manage`

boolean · default `true`

false: the database exists already (e.g. made by Forge) and stays the app's — fornax only backs it up: no create, no password, no drop on --purge.

### `sites.<domain>.redis`

object · optional

Redis for the site. "own" (default; adopted sites: "shared"): a Redis server only this site can reach — a unix socket in a directory of the site user, so no other site reads its cache, sessions or queues. "shared": the server's Redis on 127.0.0.1:6379 (all sites, one password). "none": the site uses no Redis (cache, queue and sessions in the database or files).

### `sites.<domain>.redis.instance`

one of `"own"`, `"shared"`, `"none"` · optional

### `sites.<domain>.redis.maxmemory`

string (a size such as 256mb) · default `"256mb"`

Memory limit of an own instance; keys with an expiry (cache, sessions) give way first, queues never.

### `sites.<domain>.schedule`

boolean · default `false`

### `sites.<domain>.daemons`

list of objects · default `[]`

### `sites.<domain>.daemons[].name`

string matching `^[a-z0-9-]+$` · optional

### `sites.<domain>.daemons[].cmd`

string (a single line) · required

### `sites.<domain>.daemons[].processes`

whole number, at least 1 · default `1`

### `sites.<domain>.daemons[].stopwait`

whole number, at least 1 · default `60`

### `sites.<domain>.daemons[].directory`

string (letters, digits and . / ~ @ + - _ only) · optional

Relative to the current release unless absolute.

### `sites.<domain>.daemons[].program`

string (letters, digits and . - _ only) · optional

Supervisor program name, when it is not fornax's own (adopted Forge daemons: daemon-&lt;id>).

### `sites.<domain>.cron`

list of objects · default `[]`

### `sites.<domain>.cron[].at`

string (five cron fields or @daily etc.) · required

### `sites.<domain>.cron[].cmd`

string (a single line) · required

### `sites.<domain>.tls`

object · optional

### `sites.<domain>.tls.issuer`

one of `"letsencrypt"`, `"selfsigned"`, `"existing"`, `"none"` · optional

### `sites.<domain>.tls.cert`

string · optional

### `sites.<domain>.tls.key`

string · optional

### `sites.<domain>.www_redirect`

boolean · default `false`

### `sites.<domain>.redirects`

list of strings (a lower-case host name) · default `[]`

Names that only send visitors on to the site's domain (301, path kept) — e.g. another TLD of the brand. In the certificate.

### `sites.<domain>.health_check`

string (a URL path such as /up) · optional

### `sites.<domain>.deploy`

object · optional

### `sites.<domain>.deploy.enabled`

boolean · default `true`

### `sites.<domain>.deploy.script`

string (letters, digits and . / ~ @ + - _ only; a path inside the site directory (relative, no ..)) · default `".fornax/deploy.sh"`

### `sites.<domain>.deploy.mode`

one of `"releases"`, `"in_place"` · default `"releases"`

"in_place": pull and build in the site directory itself, as Forge does without zero-downtime deploys — no releases/, no atomic switch, rollback rebuilds an older commit.

### `sites.<domain>.deploy.commands`

string · optional

Build commands (bash) for repos without a deploy script, e.g. taken over from Forge.

### `sites.<domain>.deploy.keep_releases`

whole number, at least 2 · default `5`

How many releases stay on the server (for rollbacks).

### `sites.<domain>.generate`

object · optional

Turn off generated files when they are adopted verbatim via `files`.

### `sites.<domain>.generate.vhost`

boolean · default `true`

### `sites.<domain>.generate.pool`

boolean · default `true`

### `sites.<domain>.generate.daemons`

boolean · default `true`

### `sites.<domain>.generate.cron`

boolean · default `true`

### `sites.<domain>.generate.logrotate`

boolean · default `true`

### `sites.<domain>.nginx`

object · optional

### `sites.<domain>.nginx.server`

list of strings · default `[]`

Snippet files (relative to the fleet dir) included inside the server block.

### `sites.<domain>.nginx.http`

list of strings · default `[]`

Snippet files included at http level, before the server block.

### `sites.<domain>.nginx.client_max_body_size`

string (a size such as 64M) · optional

### `sites.<domain>.files`

list of objects · default `[]`

A file fornax manages verbatim: content inline or from a path relative to the fleet dir.

### `sites.<domain>.files[].path`

string (starting with `/`) · required

### `sites.<domain>.files[].source`

string · optional

### `sites.<domain>.files[].content`

string · optional

### `sites.<domain>.files[].mode`

string matching `^0?[0-7]{3,4}$` · default `"0644"`

### `sites.<domain>.files[].owner`

string · default `"root:root"`

### `sites.<domain>.files[].handler`

string · default `"auto"`

What to reload after a change. "auto" derives it from the path.

### `sites.<domain>.retire`

list of strings (starting with `/`) · default `[]`

Files fornax removes from the server (e.g. Forge's configs after a site was converted).

### `sites.<domain>.pool`

object · optional

PHP-FPM pool sizing.

### `sites.<domain>.pool.max_children`

whole number, at least 1 · default `10`

### `sites.<domain>.pool.start_servers`

whole number, at least 1 · default `2`

### `sites.<domain>.pool.min_spare_servers`

whole number, at least 1 · default `1`

### `sites.<domain>.pool.max_spare_servers`

whole number, at least 1 · default `3`

### `sites.<domain>.pool.max_requests`

whole number, at least 0 · default `1000`

### `sites.<domain>.pool.request_terminate_timeout`

whole number, at least 0 · default `120`

### `sites.<domain>.origin`

object · optional

Where an adopted site came from (filled by `fornax import forge`, used by `fornax site convert`).

### `sites.<domain>.origin.tool`

`"forge"` · required

### `sites.<domain>.origin.site_id`

string · required

### `sites.<domain>.origin.domain_ids`

list of strings · default `[]`

### `sites.<domain>.origin.zero_downtime`

boolean · default `true`

### `sites.<domain>.origin.cron`

list of objects · default `[]`

### `sites.<domain>.origin.cron[].at`

string (a single line) · required

### `sites.<domain>.origin.cron[].cmd`

string (a single line) · required

### `sites.<domain>.backup`

object · optional

Nightly backup of this site: database dump, shared paths and .env (plus extra paths).

### `sites.<domain>.backup.enabled`

boolean · default `true`

### `sites.<domain>.backup.paths`

list of strings · default `[]`

Extra absolute paths or paths relative to the site root.

### `sites.<domain>.notes`

string · optional

### `sites.<domain>.adopted`

boolean · default `false`

Taken over from another tool (e.g. Forge): fornax manages only the listed `files` byte for byte, plus deploy config once deploy.enabled is switched on.

### `sites.<domain>.state`

one of `"present"`, `"absent"` · default `"present"`

### `sites.<domain>.purge`

boolean · default `false`

With state: absent, also delete the Linux user, home directory and database.
