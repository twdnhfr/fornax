# Caddy and FrankenPHP in fornax — research, spike and design

Status: **decided 2026-10-24 — FrankenPHP as a per-site runtime comes after 1.0; Caddy as the front web server is not planned** unless someone needs it. Written against fornax `c6902d9` from research and a throwaway OrbStack spike (Ubuntu 24.04 arm64). The spike's scripts and the configs that passed every test are in [`frankenphp-spike/`](frankenphp-spike/) (`final/` holds the tested systemd units and Caddyfiles); start there instead of from scratch.

Before building it, re-check the versions in §2 and the hard constraints in §1 against the current FrankenPHP release — the project moves fast.

## 1. Summary & recommendation

**Build FrankenPHP as a per-site PHP runtime, behind the nginx fornax already runs. Defer Caddy as the front web server, and don't make it a default.**

- **FrankenPHP's value is worker mode** (Laravel Octane): about **3× the throughput of PHP-FPM** on a framework-bound route (about 27k vs 9.3k rps on Laravel's `/up`), at lower latency. Classic (non-worker) FrankenPHP is only about 15% faster than FPM. Neither helps I/O-bound routes: a route that writes a session file ran at about 2k rps on every stack.
- **Caddy adds little for fornax.** fornax's TLS already works (certbot, webroot, Cloudflare, Pebble tests, plan visibility). Caddy+FPM measured about 10% slower than nginx+FPM on PHP and 3.7× slower on static files. Caddy also has no `disable_symlinks if_not_owner`, which is a step back for isolation if it serves files from site homes. Its automatic ACME runs asynchronously in the background, issues one certificate per name, and its HTTP-01 challenge breaks behind Cloudflare with "Always Use HTTPS" on. All three cut against "plan shows every change" and against the setups fornax already supports.
- **Isolation dictates the shape.** One FrankenPHP process runs every site as one Linux user, because threads share a UID. Per-site users therefore need **one FrankenPHP process per site, run as the site user, on a unix socket, with a front proxy** that terminates TLS. That front can be nginx today. Caddy as the front is optional and could come later.
- **Spike-proven pattern** (tested end to end on Ubuntu 24.04):
  - a systemd **socket unit** owns `/run/fornax-php/<site>.sock` (owner: site user, group: the web server user, mode 0660);
  - a **service** runs `frankenphp run` as the site user with `bind fd/3`;
  - the admin API sits on a unix socket in a 0700 directory;
  - a **stable worker shim** lives outside `releases/`.

  Deploys under load gave **zero failed requests**: about 1.3M requests across worker restarts, full restarts, and pruning of the release the process booted from.
- **Hard constraints the spike found** (each would cause an outage or a security hole if missed):
  1. FrankenPHP **pins the resolved symlink path of the worker file** at config load. Neither `workers/restart` nor `reload` re-resolves it, so pruning that release takes the site down. Fix: a worker shim at a stable path, or a full restart.
  2. **Classic mode keeps serving the old release for about 120 s** after the `current` switch (PHP's per-thread `realpath_cache_ttl`). A deploy must restart the process.
  3. **Caddy answers an empty `200` for unmatched hosts.** A status-code-only health check can pass a broken release.
  4. **`artisan octane:frankenphp` (stock Octane) exposes its Caddy admin API on TCP localhost.** Another site's user could read and rewrite that site's config (tested). It also bound `*:port` despite `--host=127.0.0.1`. fornax must never run Octane that way; it must generate the FrankenPHP config itself.
  5. The FrankenPHP deb **starts a server on :80 and an admin API on localhost:2019 as soon as it is installed**. fornax must mask it before anything else.
  6. **One FrankenPHP PHP version per server.** The official deb repo uses unversioned package names (`frankenphp`, `php-zts-*`). FPM from the ondrej PPA can stay alongside for other versions (both coexisted in the spike).

**MVP (about 1.5 weeks):** `runtime: frankenphp` per site (classic or Octane worker) behind nginx, with deploy integration, a pre-activation check on a transient FrankenPHP of the new release, and OrbStack integration tests (deploy under load must give zero non-200s).
**Later, only if there is demand (about 3 weeks):** server-level `web: caddy`, with certbot-fed certificates first and Caddy-managed ACME opt-in.
**Not at all:** on-demand TLS, Caddy+FPM as a migration target for existing servers, Octane via `artisan octane:frankenphp` under supervisor, static FrankenPHP binaries, multiple FrankenPHP PHP versions per server, Docker images.

## 2. Findings

### 2.1 Caddy (v2.11.7, current stable; 2.11.x since 2026-02, roughly monthly patch releases)

| Topic | Finding | Relevance for fornax |
| --- | --- | --- |
| Packaging | The official apt repo (Cloudsmith `caddy/stable`) installs `caddy.service` as user `caddy`, config `/etc/caddy/Caddyfile`, `ExecReload=caddy reload --force`. Plugins (DNS providers, Cloudflare IP ranges) need a custom `xcaddy` build or `caddy add-package`, which replaces the packaged binary and doesn't survive apt. | Stock package only: no DNS-01, no `trusted_proxies cloudflare`. |
| Config | Caddyfile (adapted to JSON) or JSON. `import <glob>` brings in per-site files (relative to the importing file; an empty glob is fine). Snippets take arguments. | Per-site files `import /etc/caddy/sites/*.caddy` map 1:1 onto fornax's `file` resources. |
| Validation / reload | `caddy validate` adapts *and provisions* the config (catches bad bcrypt hashes, missing cert files). Reload goes through the admin API and is atomic: a rejected config leaves the old one running (verified: `systemctl reload caddy` exits 1, the site keeps serving). Reloads abort in-flight ACME transactions, so the docs advise batching changes. | Fits fornax's handler model: `validate: caddy validate …`, `reload: systemctl reload caddy`. |
| Admin API | **Default `localhost:2019`, no authentication.** Any local process, including site code, can replace the whole config. `admin unix//run/caddy/admin.sock` works; `caddy reload` reads the address from the config file. | Must be a unix socket in a root/caddy-only directory, never TCP. Without that, a site user can take over the front proxy. |
| Automatic HTTPS | Certificates are obtained in the **background after start/reload**; the server answers before they exist. Retries with backoff for up to 30 days, falling back from Let's Encrypt to ZeroSSL, and to LE staging while retrying. Internal limit of 10 attempts per account per 10 s. **One certificate per hostname** (SAN bundles only via JSON). Storage: `$HOME/.local/share/caddy` (package: `/var/lib/caddy/...`), with PEM files per name. `tls internal` = local CA (verified). `tls cert key` = files you manage. `acme_ca`/`acme_ca_root` cover Pebble/staging. | Apply can't know when a certificate is there; fornax would have to poll storage. Per-name certificates use more of LE's per-domain budget than today's SAN certificate. |
| On-demand TLS | Issues during the first handshake; needs an `ask` endpoint against abuse. | fornax knows every name in the fleet, so not needed. Don't. |
| Behind Cloudflare | HTTP-01 needs "Always Use HTTPS" **off** at Cloudflare (caddy issue #4735, community threads). TLS-ALPN can't work through the proxy. DNS-01 needs a plugin build. `trusted_proxies static <CF ranges>` works without a plugin; dynamic CF ranges need one. | Worse than today's nginx setup, where `acme.conf` sits in the 443 server too, so Cloudflare "Full" with "Always Use HTTPS" works. |
| Unknown hosts | HTTPS: handshake refused (verified). HTTP: 308 to https (verified). A site block that matches no host on a socket listener answers **empty 200** (verified). | Generated configs need an explicit catch-all, and health checks must not rely on the status code alone. |
| Basic auth / IP gates | `basic_auth [<matcher>] { user <bcrypt|argon2id hash> }`; `remote_ip` / `client_ip` matchers with `trusted_proxies`. `handle` blocks are mutually exclusive, so the webhook path can sit outside auth cleanly. | Expressible as first-class schema fields; nginx snippets can't be reused. |
| `php_fastcgi` | Expands to try_files plus `reverse_proxy` with fastcgi transport, and supports `unix//` sockets. `resolve_root_symlink` gives FPM the real release path (the equivalent of nginx's `$realpath_root`). | Caddy+FPM works (verified). |
| Symlinks | `file_server` follows symlinks; there is no `disable_symlinks if_not_owner` equivalent (none in the docs; not separately tested). | Caddy serving static files from `/home/*` is weaker than nginx (SECURITY.md guarantee 4). |
| Logging | The `log` directive per site, JSON, with built-in roll (`roll_size`, `roll_keep`). | Replaces nginx access/error logs plus logrotate for the front. |

### 2.2 FrankenPHP (v1.13.3 of 2026-10-23, Caddy 2.11.7 inside)

| Topic | Finding |
| --- | --- |
| Maturity / cadence | 1.x since late 2024. Minor releases about every 2–3 months, patches every 1–3 weeks (1.13.0 10-04, 1.13.1 10-16, 1.13.2 10-21 security, 1.13.3 10-23). 1.13.0 fixed 5 vulnerabilities (2 high); 1.13.2 shipped the PHP2Shell PHP versions plus 4 FrankenPHP vulnerabilities. Changes still land with **upgrade notes** (e.g. `num_threads` semantics in 1.13.0). Active, but fast-moving. |
| Packaging | Official deb/rpm/apk repos run by a core maintainer at `pkg.henderkes.com`, **one repo per PHP minor** (82–85). Packages: `frankenphp` (depends on `libphp-zts-84.so`), `php-zts-cli` (`/usr/bin/php-zts`), `php-zts-<ext>` (about 90 extensions incl. redis, igbinary, intl, gd, pgsql, pdo-*, imagick, xdebug). INI in `/etc/php-zts/php.ini` plus `conf.d/`. **Package names are unversioned → one PHP version per server** (verified: adding the 8.5 repo upgrades the 8.4 packages in place). The PHP patch release arrived about 1 day after ondrej's (8.4.27). |
| Default service | Installing **starts `frankenphp.service` immediately** on `*:80` plus `localhost:2019` (verified). On an nginx server that's a port fight; fornax must mask the unit first. |
| Static binaries | Linux binaries are statically linked, carry only PHP 8.5 and a fixed extension set (no loading extensions), and are musl unless you build GNU yourself. Slower (musl + ZTS). Not for fornax. |
| ZTS caveats | Not thread-safe: `imap`, `newrelic`, `pcov`. Buggy: `datadog`; `imagick` with OpenMP (disabled in the deb packages). Composer `@php` scripts can't call `frankenphp php-cli` (use the `php-zts` CLI or the ondrej CLI). |
| Classic vs worker | Classic: per-request bootstrap like FPM, threads instead of processes, `num_threads` default 2×CPU, `max_threads` for autoscaling. Worker: the app boots once; the `frankenphp_handle_request()` loop; `$_ENV` is **not** reset between requests; statics and globals persist; `max_requests` / Octane's `MAX_REQUESTS` (default 500) recycle threads. |
| Laravel Octane | `laravel/octane` 2.22.0 and `octane:install --server=frankenphp` copy `public/frankenphp-worker.php`. The worker script needs `APP_BASE_PATH` (else Octane's state file), `LARAVEL_OCTANE=1` and `MAX_REQUESTS`. `artisan octane:frankenphp` renders its own Caddyfile with **admin on TCP** (`--admin-port`, default 2019) and listens on all interfaces for the port. |
| Reloads | `POST /frankenphp/workers/restart` on the admin API restarts workers gracefully. Since 1.13.0 a config reload validates before swapping. **A reload with unchanged config does not restart workers** (verified). |
| Behind a proxy | `trusted_proxies_unix` trusts `X-Forwarded-*` on unix sockets, but PHP still sees `REMOTE_ADDR=@` and `HTTPS` unset. `php_server { env HTTPS on; env REMOTE_ADDR {client_ip} }` gives the correct client IP and https, and ignores spoofed `X-Forwarded-For` from clients (verified). Laravel then needs no `trustProxies` change. |
| Memory | Go runtime + ZTS PHP + per-thread state: a per-site process idles at about 45–55 MB PSS (classic, little traffic) up to 120–250 MB (worker mode, 4–20 workers, after load). A worker adds about 3 MB. An FPM pool with `ondemand` can idle at about 0. |

## 3. Spike results

**Environment.** OrbStack machine on a Mac (arm64, 17 vCPU, 16 GB, LXC container), Ubuntu 24.04.5, kernel 7.2.9. PHP 8.4.27 from ondrej (FPM, NTS) and 8.4.27 ZTS from the FrankenPHP repo. Caddy v2.11.7, FrankenPHP v1.13.3 (deb `1.13.3+php84.27-1`), nginx 1.24.0 (Ubuntu's, not nginx.org), Laravel 13.38.0 (fresh `laravel/laravel`, `APP_ENV=production`, `artisan optimize`), Octane 2.22.0, Composer 2.10.3. Load tools: oha 1.16.0 (HTTP, status-code counts) and wrk 4.1.0 (TLS; oha's rustls rejected the local CA). The load generator ran on the same machine, 32 connections, 5 s warm-up plus 15 s measured, 2 rounds. Treat the numbers as **relative**, not absolute. Site layout as in fornax: `/home/<user>/<user>.test/{releases/<ts>,current,storage,.env}`, user in group `isolated`, home ACL `g:isolated:---`. FPM pool `pm = dynamic`, `max_children 10`; FrankenPHP `num_threads 10` or 10 workers for parity.

### 3.1 Throughput (requests/s; p50 / p99)

| Stack (plain HTTP, direct) | `/up` (stateless, full framework) | `/hello` (web group, file sessions) | static `robots.txt` |
| --- | --- | --- | --- |
| nginx 1.24 + FPM (fornax today) | **9,000–9,740** (3.3 / 5.7 ms) | 2,320–2,330 | 339,700 |
| Caddy + FPM (`php_fastcgi`) | 8,090–8,430 (3.6 / 7.6 ms) | 2,260–2,510 | 90,800 |
| FrankenPHP classic | 10,240–11,260 (2.7–3.0 / 5.4–5.9 ms) | 1,840–1,920 | 103,900 |
| FrankenPHP worker (Octane, 10 workers) | **25,600–28,780** (1.0–1.1 / 2.6–3.0 ms) | 1,770–1,810 | — |

| TLS end to end (wrk) | `/up` | static |
| --- | --- | --- |
| nginx TLS + FPM | 9,370 (3.3 / 5.0 ms) | 224,800 |
| Caddy TLS → unix socket → FrankenPHP worker | **12,310–12,430** (2.2 / 7.7 ms) | 35,100 |
| Caddy TLS → unix socket → FrankenPHP classic | 7,880–8,920 | — |

`/hello` creates a session file per request, so disk I/O caps every stack at about 2k rps. The worker advantage shows only on CPU/framework-bound requests. Through a TLS front the worker gain shrinks to about 1.3× (the proxy hop plus TLS dominate at this rate), but on real routes with database work, boot time is the larger share.

### 3.2 Memory

| | PSS (shared pages split) |
| --- | --- |
| FPM pool, idle (master + 5) | 43 MB; under load (10 children) 46 MB |
| nginx (19 processes) | 23 MB |
| Caddy front | 73 MB (RSS 47 MB right after start, 90 MB under load) |
| FrankenPHP worker, 1 / 2 / 10 / 20 workers | 175 / 191 / 220 / 249 MB (opcache 256 MB configured, after 2,000 requests) |
| FrankenPHP worker, 4 workers (two-site setup) | 121 MB |
| FrankenPHP classic, 10 threads, little traffic | 45 MB (151 MB RSS after the benchmark) |

### 3.3 Deploys under load (16 connections on `/up` plus a 20 Hz probe on `/hello` that reports the release id)

| Variant | Failed requests | Max latency | Served release |
| --- | --- | --- | --- |
| Worker; worker file under `current/`; switch + `POST /frankenphp/workers/restart` | 0 of 346k | 123 ms | new ✔ |
| Same, after **pruning the release the process booted from** | site down (176 rps, probes time out) | — | ✘: "Failed opening required releases/2…/frankenphp-worker.php" |
| Same + `systemctl reload` (config reload `--force`) | 0 | 7 ms | **old**: workers not restarted |
| Same, reload after pruning | site down (500s) | — | ✘ |
| `systemctl restart`, TCP listener, no socket activation | 286k connection-refused (oha hammering), 4 of 242 probes | ~250 ms gap | new |
| **Stable shim** `<root>/frankenphp-worker.php` (outside `releases/`) + `match *` + workers/restart | 0 of 329k | 117 ms | new ✔ |
| Same, after pruning the boot release | **0 of 315k** | 119 ms | new ✔ |
| **Socket activation** + Caddy front + full `systemctl restart` | **0 of 159k** | 190 ms | new ✔ |
| Socket activation + Caddy front + workers/restart | 0 of 159k | 131 ms | new ✔ |
| Classic mode, `current` switched, nothing restarted | 0 | — | **old release for 122 s**, then new |

### 3.4 Pre-activation check

- A **long-lived preview block** in the site's FrankenPHP (classic, root `next/public`, own socket) served the **previous** `next` target after `next` was switched (same realpath cache), so it is unusable.
- A **transient FrankenPHP** started by the deploy as the site user via `setpriv`, rooted at the real release path (`releases/<ts>`, no symlink), worker mode, `admin off`, on a unix socket, then stopped: **~1.0 s** cold to first 200 (boot included). A release with a syntax error in its routes fails (worker boot fails, the process exits, HTTP 000). Live traffic is untouched.
- Octane's worker script answers **"FrankenPHP must be in worker mode…" with HTTP 200** when the routing is wrong (seen while the shim lacked `match *`). Health checks should look at more than the status code, e.g. an optional `health_check_contains`.

### 3.5 Isolation (two sites, two users, socket-activated FrankenPHP, Caddy front)

| Check | Result |
| --- | --- |
| site B reads A's `.env` / lists `/home/A` | denied / denied |
| site B connects to A's HTTP socket (`0660 A:caddy`) | denied (EACCES) |
| site B reaches A's admin socket (in `/var/lib/fornax-php/A`, 0700) | denied |
| front proxy user `caddy` reads A's `.env` (0640) | denied; the front needs no file access at all |
| B plants symlinks in its `public/` to A's `.env` and to a world-readable code file of A | 404 / 404: static files are served by B's own process as B |
| root (fornax) uses A's admin API | 200 |
| PHP in each process runs as its site user, `PHP_SAPI=frankenphp` | yes |
| **Stock `artisan octane:frankenphp` as A, admin on `localhost:2099`: B reads A's config** | **200, full config** (and so could also `POST /load`) |
| `PrivateTmp=yes` per site process | **not verifiable in OrbStack** (LXC; OrbStack injects a drop-in that disables systemd namespacing: `PrivateTmp=no`). This also means fornax's existing `ProtectHome=yes` on `fornax-hook` isn't enforced in its OrbStack tests. Verify on a Hetzner VM. |

**Compared with nginx + FPM pools today.** User separation is equivalent: an FPM pool and a FrankenPHP process both run as the site user. The FrankenPHP setup is **stricter for static files**: the shared web server never reads site homes, so there is no need for `disable_symlinks`, and the front could even be kept out of `/home` via the `isolated` ACL. It could also **close the `/tmp` limit** in SECURITY.md with `PrivateTmp` per site (to be verified on a real VM). Two things are weaker:

- one more privileged control surface per site (the admin API), safe only on a unix socket in a 0700 directory;
- Caddy+FPM, where Caddy would read homes without symlink protection.

### 3.6 Problems hit

- systemd re-chowns `RuntimeDirectory=` for every `Exec*` command, so an `ExecStartPre=+chgrp caddy` is undone. Socket activation (`SocketUser`/`SocketGroup`) is the clean fix, and also hides restarts.
- `frankenphp php-cli -v/-m` isn't available below PHP 8.6; use `/usr/bin/php-zts`.
- Ubuntu's nginx 1.24 lacks `http2 on;` (fornax uses nginx.org packages, so not an issue there).
- oha with `--insecure` still fails on Caddy's local CA (rustls `BadSignature`); wrk works.

## 4. Design

### 4.1 Config model

Separate the two choices; they are independent axes:

```yaml
# servers/web-1.yaml
web: nginx                 # nginx (default, all existing servers) | caddy (phase 2)
php: ["8.4", "8.5"]        # FPM versions (ondrej), as today
frankenphp:                # optional; installs the ZTS repo + packages
  php: "8.5"               # exactly one version per server (packaging constraint)
  extensions: [redis, igbinary, intl, gd, pdo-pgsql, pdo-mysql, zip, bcmath]
sites:
  shop.example.com:
    runtime: frankenphp    # fpm (default) | frankenphp
    frankenphp:
      worker: octane       # omit → classic; "octane" → Octane worker script; later: a path for custom worker scripts
      workers: 4           # worker threads (default: 2)
      threads: 4           # classic threads (num_threads; default 4, not 2×CPU)
      max_requests: 500    # recycle (Octane MAX_REQUESTS)
    php: "8.5"             # must equal frankenphp.php when runtime is frankenphp (config_invalid otherwise)
```

Rules (checked when the fleet loads, so plan fails early with `config_invalid`):

- `runtime: frankenphp` needs `frankenphp` on the server, and `site.php` equal to `frankenphp.php`.
- `worker: octane` needs preset `laravel`. fornax doesn't install Octane; the repo must require `laravel/octane`. The first deploy checks `vendor/laravel/octane/bin/frankenphp-worker.php` exists and fails with a hint otherwise.
- A daemon whose `cmd` matches `octane:` (already recognised by `daemonName`) on a site with `runtime: frankenphp` is an error: "fornax runs Octane itself; remove the daemon". On FPM sites it gets a warning (admin API on TCP, binds all interfaces).
- `pool:` settings are ignored for FrankenPHP sites (warn if non-default).

Combinations:

| | FPM | FrankenPHP classic | FrankenPHP worker |
| --- | --- | --- | --- |
| **nginx front** | today | ✔ MVP | ✔ MVP |
| **Caddy front** | allowed (mixed servers) but not recommended: no symlink protection, no gain | ✔ phase 2 | ✔ phase 2 |
| FrankenPHP as the only web server (owns :443, all sites in one process) | — | ✘ breaks per-site users | ✘ |

Defaults: new servers stay `web: nginx`, sites `runtime: fpm`. FrankenPHP is opt-in per site, since apps must be Octane-safe for worker mode and the idle memory is higher. Reconsider the default only after FrankenPHP has run in production for a while.

### 4.2 Per area

**Server modules.**
- `php` gets a `frankenphp` block:
  - `aptRepo` for `pkg.henderkes.com/api/packages/<ver>/debian` (pinned key);
  - **`systemctl mask frankenphp.service` before the package install** (a `check` resource with `flushBefore`), so the package's default server never binds :80;
  - packages `frankenphp php-zts-cli php-zts-<ext>`;
  - `/etc/php-zts/conf.d/90-fornax.ini` (the same `phpIni` content);
  - a handler `frankenphp` whose validate step is `frankenphp validate` over each site config, and whose reload restarts the affected units.
- `unattended-upgrades` covers neither ondrej nor this repo; see Risks.
- `web` is unchanged for nginx. The socket group is `ctx.admin` (the user nginx runs as), just like FPM's `listen.owner`.

**Per site (runtime frankenphp).** New resources, named like `fornax-redis@<user>` so they fit `docs/compatibility.md`:
- `/etc/systemd/system/fornax-php-<slug>.socket` and `.service`. These are per-site files rather than a template, because the instance is the site while `User=` is its user. Several sites of one user each get their own process, so a deploy restarts only its own site.
- `/etc/fornax/frankenphp/<slug>.caddyfile`, written by fornax and root-owned. Shape: Appendix A.
- `<root>/frankenphp-worker.php` (the shim, site-user-owned, written via `asUser`). It must stay outside `releases/`.
- The socket is `/run/fornax-php/<slug>.sock` (`SocketUser=<user>`, `SocketGroup=<admin>`, `0660`). The admin socket is `/var/lib/fornax-php/<slug>/admin.sock` (StateDirectory 0700, owned by the user).
- `service()` resources for the socket (enabled) and the service.
- Removing a site stops and disables both units, deletes the files, and `--purge` drops the state directory.
- The FPM pool file goes away when a site switches runtime (`absent(poolPath)` after the vhost points at the socket: same `flushBefore` ordering as `retire`).

**Vhost (nginx front).**
- `vhostConf` gets a runtime switch. Instead of `location ~ \.php$ { fastcgi_pass … }` plus `try_files … /index.php`, it emits `location / { proxy_pass http://unix:/run/fornax-php/<slug>.sock; proxy_set_header Host $host; X-Forwarded-For $remote_addr; X-Forwarded-Proto $scheme; …; proxy_buffers like fastcgi_buffers }`.
- Static files: let FrankenPHP serve them (simplest, isolation-friendly), or keep `try_files $uri @app` in nginx for speed (nginx served static files about 6× faster than Caddy→FrankenPHP over TLS in the spike: 225k vs 35k rps). Proposal: nginx serves `/build/`, `/vendor/`, favicon and robots via `try_files` with `disable_symlinks if_not_owner` as today; everything else is proxied.
- Snippets, basic auth, IP gates, redirects, aliases, www, proxies (Reverb), the webhook location and `acme.conf` all stay exactly as they are. This is the main reason to start behind nginx: **every existing nginx snippet keeps working.**
- FrankenPHP side: `trusted_proxies_unix`, `env HTTPS on` (only when the site has TLS) and `env REMOTE_ADDR {client_ip}`. No app change needed.

**TLS.** Unchanged under nginx (certbot webroot). For phase 2 see §4.3.

**Pre-activation health check.**
- `previewSocket` (an nginx preview server) isn't used for FrankenPHP sites. Instead `fornax release` starts a **transient FrankenPHP** as the site user after the build. It uses `setpriv` like `run()`, with a generated config in `/run/fornax-preview-<slug>.caddyfile`, rooted at the *real* `releases/<ts>/public` with `APP_BASE_PATH=releases/<ts>`. It runs in the site's mode (worker or classic), with `admin off`, `num_threads 1`, one worker, and a socket in the site's state directory. The check reuses `previewCheck` (pass `--unix-socket`), then kills the process.
- Cost: about 1 s and one short-lived process of about 100–170 MB per deploy.
- This is *more* faithful than today's check: the new release is booted exactly the way it will run, including Octane boot.
- Also add an optional `health_check_contains: <string>`, since Octane and Caddy can answer 200 for a misrouted request.

**Deploy (`src/remote/release.ts`).**
- `reload()` gets a runtime branch:
  - classic: `systemctl restart fornax-php-<slug>` (socket activation hides the restart; there is no other way to clear the realpath cache);
  - worker: `POST /frankenphp/workers/restart` via the admin socket (graceful, about 120 ms max), falling back to `systemctl restart` if the call fails.
  - Rollback uses the same path.
- Then the post-activation health check as today.
- `queue:restart` and supervisor restarts are unchanged; queues stay `php artisan queue:work` with the **NTS CLI of the same minor version** (ondrej `phpX.Y`) or `php-zts` (option `frankenphp.cli: zts|nts`, default `zts` so web and workers share extensions).
- Document that apps must **not** call `php artisan octane:reload` in `.fornax/deploy.sh`: it would talk to `localhost:2019`, which isn't theirs.
- In-place deploys (`deploy.mode: in_place`) work the same (no symlink, but restart required).

**Push-to-deploy webhook.** Unchanged: the `location = /.well-known/fornax-hook` in the nginx vhost still proxies to `fornax hook serve`. (With a Caddy front: `handle /.well-known/fornax-hook { rewrite * /fornax/hook/<domain>; reverse_proxy 127.0.0.1:9300 }` ahead of the site's `handle` that carries auth and IP rules.)

**Daemons.**
- FrankenPHP processes are **systemd units, not supervisor programs**. systemd provides socket activation, `Type=notify` readiness, per-unit sandboxing, journald logs, and fornax already does this for per-site Redis.
- Supervisor remains for queue, Horizon and Reverb daemons.
- Restart policy `Restart=on-failure`. FrankenPHP's own `max_consecutive_failures` (default 6) ends the process when a worker can't boot, and systemd restarts it.

**Isolation (SECURITY.md).**
- Guarantee 4 gains a line: "FrankenPHP sites: one FrankenPHP process per site, run as the site user, reachable only through its socket (group of the web server); its admin API only through a socket in a 0700 directory."
- New contributor rule: **never generate a Caddy or FrankenPHP config whose `admin` is TCP**. A unit test asserts every generated Caddyfile has `admin unix//` or `admin off`.
- `PrivateTmp=yes`, `NoNewPrivileges=yes`, `ProtectSystem=full` on the units. Once verified on a real VM, the `/tmp` known limit no longer applies to FrankenPHP sites.
- `ProtectHome` can't be used: the site lives in `/home`.

**Multiple PHP versions.** FPM keeps any number of versions via ondrej; FrankenPHP is exactly one (`frankenphp.php`). Changing it is a server-level plan that upgrades the ZTS packages in place and restarts *all* FrankenPHP sites; plan should show that as one destructive-ish step. Mixed servers (FPM 8.3 for an old app, FrankenPHP 8.5 for the hot one) work: verified that both coexist and `/usr/bin/php` stays the ondrej alternative.

**Logging.**
- FrankenPHP stdout/stderr (Caddy JSON logs, PHP errors) go to the journal of `fornax-php-<slug>.service`.
- Set the `log default` level to `WARN`; access logs stay in nginx.
- `fornax logs <site> php` reads `journalctl -u fornax-php-<slug>` for FrankenPHP sites; `php_admin_value[error_log]` becomes `php_ini error_log /home/<user>/.fornax/php-error.log`.
- logrotate is unchanged.

**Backups.** Unchanged (database, shared paths, `.env`). For a Caddy front (phase 2), optionally back up `/var/lib/caddy/.local/share/caddy` so a rebuilt server doesn't re-issue everything (LE rate limits).

**Forge takeover and `server convert`.**
- Takeover stays nginx + FPM byte for byte; nothing here changes `import forge`.
- `server convert` (handing server modules to fornax) must **not** switch web server or runtime: it converts *ownership* of nginx/PHP config. A runtime or web-stack switch is a separate, explicit fleet edit after conversion.
- `site convert --only web` must refuse `runtime: frankenphp` in the same step (convert first, then switch the runtime).
- Forge sites that already run Octane via a supervisor daemon plus an nginx proxy to a port are the natural first candidates. Switching them to `runtime: frankenphp` removes the daemon and the TCP admin exposure.

**Tests.**
- Unit (templates, like the existing ones):
  - Caddyfile/unit generation for classic and worker;
  - socket ownership;
  - `admin` never TCP;
  - `env REMOTE_ADDR` and `HTTPS` set only with TLS;
  - the vhost proxy variant;
  - config errors (version mismatch, octane daemon on a frankenphp site, missing `frankenphp` block);
  - the deploy reload branch;
  - the transient preview config.
- OrbStack integration (`test/integration`):
  - provision with `frankenphp`, a Laravel site in worker mode and one classic;
  - deploy three times under oha load and assert **zero non-200** and the new release id;
  - prune releases including the boot release, then deploy again;
  - a broken release must fail the preview while live keeps serving;
  - isolation assertions as in §3.5.
- A **Hetzner VM run** for systemd sandboxing (`PrivateTmp`), which OrbStack can't show.

### 4.3 Phase 2: `web: caddy` (only if wanted)

- **Front.**
  - `/etc/caddy/Caddyfile` with global `admin unix//run/caddy/admin.sock`, `email`, optional `acme_ca`/`acme_ca_root` (Pebble), `servers { trusted_proxies static <cloudflare ranges from the fleet> }`, and an explicit catch-all;
  - `import /etc/caddy/sites/*.caddy`, one file per site (`file` resources, handler `caddy`: validate `caddy validate --config /etc/caddy/Caddyfile`, reload `systemctl reload caddy`; a rejected reload restores the previous files exactly as nginx does);
  - the caddy user is **added to `isolated`** (it needs no home access when all PHP sites are FrankenPHP).
- **TLS, two modes:**
  - `tls.manager: certbot` (default for `web: caddy`): certbot stays, webroot served by Caddy (`handle /.well-known/acme-challenge/* { root * /var/lib/fornax/acme; file_server }` on :80 *and* :443, as with Cloudflare today). Each site gets `tls <fullchain> <privkey>`, and the certbot deploy hook reloads Caddy. Plan visibility, SAN certificates, Cloudflare behaviour and Pebble tests stay as they are, and migration from nginx needs no new certificates. Needs read access for caddy to the key (group plus mode via the deploy hook, or a copy to `/etc/fornax/tls/`).
  - `tls.manager: caddy` (opt-in): the site address triggers automatic HTTPS. The plan line reads "Caddy obtains certificates for a, www.a (one per name, in the background)". Apply polls Caddy's storage for each name (timeout plus a clear error) so "apply succeeded" still means "HTTPS works". `ssl status` reads storage. Disallowed when the fleet marks a zone as Cloudflare-proxied (HTTP-01 breaks with "Always Use HTTPS").
- **Snippets.**
  - **New first-class fields for both web servers:** `basic_auth: [{user, password: <secret ref>}]` (hashed at apply time) and `allow: [<cidr>]`. These cover what the Forge converter produces today.
  - `caddy.snippets: [file]` imported inside the site block.
  - Sites with `nginx.server`/`nginx.http` snippets can't move to `web: caddy`. Plan fails with `config_invalid`, listing each snippet and pointing at the first-class fields. An agent can translate them, but fornax never does it silently.
- **Redirects / aliases / www.** `www.a, redirect.tld { redir https://a{uri} permanent }`, aliases in the site address, `proxies` as `ws.a { reverse_proxy 127.0.0.1:<port> }`.
- **Static-only and FPM sites under Caddy.** `file_server` / `php_fastcgi unix//run/php/php8.x-fpm-<slug>.sock { resolve_root_symlink }`. A preview socket block for FPM sites mirrors today's nginx preview (`resolve_root_symlink` avoids the realpath trap). Document the missing symlink protection, or require `runtime: frankenphp` for every PHP site on Caddy servers.
- **Logs.** `log { output file /var/log/caddy/<domain>-access.log { roll_size 100MiB roll_keep 4 } format json }`; `fornax logs <site> access` reads it.

## 5. Migration

- **Site by site, FPM → FrankenPHP (MVP), under nginx.** Edit the fleet with `runtime: frankenphp`, then plan. The plan shows the new ZTS packages (first site only), units, Caddyfile, shim and vhost change, then removes the pool. Apply order:
  1. packages (masking the default service);
  2. unit, socket and config, then start and wait for the socket;
  3. the vhost switch (nginx validate plus reload);
  4. FPM pool removal after nginx no longer points at it.

  Rollback is the reverse fleet edit. No certificate, webhook, snippet or DNS change, so it is low risk and can happen per site at any time.
- **nginx → Caddy (phase 2) is per server.** Only one process can own :80/:443, so the front can't be switched site by site.
  1. Translate snippets (plan refuses until done).
  2. Plan with `web: caddy` and `tls.manager: certbot`: the plan shows the whole nginx → Caddy swap.
  3. Apply in one script: install caddy (masked), write all site files, `caddy validate`, then `systemctl stop nginx && systemctl unmask --now caddy`. On failure: `systemctl stop caddy && systemctl start nginx` (automatic). The gap is about a second; certificates are reused.
  4. `fornax site check` before and after.
  5. Later, opt sites into `tls.manager: caddy` one by one, if at all.
- **Forge servers:** import, then convert (nginx kept), then optionally per-site `runtime: frankenphp`, then optionally `web: caddy`. Never combine steps.

## 6. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Worker-path pinning / realpath cache (§3.3) gets lost in a refactor | site outage after pruning, or stale code for 2 minutes | shim + restart are encoded in templates; integration test with pruning plus a load assertion |
| Admin API on TCP sneaks in (Octane command, a hand-added config, the package default) | site user takes over another site or the front | unit test on generated configs; mask `frankenphp.service`; `config_invalid` for `octane:` daemons on FrankenPHP sites; `fornax health` warns on a listener on `:2019` |
| Fast-moving FrankenPHP (breaking changes in minors, frequent security releases) | a surprise on upgrade; another component to patch | pin the minor in the fleet (`frankenphp.version: "1.13"` via apt preferences), upgrade deliberately via plan, CHANGELOG watch, `fornax health` shows versions |
| Third-party apt repo maintained by one person | supply chain, availability | pinned signing key; option to vendor `.deb`s; FPM remains the default and the fallback |
| One ZTS PHP version per server | can't run 8.4 and 8.5 FrankenPHP sites together | documented constraint; mix with FPM |
| PHP security patches (PHP2Shell-class) in two package sources, neither covered by unattended-upgrades | unpatched runtime | fornax-driven `php` upgrade path for both, version shown in `health` (also needed today for ondrej) |
| Memory per FrankenPHP site (45–250 MB) | small servers with many sites | per-site opt-in, `workers`/`threads` defaults low, plan shows an estimate |
| App not Octane-safe (state leaks, `$_ENV` not reset) | wrong data across requests | `worker: octane` is explicit opt-in, `max_requests` default 500, classic mode as a middle ground |
| ZTS-incompatible extensions (imap, newrelic, pcov) | crashes | refuse in config (known list) |
| systemd sandboxing untested in OrbStack | false confidence | one Hetzner VM test run per release |

## 7. Effort / phasing

| Phase | Content | Effort (one dev with agent help) |
| --- | --- | --- |
| **1 – MVP: FrankenPHP runtime behind nginx** | schema + validation and docs/config.md; php module (repo, mask, packages, ini, handler); site resources (units, socket, Caddyfile, shim, removal, pool swap); vhost proxy variant; release.ts (transient preview, reload branch, rollback, `health_check_contains`); `logs`; SECURITY.md/compatibility.md; unit tests; OrbStack integration incl. deploy-under-load and pruning; one Hetzner VM run | **7–9 days** |
| 2 – first-class `basic_auth`/`allow` | useful independently; prerequisite for Caddy | 2 days |
| 3 – `web: caddy` with certbot certificates | Caddyfile generation, handler, catch-all, webhook/ACME handles, FPM/static sites, logs, server migration plan + automatic fallback, tests | 8–10 days |
| 4 – `tls.manager: caddy` | storage polling in apply, `ssl status`, Cloudflare guard, Pebble tests | 3–4 days |

Recommendation: **do phase 1, consider phase 2 on its own merit, and leave 3–4 unbuilt** until someone has a concrete reason (HTTP/3, wanting to drop certbot, or a fleet that is already all FrankenPHP).

## 8. Open questions

Question 1 was answered on 2026-10-24: no app needs worker-mode throughput right now, so this waits until after 1.0. The rest are open until the work starts.

1. **Is there a real app that needs worker-mode throughput?** If no site is CPU/framework-bound, phase 1 is nice to have, not need to have. Which site would go first?
2. **Static files on FrankenPHP sites:** should nginx keep serving `/build/` etc. (faster, keeps `disable_symlinks`), or FrankenPHP everything (simpler, nginx never reads the home)?
3. **CLI for queues and cron on FrankenPHP sites:** `php-zts` (same build as web) or ondrej NTS of the same minor version?
4. **Trust in `pkg.henderkes.com`** (official, but run by one maintainer): acceptable, or vendor/mirror the `.deb`s?
5. **Is a Caddy front wanted at all?** If yes: is `tls.manager: certbot` (no TLS change) acceptable as the first step, given Caddy-managed ACME breaks behind Cloudflare "Always Use HTTPS"?
6. **Per-site memory:** is about 100–250 MB per FrankenPHP site acceptable on the current server sizes, or should fornax show a memory estimate in the plan?
7. **Unit naming:** `fornax-php-<slug>.{socket,service}` (per site) vs a per-user template like `fornax-redis@<user>` (one process for all sites of a user, so a deploy restarts the user's other sites too)?
8. Should **`health_check_contains`** (body check) become the default for new sites, independent of this feature?

---

## Appendix A — generated files (assembled from the tested spike configs)

`/etc/systemd/system/fornax-php-<slug>.socket`
```ini
[Socket]
ListenStream=/run/fornax-php/<slug>.sock
SocketUser=<user>
SocketGroup=<web server user: admin for nginx, caddy for Caddy>
SocketMode=0660
DirectoryMode=0755
Service=fornax-php-<slug>.service

[Install]
WantedBy=sockets.target
```

`/etc/systemd/system/fornax-php-<slug>.service`
```ini
[Unit]
Description=FrankenPHP of <domain> (fornax)
Requires=fornax-php-<slug>.socket
After=fornax-php-<slug>.socket network.target

[Service]
Type=notify
User=<user>
Group=<user>
Environment=XDG_DATA_HOME=/var/lib/fornax-php/<slug> XDG_CONFIG_HOME=/var/lib/fornax-php/<slug> GODEBUG=cgocheck=0
ExecStartPre=/usr/bin/frankenphp validate --config /etc/fornax/frankenphp/<slug>.caddyfile
ExecStart=/usr/bin/frankenphp run --config /etc/fornax/frankenphp/<slug>.caddyfile
StateDirectory=fornax-php/<slug>
StateDirectoryMode=0700
WorkingDirectory=/home/<user>
Restart=on-failure
RestartSec=2
TimeoutStopSec=30
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

`/etc/fornax/frankenphp/<slug>.caddyfile` (worker mode; classic drops the `worker` block and the `APP_*`/`LARAVEL_OCTANE`/`MAX_REQUESTS` env)
```caddyfile
{
	admin unix//var/lib/fornax-php/<slug>/admin.sock
	auto_https off
	persist_config off
	servers {
		trusted_proxies_unix
	}
	frankenphp {
		num_threads 4
		php_ini error_log /home/<user>/.fornax/php-error.log
	}
	log default {
		output stderr
		level WARN
	}
}
http:// {
	bind fd/3
	root /home/<user>/<domain>/current/public
	encode zstd gzip
	php_server {
		env HTTPS on                      # only for sites with TLS
		env REMOTE_ADDR {client_ip}
		env APP_BASE_PATH /home/<user>/<domain>/current
		env APP_PUBLIC_PATH /home/<user>/<domain>/current/public
		env LARAVEL_OCTANE 1
		env MAX_REQUESTS 500
		worker {
			file /home/<user>/<domain>/frankenphp-worker.php   # stable shim, never under releases/
			num 4
			match *
		}
	}
}
```

`/home/<user>/<domain>/frankenphp-worker.php` (shim, site-user-owned)
```php
<?php
// fornax: stable worker entry outside releases/ — resolves current/ at every worker (re)start
require "/home/<user>/<domain>/current/public/frankenphp-worker.php";
```

Deploy, worker restart (as root):
`curl -fsS --unix-socket /var/lib/fornax-php/<slug>/admin.sock -X POST http://localhost/frankenphp/workers/restart`

Install (ZTS repo, before the package so its default server never starts):
```bash
systemctl mask frankenphp.service
curl -fsSL https://pkg.henderkes.com/api/packages/85/debian/repository.key -o /etc/apt/keyrings/static-php85.asc
echo "deb [signed-by=/etc/apt/keyrings/static-php85.asc] https://pkg.henderkes.com/api/packages/85/debian php-zts main" > /etc/apt/sources.list.d/static-php85.list
apt-get update && apt-get install -y frankenphp php-zts-cli php-zts-{redis,igbinary,msgpack,intl,gd,zip,bcmath,pdo-mysql,mysqli,pdo-pgsql,pgsql,pdo-sqlite,sqlite3}
```

## Appendix B — sources

- Caddy docs: automatic-https, install, command-line, caddyfile/options, caddyfile/directives/{php_fastcgi, basic_auth, import}, caddyfile/matchers, api, conventions (fetched 2026-10-24; targeted passages read: errors/retries, storage, on-demand, testing, reload/adapt/validate, admin option, basic_auth, import, php_fastcgi expanded form, data/config dirs).
- FrankenPHP docs: index (install/packages), worker, laravel, known-issues, config, performance, production, static, metrics. GitHub releases v1.2.3–v1.13.3 (dates via the GitHub API).
- Caddy and Cloudflare HTTP-01: caddyserver/caddy#4735, caddy.community thread 20463.
- Laravel Octane 2.22.0 source: `bin/frankenphp-worker.php`, `bin/bootstrap.php`, `src/Commands/StartFrankenPhpCommand.php`, `src/Commands/stubs/Caddyfile`.
- fornax: README.md, SECURITY.md, docs/{deploys,servers,safety,compatibility,development}.md, src/modules/{site,server,deploy}.ts, src/remote/release.ts, src/core/{schema,resource}.ts, src/forge/{convert,vhost}.ts.
