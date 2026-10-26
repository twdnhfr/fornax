# Security

## Reporting

Please report vulnerabilities privately (GitHub: "Report a vulnerability" on the repository), not in public issues. Include the fornax version (`fornax --version`) and what an attacker needs to start with.

## Threat model

fornax runs as root on your servers. What it trusts decides what an attacker has to break.

| | trusted? | why |
| --- | --- | --- |
| Your machine and the fleet repo | **yes** | The fleet repo is code: review changes to it like code. Whoever can edit it or `.fornax/plans/` can run anything as root on every server, by design. |
| Secret stores (1Password, Keychain, env, files) | **yes** | References are resolved on your machine only while applying. |
| SSH to the servers | **yes, after first contact** | Host keys are pinned on first use (see limits). |
| **Site code and site users** | **no** | A site's app, its dependencies and its build scripts may be compromised. They run as the site's own Linux user. |
| **Webhook callers** | **no** | The internet reaches `https://<site>/.well-known/fornax-hook` (and `/fornax/hook/<site>` on a server's `webhook.domain`). |
| Git hosts | partly | GitHub's host key is pinned; what the repo contains runs as the site user only. |

### What fornax guarantees

1. **A site user cannot become root.** Root never acts inside a site's home: directories, `.env`, `auth.json`, deploy keys, `env push`, log reads, `git`, configured `files`/`retire`, the probes that look at them and deletes there run as the site user, a file there must belong to that user, and root refuses to write or delete any path that leads into a home through a symlink. A home whose user is gone is not looked into at all (`home_without_user`) — only a site purge removes it, as a whole (`asUser` in `src/core/shell.ts`, `asSite` in `src/remote/release.ts`). Logs root writes for a site — supervisor daemons, deploys — live in `/var/log/fornax-sites/<user>/`, root-owned, readable by the site's group. Symlinks a site user plants in its home only ever reach what that user may read anyway.
2. **A site user cannot run as a system account.** Site users must not be system, database, fornax or admin accounts (`config_invalid`), and an existing account with a UID below 1000 is never taken over or deleted.
3. **Fleet values cannot break out of the config they are written to.** Every field takes only the characters its job needs; only file contents, deploy commands and notes may span lines. A cron line, supervisor program or nginx directive cannot be smuggled in through a value.
4. **Sites are separated from each other** (with the limits below): one Linux user per site, `/home/<user>` closed to the `isolated` group, one PHP-FPM pool per site, one database user per site, one Redis server per site, and nginx does not follow a symlink to a file of another owner (`disable_symlinks if_not_owner`).
5. **With Tailscale, a server is no way into the rest of the tailnet.** Servers join tagged (`tag:server`), not as one of your devices; `fornax tailnet sync` gives them nothing in the tailnet but its DNS servers and what `tailscale.allow` lists, and no SSH anywhere. (ufw does not filter tailnet traffic: tailscaled accepts it first — the tailnet policy is the firewall there.)
6. **The webhook triggers deploys and nothing else.** HMAC-SHA256 over the raw body with a 32-byte secret per site, compared in constant time; the webhook runs as `fornax-hook` (no home, systemd `ProtectHome`) and may only start `fornax-trigger` via sudo. A request carries no more than a commit id, which is checked before use and deployed only while it is the head of the branch. A request without a well-formed signature is refused before its body is read; bodies are read up to 25 MB, at most four at a time.
7. **With a security key, your laptop alone is not root on a server.** `ssh.root_keys` makes root's `authorized_keys` exactly that list — keys other tools (or a provider) added are removed on every apply. `tailscale.ssh_server: false` turns Tailscale SSH off, so the tailnet no longer lets any of your devices in as root; sshd does, with those keys only. With a FIDO2 key (`ssh.security_key`, made `-O verify-required`), each connection needs the key plugged in, its PIN and a touch — malware on your machine can use the key only while you are touching it, and cannot copy it.
8. **A server cannot read, or forge, the fleet repo it keeps.** With `fleet_copy` each server stores the fleet repo encrypted to age recipients it does not hold, with a manifest signed by the fleet's SSH key; `fleet restore` refuses copies whose signature does not hold and takes the newest valid one, so a broken-into server can delete its copy but not plant a fleet of its own.
9. **Secrets stay out of plans, argv and the fleet repo.** Plans store references and hashes; values are passed through the environment of the apply script (never to site users) and written with shell builtins, so they do not show up in `ps`. Generated secrets live in `/etc/fornax/secrets` (root-only) and, if configured, in 1Password.
10. **What fornax installs as root is checked against what it knows.** APT repository keys must have the fingerprints built into fornax (also on every plan, for keyrings already there); Bun is installed only when its zip matches the checksums signed by Bun's release key, which fornax carries; Composer's installer is checked against its published SHA-384 in a directory only root can write.

## Known limits

- **The shared Redis and memcached are shared.** Every PHP site gets a Redis of its own by default (a server run as the site user, reachable only through a socket in that user's directory). Sites on `redis.instance: shared` — the default for sites adopted from Forge, until their `.env` is switched — use one Redis with one password, and memcached has no authentication: those sites can read and write each other's cache, sessions and queues.
- **A node app listens on a TCP port on 127.0.0.1** (frameworks like Next.js cannot listen on a unix socket), and so does a `proxies` target: other sites' code on the same server can talk to it directly, past the basic auth and IP rules nginx applies. The app runs as its own user like any site; keep anything it must not answer to anyone behind its own authentication. An app bound to all interfaces is warned about in its deploy log and `fornax health` (ufw keeps it off the internet, not off the tailnet).
- **Files a site leaves world-readable** can be read by other sites' PHP through paths outside `/home` (e.g. `/tmp`). Keep secrets in `.env` (0640) and in the site's home.
- **Host keys are trusted on first use**, for servers and for the Storage Box (whose password `sshpass` sends at first contact). Make the first contact over a network you trust, or put the host keys in `known_hosts` yourself.
- **The plan file is executed as stored.** `fornax apply <id>` checks that the server has not changed since the plan, not that `.fornax/plans/<id>.json` is unchanged — protect the fleet directory like the fleet repo.
- **/etc's history (`fornax history`) is kept on the server itself.** It explains changes by fornax, packages and hand; it is no evidence after a break-in — whoever has root can rewrite it. Private keys and generated secrets are excluded from it; `/etc/shadow` (password hashes) is tracked as etckeeper does by default, readable by root only, and never shown by `fornax history --show`.
- **A security key protects new connections, not open ones.** fornax keeps one connection per server open for `ssh.keep_open` (default 10 minutes, ControlPersist) so a run asks for one touch per server; while it is open, whoever runs as you on your machine can use it. Lose the key and you lose root: register a second key in `ssh.root_keys`, and keep the provider's rescue system (with the fleet key) as the way back in.
- **The fleet key signs the fleet copies.** Whoever holds `ssh.key` (the fleet's 1Password vault, or fornax's agent while it runs) can sign a copy that restore accepts. And age-plugin-fido2-hmac calls itself experimental before 1.0 — keep a paper key among the recipients.
- **Webhook requests can be replayed**: a recorded, validly signed push starts a deploy again — of the branch's current head, never of the older commit it named (GitHub signs the body only, so its delivery ID cannot tell a replay from a redelivery).
- **The Composer installer and Bun come from their projects' current releases**: a checksum or signature proves they are what the project published, not that the project was not compromised.
- **`notify.webhook` is stored as written** in the fleet repo and in the root/webhook-readable deploy config on the server. For webhook URLs that carry a token, prefer ntfy with `notify.ntfy.token` (a secret reference).
- Sites adopted from Forge keep Forge's vhosts, pools and supervisor configs byte for byte until they are converted (`fornax site convert`); the guarantees above apply to what fornax generates.

## For contributors

- Never act as root on a path below `/home/<user>` — not even to test or read it: use `asUser` (shell) or `asSite` (release), and `asHomeUser`/`homeCheck` for probes, which refuse instead of falling back to root when the user is gone. `dir()`, `file()` and `absent()` do it for paths in a home (and refuse an owner other than that home's user); `fornax_nohome` stops root's writes and deletes that lead into a home. `test/integration/home-paths.test.ts` runs the generated scripts against planted symlinks.
- Nothing downloaded runs or is trusted as root unchecked: a pinned fingerprint, a signature by a key fornax carries, or a published checksum — and never in a directory others can write (`mktemp -d`, not `/tmp/<name>`).
- Root writes site logs only below `/var/log/fornax-sites/`.
- Quote every value with `q()`; add a schema check for every new field that reaches a config file or the shell.
- Secrets go into resources as references (`env:` on the resource), never as values in `apply` or `content` — or mark the resource `sensitive`.
