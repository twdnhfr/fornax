# Deploys

Push → GitHub posts to `https://<site>/.well-known/fornax-hook` → nginx hands it to `fornax hook serve` on the server (unprivileged, HMAC-verified with a secret per site) → `fornax-deploy@<site>.service` → `fornax release`:

clone into `releases/<timestamp>` → link `.env`, `auth.json` and shared paths → build (`.fornax/deploy.sh` in your repo, or the preset: composer, bun build, `storage:link`, `migrate --force`, `optimize`) → health check of the new release on a local-only nginx socket (a failing release never goes live) → switch `current` atomically → reload PHP-FPM, restart queues and daemons → second health check (automatic rollback on failure) → keep the last N releases → commit status / notification.

The layout is Forge's (`/home/<user>/<domain>/{releases,current,storage,.env}`), so adopted Forge sites keep working.

## Node apps

`preset: node` runs an app with its own server — Next.js, Nuxt, Remix, an Express or Bun server — behind nginx. The site keeps everything else a site has: its Linux user, TLS, `www_redirect`, `redirects`, aliases, snippets (basic auth, IP rules), push-to-deploy, logs, backups of `.env` and shared paths, `fornax run` / `fornax shell`. There is no PHP-FPM pool and, unless `redis.instance` says otherwise, no Redis.

```yaml
sites:
  app.example.com:
    repo: acme/app
    preset: node
    node:
      start: bun run start -H 127.0.0.1    # or: node .next/standalone/server.js
      # port: 3100                         # optional: 3100 and 3101; default derived from the domain
```

The server needs `node` in its `tools` (from NodeSource), or `bun` when the start command is a bun one; `fornax plan` says so otherwise. Without `deploy.commands` or `.fornax/deploy.sh` the lockfile picks the build: `bun.lock`/`bun.lockb` → `bun install --frozen-lockfile` and `bun run build`, `package-lock.json` → `npm ci` and `npm run build`. The app gets `PORT`, `HOST`/`HOSTNAME=127.0.0.1` and `NODE_ENV=production`, and finds `.env` linked into its release (Next.js and bun read it by themselves, plain node with `--env-file=.env`). Bind it to 127.0.0.1 — `next start` ignores `HOSTNAME` and needs `-H 127.0.0.1`; a deploy warns when the app listens on more than that.

**How a deploy switches.** The app has two slots, `fornax-node-<site>-a` and `-b`: systemd units of the site user, each on its own port, each started from the release its link `slot-a`/`slot-b` points at. A deploy builds the release as usual, then starts it in the slot nginx does not point at, next to the live one, and checks it on its own port (`health_check`, default `/`, 2xx or 3xx within a minute; a process that exits gives up at once and its output lands in the deploy log). Only then does it rewrite the nginx upstream (`/var/lib/fornax/nginx/<site>.conf`) to the new port, check it with `nginx -t` and reload, wait until nginx's old workers have finished their requests, and stop the old slot. A release that does not answer is never switched to: the live slot never noticed it. A check through nginx follows (a 5xx or no answer switches straight back to the old slot). `fornax rollback` takes the same path without the build. Which slot is enabled is what survives a reboot — the enabled unit starts, the upstream already points at it.

A change to `node.start` (or the unit fornax writes) does the same with the current release once `apply` has written the units, so it causes no downtime either; changing `node.port` interrupts the app for as long as it takes to start. `fornax logs <site> app` shows the app's output, `fornax explain <site>` which slot serves which release.

## Push-to-deploy

The webhook lives on each site's own domain, so a server needs no hostname of its own for it and a site that moves to another server takes its webhook along. The location lets the push past the site's basic auth and IP rules — only rules written with `if … return` in a snippet need the path added.

```bash
fornax git connect shop.example.com      # deploy key (read-only) + webhook at GitHub
```

`git connect` first sends a signed ping to the URL (it deploys nothing) and only then points GitHub at it; a hook the site had at an older URL is moved, never doubled. Without GitHub, add the deploy key from `fornax git key` and a webhook to `/.well-known/fornax-hook` by hand, or deploy with `fornax deploy`.

`webhook.domain` on a server (an extra hostname for the webhook) is still understood for older setups.
