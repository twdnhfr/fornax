# Roadmap

What is planned, what was decided against, and where the groundwork is. Changes that shipped are in the [changelog](../CHANGELOG.md).

## Before 1.0

- **Hand a taken-over server's own configuration to fornax** (`server convert`): servers imported from Laravel Forge keep Forge's nginx.conf, PHP settings, firewall and database configuration (`modules: []`) until each module is switched over with a plan.
- **A `node` site preset** for apps with a Node server (Next.js and the like): nginx in front, the app's own process as the site user, a new release started and checked before it takes over.
- **Exit codes and naming before they are frozen** — see the open points in [compatibility](compatibility.md).

## After 1.0

- **FrankenPHP as a per-site PHP runtime** (classic or Laravel Octane worker mode), behind nginx, one process per site as the site's user. Researched and spiked — numbers, pitfalls, the design and tested configs: [design/frankenphp-and-caddy.md](design/frankenphp-and-caddy.md).
- Push-to-deploy by polling as an alternative to the webhook (no inbound request at all).
- GitLab and Gitea as git hosts; S3-compatible backup targets besides the Hetzner Storage Box.
- Uptime and certificate monitoring beyond `fornax health`.
- `server upgrade` (Ubuntu release upgrades).

## Decided against (for now)

- **Caddy as the front web server.** Slower than nginx for PHP and much slower for static files in the spike, no equivalent of nginx's `disable_symlinks` (a step back for site isolation), and automatic ACME in the background does not fit "the plan shows every change". Reconsider only on demand — the design note covers how it would fit.
- Docker images, static FrankenPHP binaries, several FrankenPHP PHP versions per server.
