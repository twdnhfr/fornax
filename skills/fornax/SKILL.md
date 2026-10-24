---
name: fornax
description: Provision, deploy and operate PHP/Laravel servers with the fornax CLI (a self-hosted Laravel Forge alternative). Use whenever the user wants to set up a server, add or remove a site, deploy, roll back, read logs, check certificates, edit a site's .env, look at server health, take over a Forge server, or order/destroy a server at Hetzner/DigitalOcean — and whenever a directory with an fornax.yaml is involved. Prefer fornax over hand-written ssh commands for anything it covers.
---

# fornax

fornax turns a fleet repo (a directory with `fornax.yaml` and `servers/*.yaml`) into running servers over SSH. It finds the repo upwards from the current directory, else `$FORNAX_FLEET` or `~/.config/fornax/fleet` — so commands work from anywhere. The repo is the wish; the servers are the reality; fornax shows the difference and closes it.

## Start here

```bash
fornax agent-context          # conventions, every command with its tier, the current fleet
fornax <command> --help       # arguments and options of one command
```

Run fornax **inside the fleet repo** (or pass `--fleet <dir>`). Add `--json` when you need to parse the result.

## Permission tiers

Every command declares one. Respect it:

| Tier | Meaning | You may |
| --- | --- | --- |
| `read` | never changes a server or remote API | run freely |
| `write` | changes servers, remote APIs or the fleet config | run after the user agreed to that change |
| `destroy` | deletes something | only on explicit request, with `--confirm=<name>` |

## How to change a server

1. Edit the fleet repo — by hand or with `fornax site add …` / `fornax server add …`.
2. `fornax plan <server>` (read) — prints the changes and a plan id. Show the user the plan.
3. `fornax apply <plan-id>` (write) — applies exactly that plan. It refuses if the server drifted since; then plan again.

Never edit managed files on a server by hand: the next plan reverts them. Put custom nginx config into the fleet repo as a snippet (`nginx.server: [snippets/…]`) or as a `files:` entry.

Fresh servers: `fornax server bootstrap <server>` then `fornax server provision <server>` (both plan + apply in one go). `fornax server create [name] --size … --location …` orders one (without a name it makes one up, two words like silent-comet; it costs money — only when the user asked for a new server) and provisions it in one go; with `access: tailscale` it needs `tailscale.api_token` (or a reusable `tailscale.auth_key`) and joins the tailnet first, tagged `tag:server` so a server gets none of the rights of the user's own devices. `no_tailscale_key` → ask the user for such a token or key in the fleet's vault. A failed create says the server exists and how to remove it — ask before running that.

## Everyday commands

```bash
fornax explain <site|server>        # facts: paths, user, PHP, releases, daemons, cron, certs — use instead of guessing
fornax health [server]              # verdict: healthy / warning / critical, only what is not ok (--all for every check)
fornax server status <server>       # raw facts: services, disk, updates, open ports
fornax history <server> [--path ufw] # who changed /etc and when: fornax runs, packages, or outside fornax (--show <commit> for the diff)
fornax site alias <site> --preview   # a made-up name under preview_domain (also --add/--remove names)
fornax server rename <server> [new]  # new name everywhere (provider, hostname, tailnet, fleet, 1Password, backups); old backups stay restorable — commit servers/ afterwards
fornax logs <site> [nginx|access|laravel|daemon|deploy|php] --lines 100 --grep '…'
fornax fleet copies                 # encrypted copies of the fleet repo on the servers (apply stores them; fleet push now)
fornax run <site> -- php artisan …   # one command as the site's user in its dir, its PHP version (write tier: ask before anything that changes data); exits with its code
fornax shell <site>                 # interactive shell as the site's user — for the user in a terminal, not for agents
fornax ssl status                   # all certificates, expiry, leftovers
fornax deploy <site>                # same path as push-to-deploy; exit 1 if failed or rolled back
fornax rollback <site>              # previous release, no rebuild
fornax releases <site>              # releases on disk + recent deploys
fornax env pull <site>              # .env → <fleet>/.fornax/env/<site>.env (git-ignored); edit; then
fornax env diff <site> / fornax env push <site>
```

## Backups and secrets

```bash
fornax backup status <server>       # exit 1 if a site failed or the last snapshot is older than 26 h
fornax backup run <server> [--site …]
fornax backup list <site>
fornax backup restore <site>        # side by side — safe; --replace overwrites live data and needs --confirm=<site>
fornax secrets setup                # once per fleet: own vault + service account (no Touch ID afterwards), the fleet SSH key, auto sync on
fornax tailnet status / sync        # tailnet policy from the fleet: servers reach only DNS + tailscale.allow, home machines everything (sync is write: show the user status first)
# ssh.security_key set (YubiKey): every new connection asks the user for PIN + touch in a dialog — tell them before
# running anything, and batch work per server (one connection is reused 10 min). `ssh_failed` right after a run
# started usually means the touch timed out; never work around it with other keys or Tailscale SSH.
fornax secrets list <server>        # which generated secrets 1Password has (values never shown)
fornax secrets sync <server>        # copy them into 1Password (also happens after every apply)
```

Prefer side-by-side restores; only use `--replace` when the user asked for it. `secrets_sync_failed` after an apply means the server changed but 1Password did not get the new secrets — ask the user to sign in to 1Password (`op signin`), then run `fornax secrets sync`. A `warning: "…" (1Password, …) expires in N day(s)` on stderr means a credential is about to run out: tell the user (once) — they renew it and put the new value and date into the item.

## Leaving Forge

One server at a time, every step a reviewed plan, no site moves:

```bash
fornax import forge <server> --org <org> --server-id <id>      # adopt; the first plan must be empty
fornax site convert <site> --only cron,logrotate,daemons        # then plan + apply + site check
fornax site convert <site> --only web                           # then tls, deploy, finalize — each followed by plan + apply + site check
fornax git connect <site> --replace-forge                       # push-to-deploy: fornax's webhook in, Forge's out
fornax detach forge <server>                                    # once no site is adopted: Forge's key, ufw rules, cron, PPA go
```

While Forge still runs the other sites it keeps changing their files; a plan would turn those changes back. When a plan shows drift on a site that is still adopted, run `fornax import forge <server> --org <org> --server-id <id> --refresh` instead of applying — it re-reads only unconverted sites.

`--only web` carries hand edits in Forge's vhost over as `snippets/<site>/vhost-*.conf` and lists them — show them to the user. An alias vhost that only proxies to a local port (Forge's Reverb template) becomes a `proxies` entry; fornax warns when the server behind it listens on 0.0.0.0. `convert_unsupported_vhost` means a part of the nginx config would be lost (e.g. an alias vhost that proxies to a websocket server): nothing was changed; do not work around it by editing files, ask the user.

Sites Forge deploys in place (no `releases/`) stay in place (`deploy.mode: in_place`); their build commands come from Forge's deploy script (`deploy.commands`) — show them to the user after `--only deploy`. A deploy refuses when tracked files were edited on the server; never discard those edits without asking.

Never delete a converted site in Forge while Forge still has access: its delete script removes nginx files and crons. After `detach forge` the user removes the server in Forge (provider credential first, or the machine gets deleted too).

## Reading errors

Errors are `{error, code, hint, next}`. `next` is the command that makes sense next — usually run it. Common codes: `plan_stale` (plan again), `confirmation_required` (ask the user, then repeat with `--confirm`), `policy_violation` (the fleet's `policies` forbid it — do not work around it), `validation_failed` (nginx/php-fpm rejected a config; fornax already restored the previous files), `apply_locked` (another apply runs on that server — wait, then plan again), `sudo_failed` (wrong or missing sudo password in 1Password).

## Rules

- `legacy_layout`: the server was set up under fornax's old name (anvil). It moves over in one full `fornax plan <server>` + apply (shown in the plan as `rename:`); show the user that plan before applying. Never move files by hand.
- `config_invalid` names the key: unknown keys are errors, so fix the spelling instead of adding the key elsewhere. `config_too_new`: the fleet needs a newer fornax. The note "fleet config is version N … read as upgraded" means `fornax fleet upgrade` would rewrite it — that edits only the fleet repo; let the user review the diff.
- Secrets never go into the fleet repo. `.env` lives on the server; credentials are references (`op://…`, `env:NAME`, `file:path`).
- `policies.maintenance_window` (UTC) limits server changes (`apply`, `bootstrap`, `provision`); outside it they fail with `outside_maintenance_window`. Only pass `--outside-window` when the user explicitly agrees. App deploys and rollbacks are never restricted.
- `policies.protected` lists things fornax will not delete. Do not edit it to get a delete through unless the user explicitly asks.
- A site with `adopted: true` was taken over from Forge: fornax manages its listed `files` byte for byte. Do not switch `generate` or `deploy` on without the user.
- Webhook deploys (push-to-deploy) need `webhook: { domain: … }` on the server and `fornax git connect <site>` once.
- fornax on a server updates itself before deploy/rollback/backup commands when it is older ("updated fornax on …"); a plan showing only "fornax binary on the server" is that same update and harmless.
