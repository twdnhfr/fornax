# fornax

**Run your PHP and Laravel servers from a git repo — self-hosted, agent-first, no hosted dashboard.**

fornax sets up Ubuntu servers, puts PHP and Laravel sites on them, deploys on every push, renews certificates and backs everything up. What your servers should look like lives in a few YAML files in a git repo — the *fleet*. fornax compares that with what is really on the servers, shows you the difference as a plan, and applies exactly that plan over SSH.

It is meant for people who run a handful of servers for their own apps or their clients' — the kind of setup Laravel Forge or Ploi are used for — and who want to own it: plain files, no SaaS or hosted dashboard, no daemon on a central box, and a CLI that an AI agent can drive as safely as you can. For a look at the fleet in a browser there is a local dashboard that runs the very same commands.

```yaml
# servers/web-1.yaml
server: web-1
host: web-1.example.com
php: ["8.5"]
sites:
  shop.example.com:
    repo: acme/shop
    db: { engine: postgres }
    schedule: true
    daemons:
      - cmd: php8.5 artisan horizon
    www_redirect: true
```

```console
$ fornax plan web-1
site:shop.example.com:
  ! Linux user shop
  + /etc/php/8.5/fpm/pool.d/fornax-shop-example-com.conf
  ! Let's Encrypt certificate for shop.example.com, www.shop.example.com
  + /etc/nginx/sites-available/shop.example.com
  + /etc/supervisor/conf.d/fornax-shop-example-com-horizon.conf

5 to change, 96 unchanged
plan 3f9c2a1e saved — review, then: fornax apply 3f9c2a1e
```

## Why fornax

- **Your servers, described in files.** The fleet is a git repo: review changes like code, see who wanted what in its history, roll back by reverting. No vendor database that only a web UI can read.
- **Nothing changes that you have not seen.** Every change is a saved plan; `apply` runs exactly that plan and refuses if the server changed in the meantime. A second apply finds nothing to do. Hand edits on a server show up as a difference instead of being silently overwritten — and `fornax history` tells you who made them.
- **Deploys without downtime, with a way back.** Each push builds a new release next to the live one, checks it on a local-only socket before switching, switches atomically, checks again and rolls back by itself if the app does not answer.
- **Secure by default.** One Linux user per site, closed off from the others (own PHP pool, database user and Redis). Root only with a hardware key if you want it. Webhooks signed per site. No public SSH needed with Tailscale.
- **No lock-in.** What fornax writes is ordinary nginx, PHP-FPM, supervisor, cron and certbot configuration. Stop using fornax tomorrow and every server keeps running exactly as it is. Any provider works — fornax only needs root SSH to Ubuntu.
- **Built to be driven by an agent.** Non-interactive, `--json` everywhere, errors that name the command to run next, a permission tier on every command (`read`, `write`, `destroy`) and `fornax agent-context` to learn the whole tool in one call. A skill for Claude Code ships with it.
- **Leave Laravel Forge without moving a site.** `fornax import forge` takes over a Forge server byte for byte — the first plan is empty — then hands one area after the other to fornax, and finally cuts Forge off.
- **Batteries included.** Let's Encrypt, nightly encrypted backups with restore, push-to-deploy, queues and schedulers, per-site Redis, 1Password for every generated credential, ordering servers at Hetzner or DigitalOcean.

## How it works

```
 your machine                                   each server (Ubuntu 24.04 / 26.04)
┌──────────────────────────┐                   ┌──────────────────────────────────────────┐
│ fleet repo   (git, YAML) │                   │ nginx · PHP-FPM · MySQL/Postgres · Redis │
│   fornax.yaml            │  1. probe (SSH)   │ supervisor · cron · certbot · ufw        │
│   servers/web-1.yaml     │ ────────────────▶ │                                          │
│                          │  2. plan (local)  │ /usr/local/bin/fornax  (same binary)     │
│ fornax plan / apply …    │  3. apply (SSH)   │   fornax-hook      ◀── git push (GitHub) │
│                          │ ────────────────▶ │   fornax-deploy@<site>                   │
└──────────────────────────┘                   │   fornax-backup.timer ──▶ restic         │
                                               └──────────────────────────────────────────┘
```

1. **Desired state.** fornax reads the fleet and turns it into *resources*: files with exact content, packages, services, users, certificates, checks.
2. **Probe and plan.** One SSH call collects the current state of all those resources. The difference is the plan — shown to you and saved under an id.
3. **Apply.** The plan runs on the server as one script. nginx, PHP-FPM, sshd and sudoers changes are validated before a reload and rolled back if they are rejected. Every run is logged in `/var/log/fornax/`, and `/etc` is committed to git before and after.
4. **Runtime on the server.** The same binary runs there for what has to happen without you: the push webhook, the deploys it starts, the nightly backups. There is no central fornax service — your machine is only needed to change things.

## Concepts

| | |
| --- | --- |
| **Fleet** | A git repo with `fornax.yaml` (access, TLS, backups, secrets, policies) and one `servers/<name>.yaml` per server. One fleet per team or client. fornax finds it from the current directory upwards, or uses `$FORNAX_FLEET` / `~/.config/fornax/fleet`. |
| **Server** | An Ubuntu machine reached over SSH, directly or through Tailscale. What fornax manages on it comes in *modules*: `base`, `access`, `security`, `web`, `php`, `data`. |
| **Site** | One app on a server: a repo, its own Linux user, a PHP version, a database, daemons, cron, TLS, extra names. Presets `laravel`, `php`, `static` and `node` (Next.js and other apps with their own server, behind nginx) know how to build and serve each kind. |
| **Plan** | The difference between fleet and server, saved with an id. `apply <id>` runs exactly that — after you, or your agent, have read it. |
| **Release** | One deploy of a site: `releases/<time>` next to `current`, with shared `storage/` and `.env`. The layout is Forge's, so taken-over sites keep working. |
| **Secret reference** | Secrets never live in the fleet: `op://vault/item/field`, `env:NAME`, `file:path` or `keychain:service`, resolved only while applying. Credentials fornax creates go to 1Password by themselves. |
| **Adopted** | A site or file taken over from Forge exactly as it is. `fornax site convert` hands it to fornax area by area. |
| **Tier** | Every command is `read`, `write` or `destroy`. Destroying needs `--confirm=<name>`; agents can be allowed the read tier only. |

## Install

Each [release](https://github.com/twdnhfr/fornax/releases) has an archive per machine — `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` — and `SHA256SUMS`. An archive holds `fornax` and the two Linux builds it puts on servers; keep them together:

```bash
v=0.1.0 t=darwin-arm64
curl -fsSLO "https://github.com/twdnhfr/fornax/releases/download/v$v/fornax-$v-$t.tar.gz"
mkdir -p ~/.local/lib/fornax ~/.local/bin && tar -xzf "fornax-$v-$t.tar.gz" -C ~/.local/lib/fornax
ln -sf ~/.local/lib/fornax/fornax ~/.local/bin/fornax   # or any other directory on your PATH
fornax --version
```

A release also carries a Homebrew formula (`fornax.rb`) that installs the same archive. To run fornax from a checkout instead, see [CONTRIBUTING.md](CONTRIBUTING.md#building-and-running-from-source).

## Quickstart

```bash
fornax init ./fleet --fleet-name acme && cd fleet
fornax secrets setup                                     # optional: a 1Password vault for every credential fornax creates
fornax server add web-1 --host 203.0.113.10 --php 8.5   # Ubuntu 24.04/26.04, root SSH
fornax server bootstrap web-1                            # base packages, admin user, SSH hardening, firewall
fornax server provision web-1                            # nginx, PHP, databases, Redis, supervisor …

fornax site add web-1 shop.example.com --repo acme/shop --db postgres --schedule --daemon 'php8.5 artisan horizon'
fornax plan web-1                                        # read it
fornax apply <plan-id>
fornax git connect shop.example.com                      # deploy key + push webhook at GitHub
fornax deploy shop.example.com                           # first deploy; afterwards every push
```

`site add` reads the preset off the repo (artisan → laravel, index.php → php, a start script → node, else static); `fornax site set shop.example.com --preset php` changes it later, like the other settings. No domain yet? `fornax site add web-1 --preview` names the site under the fleet's `preview_domain`, or without one under the server's IP via sslip.io (`quiet-harbor.203-0-113-10.sslip.io`).

Or let fornax order the server: `fornax server create --size cax21 --location nbg1` buys it at Hetzner, joins it to your tailnet and provisions it in one go ([servers](docs/servers.md)).

**Coming from Forge?**

```bash
fornax import forge web-1 --org my-org --server-id 123456   # adopt everything as it is: the first plan is empty
fornax site convert shop.example.com --only cron,logrotate,daemons   # then web, tls, deploy — plan + apply after each
fornax detach forge web-1                                   # Forge's keys and firewall rules go
```

A complete example fleet is in [`examples/fleet/`](examples/fleet/).

## Everyday commands

```bash
fornax health                         # every server and site at a glance
fornax logs shop.example.com laravel  # nginx, access, laravel, daemon, deploy, php, app (node)
fornax run shop.example.com -- php artisan migrate:status   # as the site's user, with its PHP
fornax shell shop.example.com         # interactive, as the site's user
fornax deploy | rollback shop.example.com
fornax backup restore shop.example.com                      # side by side, never over the live data by default
fornax env pull | push shop.example.com
fornax history web-1 --path nginx     # who changed what in /etc, and when
```

## Local dashboard

```bash
fornax ui                             # opens http://127.0.0.1:<port>/?token=… in your browser
```

For humans who would rather click: the fleet at a glance, server status, health, certificates, backups, releases and logs per server and site, and the basic write steps — a new site, its plan, the apply after a confirmation, a deploy. It is a thin layer over the CLI: every button runs the same command in the same process, with the same validation, tiers and errors, and its log streams into the page (including "touch your security key"). Destroying is left to the terminal. It listens on 127.0.0.1 only, answers only a browser holding the random token from the printed link (traded for an HttpOnly, SameSite=Strict cookie), rejects foreign `Host` headers and cross-site requests, loads nothing from the internet, and stops after 30 minutes without requests. Agents keep using the CLI. More in [docs/ui.md](docs/ui.md).

## Documentation

| | |
| --- | --- |
| [Configuration](docs/config.md) | every key of `fornax.yaml`, the server files and sites: type, default, meaning |
| [Deploys](docs/deploys.md) | releases, build, health checks, rollback, push-to-deploy |
| [Servers](docs/servers.md) | ordering, renaming and destroying servers; Tailscale |
| [Backups](docs/backups.md) | restic to a Hetzner Storage Box, restore |
| [Secrets](docs/secrets.md) | secret references, 1Password service account, expiring credentials |
| [Hardware keys](docs/hardware-keys.md) | root only with a YubiKey; working as a site's user |
| [Fleet copies](docs/fleet-copy.md) | the fleet repo, encrypted and signed, on every server |
| [History](docs/history.md) | `/etc` in git: how a server got to where it is |
| [Local dashboard](docs/ui.md) | `fornax ui`: what it shows, how it is secured |
| [Safety](docs/safety.md) | permission tiers, guard rails, agent setup |
| [Compatibility](docs/compatibility.md) | what stays stable from 1.0: config, commands, JSON, error and exit codes, tiers, server layout |
| [Security](SECURITY.md) | threat model and known limits |
| [Development](docs/development.md) | tests, integration setup |
| [Roadmap](docs/roadmap.md) | what is planned before and after 1.0, and what was decided against |

## Requirements

- **Your machine:** macOS or Linux. fornax is a single binary (or `bun src/cli.ts` from a checkout); it uses your `ssh`, and `op` for 1Password.
- **Servers:** Ubuntu 24.04 or 26.04 LTS, arm64 or x86_64, root SSH (or a sudo user). Any provider.
- **Optional:** Tailscale, 1Password, `age` (encrypted fleet copies), Hetzner Cloud or DigitalOcean (ordering servers), Cloudflare (DNS), a Hetzner Storage Box (backups), a FIDO2 key, GitHub (push-to-deploy).

## Status

fornax runs the author's production servers — taken over from Laravel Forge in October 2026 — and is tested end to end on throwaway VMs and real Hetzner servers. It is not 1.0 yet: the config format is versioned and upgrades are automatic (`fornax fleet upgrade`), but commands and output may still change. What 1.0 will promise is in [compatibility](docs/compatibility.md); see the [changelog](CHANGELOG.md).

## Contributing

Bug reports and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to build and test fornax from source, the design rules every change follows, and how to document it. Report security problems privately ([SECURITY.md](SECURITY.md)).

## License

MIT
