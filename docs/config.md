# Configuration reference

<!-- Generated from src/core/schema.ts by `bun run docs`. Do not edit by hand. -->

A fleet is a git repo: `fornax.yaml` at its top, one `servers/<name>.yaml` per server, and in each server file the server's sites under `sites:`. Every key of all three is listed here, in the order the schema defines them.

Unknown keys are errors, not ignored: a typo fails `fornax plan` instead of silently doing nothing. "required" means required whenever the object around the key is there; "optional" without a default means the key may be left out. `[]` in a path stands for each entry of a list, `<domain>` and the like for each key of a map.

## Secret references

Fields that take a secret (tokens, passwords, the fleet's SSH key) hold a reference to it, never the secret itself. fornax resolves it only when it needs the value:

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

### `requires`

string (a minimum version such as >=0.2.0) · optional

The oldest fornax this fleet may be used with, e.g. ">=0.2.0": an older one refuses it (fornax_too_old) instead of acting on parts it does not know.

### `fleet`

string · required

Name of the fleet (`fornax init` sets it, default: the directory name). It appears in 1Password item titles ("fornax &lt;fleet> &lt;server>"), in backup paths on the Storage Box (&lt;path>/&lt;fleet>/&lt;server>) and in the default vault name fornax-&lt;fleet>.

### `preview_domain`

string (a lower-case host name; not an IP address (&lt;ip with dashes>.sslip.io is a name for one, e.g. 192-0-2-10.sslip.io)) · optional

A domain of yours whose subdomains reach the fleet's servers (a wildcard record, or `fornax dns sync`): `--preview` hands out names from it, two words like quiet-harbor.&lt;preview_domain> — for sites without a domain of their own yet, or instead of a provider's throwaway domains.

### `access`

one of `"ssh"`, `"tailscale"` · default `"ssh"`

How fornax reaches the servers. "ssh": over SSH on `host`, and ufw opens ssh.port (to firewall.ssh_from). "tailscale": servers join the tailnet (see `tailscale`), and ufw lets SSH in only from the tailnet.

### `admin_user`

string matching `^[a-z_][a-z0-9_-]{0,31}$` · optional

Linux admin user on servers fornax sets up (default "fornax"; servers from before the rename keep "anvil").

### `ssh`

object · optional

How fornax logs in to the servers. A server's own `ssh:` overrides user, port and sudo_password.

### `ssh.user`

string · default `"root"`

The user fornax logs in as. Any user other than root needs sudo: passwordless, or with sudo_password.

### `ssh.port`

whole number · default `22`

SSH port fornax connects to; with access "ssh", ufw keeps it open.

### `ssh.identity_file`

string · optional

Private key file fornax logs in with (only this key, not your agent's). ~/ is your home directory; other relative paths are relative to the fleet repo. Its .pub goes to servers that `server create` orders. Without it (and without key): your ssh-agent and ~/.ssh/config.

### `ssh.key`

string · optional

The fleet's SSH key as a secret reference (`fornax secrets setup` makes one in the fleet's 1Password vault). Held in an ssh-agent of fornax's own, never written to disk; new servers are ordered with it. Takes the place of identity_file.

### `ssh.known_hosts_file`

string · optional

known_hosts file for the servers' host keys (default ~/.ssh/known_hosts; relative paths are relative to the fleet repo). A new host key is accepted on first contact; fornax drops stale entries when it orders or reinstalls a server.

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

Extra OpenSSH options for every connection, passed as `-o Name=value`, e.g. { ServerAliveCountMax: "6" }.

### `policies`

object · optional

Rules fornax checks before it changes anything.

### `policies.allowed_repo_owners`

list of strings · optional

GitHub users or organisations whose repos sites may deploy (the owner in owner/name or a git URL). Adding or changing a site, plan and apply refuse any other repo. Unset: any owner.

### `policies.protected`

list of strings · default `[]`

Site domains and server names fornax refuses to delete (site remove, server destroy, a plan that purges a site) while they are on this list.

### `policies.maintenance_window`

string matching `^\d\d:\d\d-\d\d:\d\d$` · optional

UTC window "HH:MM-HH:MM" for server changes (apply, bootstrap, provision). App deploys and rollbacks are not restricted: a push to the deploy branch is a deliberate act.

### `tls`

object · optional

Certificate defaults for the fleet; a site's own tls.issuer takes precedence.

### `tls.issuer`

one of `"letsencrypt"`, `"selfsigned"`, `"none"` · default `"letsencrypt"`

Certificates for sites without a tls.issuer of their own, and for a webhook domain: "letsencrypt" (certbot, HTTP challenge), "selfsigned" (made on the server) or "none" (plain HTTP).

### `tls.email`

string · optional

Contact address for the ACME account (certbot --email). Without it, fornax registers with no address.

### `tls.acme_server`

string · optional

ACME directory; defaults to Let's Encrypt production.

### `tls.ca_bundle`

string · optional

CA bundle on the server to trust the ACME server (test CAs like Pebble).

### `dns`

object · optional

DNS adapter: `fornax dns sync` points the A/AAAA records of every site name (and webhook domain) at its server's public_ipv4/public_ipv6; `fornax dns status` compares them. Without it, you set the records by hand.

### `dns.type`

string · required

The DNS provider; only "cloudflare" so far (records are created DNS only, not proxied).

### `dns.credentials`

string · required

Secret reference to the provider's API token (Cloudflare: Zone:Read and DNS:Edit on the zones).

### `dns.zones`

list of strings · default `[]`

Zones fornax may use, e.g. [example.com]. When set, names outside them are refused; when empty, the provider is asked for each parent domain of a name.

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

The machine that may connect: a machine name in the tailnet (first label of its MagicDNS name) or a tag such as tag:server. `fornax tailnet sync` fails on a machine it cannot find.

### `tailscale.allow[].to`

string (a machine name or tag) · required

The machine it may reach: a machine name in the tailnet or a tag.

### `tailscale.allow[].ports`

list of whole numbers from 1 to 65535, at least 1 entry · required

Ports on `to` that `from` may reach, e.g. [8000].

### `tailscale.allow[].why`

string (a single line) · required

Why the rule exists. It is for the reader of fornax.yaml and is not written into the tailnet policy.

### `onepassword`

object · optional

1Password: where fornax keeps the secrets it generates (DB passwords, restic, redis …).

### `onepassword.vault`

string · required

The vault fornax writes its generated secrets to, one item per server ("fornax &lt;fleet> &lt;server>"). `fornax secrets setup` sets it (default fornax-&lt;fleet>). With service_account, op:// references to other vaults go through the 1Password app.

### `onepassword.account`

string · optional

1Password account for the op CLI (`op --account`) when you are signed in to more than one. Not used for calls made with service_account.

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

The Hetzner Storage Box the restic repositories live on, reached over SFTP. Each server logs in with a key of its own.

### `backup.storage_box.host`

string (a lower-case host name) · required

Host name of the box, e.g. u123456.your-storagebox.de.

### `backup.storage_box.user`

string (letters, digits and . - _ only) · required

Login of the box, e.g. u123456 (or a sub-account).

### `backup.storage_box.port`

whole number · default `23`

SSH port of the box (Hetzner Storage Boxes: 23).

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

Which snapshots restic keeps for each site after a backup (restic forget --prune).

### `backup.keep.daily`

whole number, at least 1 · default `7`

Number of daily snapshots to keep.

### `backup.keep.weekly`

whole number, at least 0 · default `4`

Number of weekly snapshots to keep.

### `backup.keep.monthly`

whole number, at least 0 · default `6`

Number of monthly snapshots to keep.

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

age public keys (age1…) the copy is encrypted to; any one of their identities decrypts it.

### `server_binary`

one of `"auto"`, `"manual"` · default `"auto"`

"auto" (default): deploy, rollback, backup and notify commands first bring fornax on the server to this build when the server's is older. "manual": only `apply` updates it.

### `notify`

object · optional

Where deploy results go. With ntfy, failed nightly backups are reported there too.

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

The topic URL messages are POSTed to, e.g. https://ntfy.sh/&lt;topic>.

### `notify.ntfy.email`

string · optional

Address ntfy also mails each message to. If ntfy refuses the mail, the push goes out without it.

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

The server's name in commands, backups and the tailnet (its Tailscale hostname); fornax writes changes to servers/&lt;server>.yaml. Change it with `fornax server rename`.

### `former_names`

list of strings matching `^[a-z0-9][a-z0-9-]*$` · default `[]`

Names the server had before (`fornax server rename`): backups made under them stay listed and restorable.

### `host`

string (a host name or IP address) · required

What fornax connects to over SSH: an IP address or a host name (with access "tailscale" usually the tailnet name).

### `provider`

object · optional

Where the server comes from: decides what fornax can do through the provider's API (destroy, rename, snapshot, reinstall, reverse DNS).

### `provider.type`

string · default `"manual"`

"manual" (any server, no API), "hetzner-cloud", "digitalocean" or "netcup" (no API either: order and reinstall in its panel).

### `provider.id`

string or number · optional

The server's ID at the provider; the API commands (destroy, rename, snapshot, reinstall, reverse DNS) need it.

### `provider.credentials`

string · optional

Secret reference of the provider's API token for this server only; default: provider_credentials.&lt;type> in fornax.yaml.

### `arch`

one of `"arm64"`, `"x86_64"` · optional

"arm64" or "x86_64" (set by `fornax server create`). fornax compares it with the live server and stops on a mismatch.

### `public_ipv4`

string · optional

Public addresses (for DNS); `host` may be a private or tailnet name.

### `public_ipv6`

string · optional

Public IPv6 address, for DNS records and reverse DNS.

### `modules`

list, each one of `"base"`, `"access"`, `"security"`, `"web"`, `"php"`, `"data"` · default `["base", "access", "security", "web", "php", "data"]`

Server-level modules fornax manages. Adopted servers start with [].

### `php`

list of strings matching `^\d\.\d$` · default `["8.4"]`

PHP versions installed side by side, each with its own FPM service, e.g. ["8.3", "8.4"]. Where the ondrej/php PPA does not serve the Ubuntu release, only the system's PHP is possible.

### `php_default`

string · optional

PHP version the `php` command points to and sites without their own `php` use; default: the last in `php`.

### `php_extensions`

list of strings (letters, digits and . - _ only) · default `[]`

Extra PHP extensions for every version in `php`, by package suffix (imagick installs php8.4-imagick), on top of fornax's standard set.

### `php_ini`

map of `<name>` to strings (a single value without ; or quotes) · default `{}`

php.ini settings over fornax's defaults (memory_limit 512M, upload_max_filesize and post_max_size 64M, max_execution_time 60, OPcache on), for every PHP version — e.g. { max_execution_time: "0", "opcache.validate_timestamps": "0" }.

### `retire`

list of strings (an absolute path; no ..) · default `[]`

Files fornax removes from the server (taken-over configuration that fornax's own replaces, e.g. a panel's /etc/nginx/conf.d/gzip.conf); kept in the apply's backup.

### `services`

list, each one of `"mysql"`, `"postgres"`, `"redis"`, `"memcached"`, `"supervisor"`, `"crowdsec"`, `"fail2ban"` · default `["mysql", "postgres", "redis", "supervisor", "fail2ban"]`

Services fornax installs and runs: mysql, postgres, redis (the server's own, also needed for sites' own Redis), memcached, supervisor (needed for site daemons), crowdsec and fail2ban (SSH jail).

### `tools`

list, each one of `"composer"`, `"bun"`, `"node"` · default `["composer", "bun"]`

Command-line tools the php module installs: composer and bun in /usr/local/bin, node (Node.js 22 from NodeSource). Preset node needs bun or node, depending on its start command.

### `timezone`

string (a time zone such as Europe/Berlin) · default `"UTC"`

System time zone (/etc/localtime and /etc/timezone), e.g. Europe/Berlin.

### `swap`

string matching `^\d+[MG]$` · optional

Size of a swap file (/swapfile) fornax creates and turns on, e.g. "2G". No swap file without it.

### `auto_reboot`

string matching `^\d\d:\d\d$` or `false` · default `"02:30"`

Unattended security upgrades reboot at this UTC time; false disables reboots.

### `apt_mirror`

string · optional

URL of an Ubuntu package mirror, written to /etc/apt/sources.list.d/ubuntu.sources in place of the default archive.

### `firewall`

object · optional

ufw: incoming traffic is denied except ports 80 and 443, SSH and what is listed here. Rules added by hand are removed on apply.

### `firewall.allow`

list of objects · default `[]`

Extra ufw allow rules: a port (from anywhere, or `from` one address), or everything coming `on` a network interface (e.g. tailscale0), optionally to one port. A port, an interface (on), or both.

### `firewall.allow[].port`

whole number or string (a port or range such as 8000:8010) · optional

A port, or a range such as "6000:6010".

### `firewall.allow[].proto`

one of `"tcp"`, `"udp"` · default `"tcp"`

"tcp" or "udp".

### `firewall.allow[].from`

string (an address or network) · optional

Only from this address or network (e.g. 10.0.0.0/8); without it, from anywhere.

### `firewall.allow[].on`

string (a network interface such as tailscale0) · optional

### `firewall.ssh_from`

list of strings · default `["any"]`

Who may reach port 22 in access mode "ssh".

### `redis`

object · optional

The server's shared Redis (127.0.0.1:6379).

### `redis.password`

boolean · default `true`

Require a password, generated on the server (/etc/fornax/secrets/redis) and written into new Laravel .env files. false: no password.

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

User fornax logs in as on this server; any user but root runs commands through sudo.

### `ssh.port`

whole number · optional

SSH port of this server.

### `ssh.sudo_password`

string · optional

For a non-root user: secret reference of its sudo password (omit for passwordless sudo).

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

Extra hostname for the deploy webhook, with its own vhost and certificate (older setups).

### `webhook.port`

whole number · default `9300`

Port on 127.0.0.1 the webhook listens on. No node app or proxy of a site may use it.

### `forge_detach`

object · optional

Set by `fornax detach forge`: Forge's access and leftovers are removed on apply.

### `forge_detach.ufw_ssh_ips`

list of strings · default `[]`

Addresses whose ufw rules for port 22 (Forge's access) are removed on apply.

### `packages`

list of strings (an apt package name) · default `[]`

Extra packages to install.

### `files`

list of objects · default `[]`

A file fornax manages verbatim: content inline or from a path relative to the fleet dir. A file needs exactly one of source or content.

### `files[].path`

string (starting with `/`) · required

Absolute path of the file on the server.

### `files[].source`

string · optional

File whose content is written, relative to the fleet dir (or absolute).

### `files[].content`

string · optional

The file's content, inline.

### `files[].mode`

string matching `^0?[0-7]{3,4}$` · default `"0644"`

Octal file mode, e.g. "0600".

### `files[].owner`

string · default `"root:root"`

Owner of the file as user:group.

### `files[].handler`

string · default `"auto"`

What to reload after a change. "auto" derives it from the path.

### `sites`

map of `<domain>` to site entries · default `{}`

The server's sites, by domain: see [Site entries](#site-entries).

### `notes`

string · optional

Free text for people; shown by `fornax explain`.

## Site entries

Each key under `sites:` in a server file is a site's domain; its value is the site.

### `sites.<domain>.repo`

string (owner/name or a git URL; must not start with -) · optional

owner/name on GitHub or a git URL (never starting with "-": git would read an option).

### `sites.<domain>.branch`

string (a git branch name) · default `"main"`

Git branch that is deployed; the webhook ignores pushes to other branches.

### `sites.<domain>.user`

string matching `^[a-z_][a-z0-9_-]{0,31}$` · optional

Linux user the site runs as (PHP-FPM pool, daemons, cron, deploys); its files live in /home/&lt;user>/&lt;domain>. Default: the domain's first label (shop.example.com: shop). Each site needs its own.

### `sites.<domain>.aliases`

list of strings (a lower-case host name; not an IP address (&lt;ip with dashes>.sslip.io is a name for one, e.g. 192-0-2-10.sslip.io)) · default `[]`

More names that serve the same app; in the site's vhost and certificate.

### `sites.<domain>.proxies`

list of objects · default `[]`

Extra names that proxy to a local port instead of serving the app (e.g. a Reverb websocket server on ws.&lt;domain>). Covered by the site's certificate; cert/key only for tls "existing".

### `sites.<domain>.proxies[].domain`

string (a lower-case host name; not an IP address (&lt;ip with dashes>.sslip.io is a name for one, e.g. 192-0-2-10.sslip.io)) · required

The name, e.g. ws.example.com.

### `sites.<domain>.proxies[].port`

whole number from 1 to 65535 · required

Local port on 127.0.0.1 that nginx forwards to.

### `sites.<domain>.proxies[].websocket`

boolean · default `true`

Pass websocket upgrades and keep idle connections open for an hour; false for plain HTTP.

### `sites.<domain>.proxies[].cert`

string · optional

With tls.issuer "existing": path of this name's certificate on the server (otherwise the site's is used).

### `sites.<domain>.proxies[].key`

string · optional

With tls.issuer "existing": path of this name's private key on the server.

### `sites.<domain>.php`

string · optional

PHP version of the site, one of the server's `php`; default: the server's php_default.

### `sites.<domain>.preset`

one of `"laravel"`, `"php"`, `"static"`, `"node"` · default `"laravel"`

What kind of app: "laravel" (artisan steps on deploy, .env and storage set up), "php" (PHP-FPM without Laravel steps), "static" (files only, no PHP) or "node" (its own server, see node). Decides the default build, web_dir, shared paths and Redis.

### `sites.<domain>.node`

object · optional

preset node: the app's own server, behind nginx. `start` runs in the release as the site user, with PORT, HOST and HOSTNAME (127.0.0.1) set — e.g. "bun run start" or "node .next/standalone/server.js". A deploy starts the new release on the other of two ports (`port` and port+1; default: derived from the domain, 20000–27999) and switches nginx once it answers.

### `sites.<domain>.node.start`

string (a plain command: letters, digits, spaces and . / = : @ + , - _ only; a command) · required

Command that starts the app, e.g. "bun run start"; plain characters only (it goes into a systemd unit).

### `sites.<domain>.node.port`

whole number from 1024 to 65534 · optional

The first of the app's two ports (it takes port+1 as well); default: derived from the domain.

### `sites.<domain>.web_dir`

string (letters, digits and . / ~ @ + - _ only; a path inside the site directory (relative, no ..)) · optional

Document root relative to the release.

### `sites.<domain>.shared`

list of strings (letters, digits and . / ~ @ + - _ only; a path inside the site directory (relative, no ..)) · optional

Paths kept in the site directory across releases and linked into each one, e.g. uploads. Default: ["storage"] for preset laravel, none otherwise; .env and auth.json are always linked.

### `sites.<domain>.composer_auth`

string · optional

Secret reference of composer's auth.json (private package repos, e.g. Flux Pro, Nova, Spark).

### `sites.<domain>.db`

object · optional

A database for the site on this server: fornax creates it and its user with a generated password (preset laravel: written into a new .env).

### `sites.<domain>.db.engine`

one of `"mysql"`, `"postgres"` · required

"mysql" or "postgres"; the server needs the matching service.

### `sites.<domain>.db.name`

string matching `^[a-z_][a-z0-9_]*$` · optional

Database name; default: the site user with - turned into _.

### `sites.<domain>.db.user`

string matching `^[a-z_][a-z0-9_]*$` · optional

Database user (role); default: the site user with - turned into _.

### `sites.<domain>.db.extensions`

list of strings (an extension name) · default `[]`

PostgreSQL extensions created in the database, e.g. vector (installs pgvector).

### `sites.<domain>.db.manage`

boolean · default `true`

false: the database exists already (e.g. made by Forge) and stays the app's — fornax only backs it up: no create, no password, no drop on --purge.

### `sites.<domain>.redis`

object · optional

Redis for the site. "own" (default for preset laravel; adopted sites: "shared"; php, static and node: "none"): a Redis server only this site can reach — a unix socket in a directory of the site user, so no other site reads its cache, sessions or queues. "shared": the server's Redis on 127.0.0.1:6379 (all sites, one password). "none": the site uses no Redis (cache, queue and sessions in the database or files).

### `sites.<domain>.redis.instance`

one of `"own"`, `"shared"`, `"none"` · optional

"own", "shared" or "none" (see redis); the default depends on the preset. Without redis in the server's services it is always "none".

### `sites.<domain>.redis.maxmemory`

string (a size such as 256mb) · default `"256mb"`

Memory limit of an own instance; keys with an expiry (cache, sessions) give way first, queues never.

### `sites.<domain>.schedule`

boolean · default `false`

Run Laravel's scheduler: a cron line runs `php artisan schedule:run` every minute as the site user in the current release.

### `sites.<domain>.daemons`

list of objects · default `[]`

Long-running processes (queue workers, Horizon, Reverb …) under supervisor, as the site user in the current release; restarted after every deploy. Needs supervisor in the server's services.

### `sites.<domain>.daemons[].name`

string matching `^[a-z0-9-]+$` · optional

Short name in the program name (fornax-&lt;site>-&lt;name>) and its log file; default: from the command (horizon, queue, reverb, ssr, octane, pulse) or d1, d2 …

### `sites.<domain>.daemons[].cmd`

string (a single line) · required

The command supervisor runs, e.g. "php artisan queue:work --tries=3".

### `sites.<domain>.daemons[].processes`

whole number, at least 1 · default `1`

How many copies supervisor runs (numprocs).

### `sites.<domain>.daemons[].stopwait`

whole number, at least 1 · default `60`

Seconds supervisor waits after SIGTERM before it kills the process (stopwaitsecs): time for a running job to finish.

### `sites.<domain>.daemons[].directory`

string (letters, digits and . / ~ @ + - _ only) · optional

Relative to the current release unless absolute.

### `sites.<domain>.daemons[].program`

string (letters, digits and . - _ only) · optional

Supervisor program name, when it is not fornax's own (adopted Forge daemons: daemon-&lt;id>).

### `sites.<domain>.cron`

list of objects · default `[]`

Cron jobs of the site, run as the site user in the current release; output goes to ~/.fornax/cron.log.

### `sites.<domain>.cron[].at`

string (five cron fields or @daily etc.) · required

When: five cron fields ("0 3 * * *") or @daily, @hourly etc.

### `sites.<domain>.cron[].cmd`

string (a single line) · required

The command, run with bash in the current release.

### `sites.<domain>.tls`

object · optional

The site's certificate, covering the domain, aliases, www, redirects and proxies.

### `sites.<domain>.tls.issuer`

one of `"letsencrypt"`, `"selfsigned"`, `"existing"`, `"none"` · optional

"letsencrypt", "selfsigned", "existing" (a certificate fornax does not issue: tls.cert and tls.key) or "none" (HTTP only); default: the fleet's tls.issuer.

### `sites.<domain>.tls.cert`

string · optional

With issuer "existing": path of the certificate (full chain) on the server.

### `sites.<domain>.tls.key`

string · optional

With issuer "existing": path of the private key on the server.

### `sites.<domain>.www_redirect`

boolean · default `false`

Also answer www.&lt;domain> and send it on to &lt;domain> (301); www goes into the certificate.

### `sites.<domain>.redirects`

list of strings (a lower-case host name; not an IP address (&lt;ip with dashes>.sslip.io is a name for one, e.g. 192-0-2-10.sslip.io)) · default `[]`

Names that only send visitors on to the site's domain (301, path kept) — e.g. another TLD of the brand. In the certificate.

### `sites.<domain>.health_check`

string (a URL path such as /up) · optional

Path a new release must answer (2xx/3xx) before and after it goes live; preset node checks "/" without it.

### `sites.<domain>.deploy`

object · optional

How fornax deploys the site from `repo` (`fornax deploy` and on push).

### `sites.<domain>.deploy.enabled`

boolean · default `true`

false: fornax does not deploy the site (no deploy key, webhook or deploy config on the server). Sites imported from Forge start with false.

### `sites.<domain>.deploy.script`

string (letters, digits and . / ~ @ + - _ only; a path inside the site directory (relative, no ..)) · default `".fornax/deploy.sh"`

Build script in the repo, run with bash in the checkout. When the repo has it, it replaces deploy.commands and the preset's own build; it gets FORNAX_SITE, FORNAX_SITE_PATH, FORNAX_RELEASE_PATH, FORNAX_PHP and FORNAX_COMPOSER.

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

The site's nginx vhost.

### `sites.<domain>.generate.pool`

boolean · default `true`

The site's PHP-FPM pool.

### `sites.<domain>.generate.daemons`

boolean · default `true`

The supervisor programs of `daemons`.

### `sites.<domain>.generate.cron`

boolean · default `true`

The /etc/cron.d file for `schedule` and `cron`.

### `sites.<domain>.generate.logrotate`

boolean · default `true`

Log rotation for the site's logs (/etc/logrotate.d).

### `sites.<domain>.nginx`

object · optional

Additions to the site's generated vhost.

### `sites.<domain>.nginx.server`

list of strings · default `[]`

Snippet files (relative to the fleet dir) included inside the server block.

### `sites.<domain>.nginx.http`

list of strings · default `[]`

Snippet files included at http level, before the server block.

### `sites.<domain>.nginx.client_max_body_size`

string (a size such as 64M) · optional

Largest request body nginx accepts for the site, e.g. 256M (fornax's nginx.conf allows 64m).

### `sites.<domain>.files`

list of objects · default `[]`

A file fornax manages verbatim: content inline or from a path relative to the fleet dir. A file needs exactly one of source or content.

### `sites.<domain>.files[].path`

string (starting with `/`) · required

Absolute path of the file on the server.

### `sites.<domain>.files[].source`

string · optional

File whose content is written, relative to the fleet dir (or absolute).

### `sites.<domain>.files[].content`

string · optional

The file's content, inline.

### `sites.<domain>.files[].mode`

string matching `^0?[0-7]{3,4}$` · default `"0644"`

Octal file mode, e.g. "0600".

### `sites.<domain>.files[].owner`

string · default `"root:root"`

Owner of the file as user:group.

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

Most PHP workers at once (pm.max_children): the site's concurrent PHP requests.

### `sites.<domain>.pool.start_servers`

whole number, at least 1 · default `2`

Workers started with the pool (pm.start_servers).

### `sites.<domain>.pool.min_spare_servers`

whole number, at least 1 · default `1`

Fewest idle workers kept (pm.min_spare_servers).

### `sites.<domain>.pool.max_spare_servers`

whole number, at least 1 · default `3`

Most idle workers kept (pm.max_spare_servers).

### `sites.<domain>.pool.max_requests`

whole number, at least 0 · default `1000`

Requests a worker serves before it is replaced (pm.max_requests); 0: never.

### `sites.<domain>.pool.request_terminate_timeout`

whole number, at least 0 · default `120`

Seconds a request may run before PHP-FPM ends it; 0: no limit.

### `sites.<domain>.origin`

object · optional

Where an adopted site came from (filled by `fornax import forge`, used by `fornax site convert`).

### `sites.<domain>.origin.tool`

`"forge"` · required

The tool the site was taken over from: "forge".

### `sites.<domain>.origin.site_id`

string · required

The site's ID in Forge (its logrotate file forge-&lt;id> is retired on convert).

### `sites.<domain>.origin.domain_ids`

list of strings · default `[]`

Forge's IDs of the site's domains: their renewal cron files go when `fornax site convert --only tls` switches the certificate.

### `sites.<domain>.origin.zero_downtime`

boolean · default `true`

Whether Forge deployed with releases; false makes `fornax site convert --only deploy` keep deploying in place.

### `sites.<domain>.origin.cron`

list of objects · default `[]`

The site's scheduled jobs at Forge; `fornax site convert --only cron` moves them into schedule and cron.

### `sites.<domain>.origin.cron[].at`

string (a single line) · required

The schedule as Forge had it.

### `sites.<domain>.origin.cron[].cmd`

string (a single line) · required

The command as Forge had it.

### `sites.<domain>.backup`

object · optional

Nightly backup of this site: database dump, shared paths and .env (plus extra paths).

### `sites.<domain>.backup.enabled`

boolean · default `true`

false: leave the site out of the nightly backup.

### `sites.<domain>.backup.paths`

list of strings · default `[]`

Extra absolute paths or paths relative to the site root.

### `sites.<domain>.notes`

string · optional

Free text for people; shown by `fornax explain` (`fornax import forge` writes what it found).

### `sites.<domain>.adopted`

boolean · default `false`

Taken over from another tool (e.g. Forge): fornax manages only the listed `files` byte for byte, plus deploy config once deploy.enabled is switched on.

### `sites.<domain>.state`

one of `"present"`, `"absent"` · default `"present"`

"absent" removes the site from the server: vhost, pool, cron, daemons, its files and its own Redis. The user, home directory and database stay unless purge is set.

### `sites.<domain>.purge`

boolean · default `false`

With state: absent, also delete the Linux user, home directory and database.
