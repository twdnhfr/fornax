# Deploys

Push → GitHub posts to `https://<site>/.well-known/fornax-hook` → nginx hands it to `fornax hook serve` on the server (unprivileged, HMAC-verified with a secret per site) → `fornax-deploy@<site>.service` → `fornax release`:

clone into `releases/<timestamp>` → link `.env`, `auth.json` and shared paths → build (`.fornax/deploy.sh` in your repo, or the preset: composer, bun build, `storage:link`, `migrate --force`, `optimize`) → health check of the new release on a local-only nginx socket (a failing release never goes live) → switch `current` atomically → reload PHP-FPM, restart queues and daemons → second health check (automatic rollback on failure) → keep the last N releases → commit status / notification.

The layout is Forge's (`/home/<user>/<domain>/{releases,current,storage,.env}`), so adopted Forge sites keep working.

## Push-to-deploy

The webhook lives on each site's own domain, so a server needs no hostname of its own for it and a site that moves to another server takes its webhook along. The location lets the push past the site's basic auth and IP rules — only rules written with `if … return` in a snippet need the path added.

```bash
fornax git connect shop.example.com      # deploy key (read-only) + webhook at GitHub
```

`git connect` first sends a signed ping to the URL (it deploys nothing) and only then points GitHub at it; a hook the site had at an older URL is moved, never doubled. Without GitHub, add the deploy key from `fornax git key` and a webhook to `/.well-known/fornax-hook` by hand, or deploy with `fornax deploy`.

`webhook.domain` on a server (an extra hostname for the webhook) is still understood for older setups.
