# Roadmap

What is planned, what was decided against, and where the groundwork is. Changes that shipped are in the [changelog](../CHANGELOG.md).

## Next

- **Every server a host (peers):** the fleet repo on every server, every commit signed by one of the fleet's signers, plan and apply from any server over a forwarded SSH agent. There are no server-to-server keys and no secrets at rest. Design: [design/peers.md](design/peers.md).
- **FrankenPHP as a per-site PHP runtime** (classic or Laravel Octane worker mode), behind nginx, one process per site as the site's user. Researched and spiked — numbers, pitfalls, the design and tested configs: [design/frankenphp-and-caddy.md](design/frankenphp-and-caddy.md).
- Push-to-deploy by polling as an alternative to the webhook (no inbound request at all).
- GitLab and Gitea as git hosts; S3-compatible backup targets besides the Hetzner Storage Box.
- Uptime and certificate monitoring beyond `fornax health`.
- `server upgrade` (Ubuntu release upgrades).

## Decided against (for now)

- **Caddy as the front web server.** Slower than nginx for PHP and much slower for static files in the spike, no equivalent of nginx's `disable_symlinks` (a step back for site isolation), and automatic ACME in the background does not fit "the plan shows every change". Reconsider only on demand — the design note covers how it would fit.
- Docker images, static FrankenPHP binaries, several FrankenPHP PHP versions per server.
