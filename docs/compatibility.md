# Compatibility

From 1.0.0 on, fornax follows [semantic versioning](https://semver.org). Within a major version (1.x) everything on this page stays compatible: a minor release only adds, a patch release only fixes. What would break it waits for the next major version and is listed in the [changelog](../CHANGELOG.md) together with how to move over. Releases before 1.0 (0.x) make none of these promises.

## The fleet config

`fornax.yaml` carries the config version (`version: 2`; `CONFIG_VERSION` in `src/core/config-version.ts`). A fleet without `version:` is from before versions existed and counts as version 0.

- **Older configs keep loading.** fornax upgrades them in memory and says so on stderr (`note: this fleet config is version 1 …`). Nothing is written: commands that edit the fleet (`site add`, `site alias`, …) keep the file in its version. `fornax fleet upgrade` writes the upgrade, changing only the lines that change — review it with `git diff` and commit.
- **A newer config is refused** with `config_too_new`, never guessed at. Update fornax on every machine that works on a fleet before anyone runs `fornax fleet upgrade`.
- **A key never changes its meaning in place.** A rename or a new meaning is a new config version with an upgrade step; every later 1.x release loads every config version an earlier one wrote.
- **New keys are optional.** Minor releases may add keys with a default that keeps the old behaviour. Unknown keys are errors (`config_invalid`), so a fleet that uses a key added in 1.y needs fornax 1.y or newer.
- Secret references (`op://…`, `env:NAME`, `file:path`, `keychain:service`) are part of the format.

[Configuration](config.md) lists every key.

## Commands and options

- **Command names, arguments, options and their defaults stay.** New commands and options may be added; nothing is removed or renamed within 1.x.
- **Syntax:** long options only (`--name value` or `--name=value`); `-h` is `--help`. Lists take commas or repeat the option (`--site a,b` = `--site a --site b`). Switches are `--x`, `--no-x` or `--x=true|false`. An unknown option is an error, never ignored. The global options (`--json`, `--verbose`, `--fleet <dir>`, `--help`) work before or after the command; everything after `--` belongs to the command `fornax run` runs.
- **Commands never prompt.** What is missing is an error with a hint. The exceptions are `fornax shell` (interactive by design), `fornax fleet restore` (the recovery path: `ssh` and `age` may ask on the terminal), and the PIN and touch of a security key or the unlock of the 1Password app.
- **Commands fornax runs on servers** — `release`, `notify-test`, `hook serve`, `backup-agent run|snapshots|restore` — are hidden from help and not meant to be run by hand. Their arguments and JSON stay compatible within 1.x too, because the fornax on a server may be newer than the one that calls it (see [the binary on a server](#the-binary-on-a-server)).
- **Environment:** `FORNAX_FLEET` (the fleet outside a fleet repo; else `~/.config/fornax/fleet`), `FORNAX_REMOTE_BINARY` (the Linux build for servers) and `FORNAX_ACTOR` (the name in `/etc`'s history) are covered. Other `FORNAX_*` variables exist for tests and are not.

## `--json` output

- With `--json`, stdout carries exactly one JSON document: the result, or an error. Progress, notes and warnings go to stderr.
- **Fields are only added.** Within 1.x no field is removed, renamed or given another type (`null` included: a field that is never `null` does not become `null`). Read the fields you need and ignore the rest; the order of keys means nothing.
- The list commands (`server list`, `site list`, `provider list`, `provider catalog`) print an array (so does the internal `backup-agent snapshots`); every other command prints an object. `fornax shell` is interactive and has no `--json`.
- A result is never an error: an error is an object with both `error` and `code` (strings), and no result has both. Some results have one of them — a failed deploy carries its `error`, `run` its exit code as `code` — so check for `code` being a string, or for both keys. A result can still come with a non-zero exit code (a failed deploy, an unhealthy server; see [exit codes](#exit-codes)).
- The same rules hold for the command descriptions in `fornax agent-context --json`, `fornax help --json` and `fornax <command> --help --json`.

## Errors

With `--json` an error is printed to stdout:

```json
{ "error": "no site \"shop.example.com\" in fleet \"acme\"", "code": "unknown_site", "next": "fornax site list" }
```

Without `--json` it goes to stderr as `error [<code>]: <message>`, followed by `hint:` and `next:` lines. Either way the exit code is 1.

- **`code` is the contract.** A code keeps its meaning within 1.x; new codes may appear. Branch on `code`, never on the text.
- `error`, `hint` and `next` are for people (and agents) to read; their wording may change. `next`, when present, is the command that makes sense next.
- `details`, when present, carries data for that code (the issues of `config_invalid`, the provider id in `create_incomplete`) and follows the rules of `--json` output.
- `internal_error` means a bug in fornax: please report it.

| Code | Meaning |
| --- | --- |
| `unknown_command`, `unknown_option`, `unexpected_argument` | the command line names something that does not exist |
| `missing_argument`, `missing_option`, `missing_value` | something required was not given |
| `invalid_argument`, `invalid_option` | an argument or option has a value fornax cannot use |
| `confirmation_required` | a deleting command or plan needs `--confirm=<name>` |
| `no_fleet` | no `fornax.yaml` here, in a parent directory, in `$FORNAX_FLEET` or `~/.config/fornax/fleet` |
| `config_invalid` | the fleet config is not valid, or contradicts the server (YAML, a field, two sites on one user, a PHP version the server lacks, …) |
| `config_too_new` | the fleet was written by a newer fornax |
| `config_conflict` | two parts of the config manage the same file |
| `policy_violation`, `protected` | a policy in `fornax.yaml` forbids it (`allowed_repo_owners`, `protected`) |
| `outside_maintenance_window` | server changes outside `policies.maintenance_window` |
| `exists` | a server, site, name or file of that name is already there |
| `unknown_server`, `unknown_site`, `unknown_plan`, `unknown_provider`, `unknown_dns`, `unknown_forge_hook` | no such thing in the fleet (or plan, adapter, webhook) |
| `ambiguous`, `ambiguous_forge_hook` | several candidates; an option picks one |
| `no_backup`, `no_dns`, `no_fleet_copy`, `no_notify`, `no_onepassword`, `no_preview_domain`, `no_tailscale_api`, `no_tailscale_key` | the fleet has no configuration for this feature yet |
| `no_credentials`, `no_forge_token`, `no_github_token`, `no_ssh_key` | a credential the command needs is missing |
| `no_repo`, `deploy_disabled`, `no_deploy_key`, `no_webhook`, `not_set_up` | the site is not set up for this (yet): plan + apply, or the config |
| `not_github` | `git connect` works with GitHub only; elsewhere add the key and the webhook by hand |
| `no_env`, `no_local_env`, `no_key`, `no_history`, `no_logs`, `no_public_ip` | something the command reads does not exist (yet) |
| `no_terminal` | `fornax shell` needs a terminal |
| `not_in_ui` | `fornax ui` was asked for a command or option the dashboard does not offer (destroy-tier commands, `apply --confirm`, `shell`, `run` …) |
| `port_in_use`, `invalid_request` | `fornax ui` cannot listen on the given port; a dashboard request was not JSON |
| `implicit_fleet` | a write or destroy command outside any fleet repo would only have found `~/.config/fornax/fleet` by falling back to it — name the fleet (`--fleet`, `$FORNAX_FLEET`) or run it inside |
| `secret_unavailable`, `invalid_secret_ref` | a secret reference cannot be read, or is not one |
| `onepassword_failed`, `onepassword_busy` | the 1Password CLI failed, or another fornax has held it for minutes |
| `secrets_sync_failed` | the apply happened; copying its secrets to 1Password did not |
| `ssh_failed`, `ssh_timeout`, `ssh_key_invalid`, `security_key`, `sudo_failed` | connecting to the server failed (the hint says why) |
| `remote_failed`, `upload_failed`, `probe_failed` | a script or upload on the server failed |
| `unsupported_os`, `legacy_layout` | the server runs an unsupported OS, or was set up under fornax's old name (one full plan + apply moves it) |
| `plan_stale`, `plan_expired`, `upload_missing`, `apply_locked`, `nothing_to_apply` | the plan cannot be applied as it is: make a new one, or wait for the other apply |
| `apply_failed`, `validation_failed` | a step of the apply failed on the server (`details` names the step and the log), or nginx, PHP-FPM, sshd or sudoers rejected the new config and the previous files were restored |
| `nothing_to_bootstrap` | `server bootstrap` on a server that manages neither `base` nor `access` |
| `deploy_failed`, `rollback_failed`, `notify_failed`, `hook_unreachable` | a deploy left no result, a rollback or test notification failed, the webhook did not answer (a deploy that fails is a result with exit code 1, not an error) |
| `backup_failed`, `restore_failed`, `backup_error` | a backup or restore failed (`backup_error`: on the server) |
| `fleet_copy_failed`, `no_copy`, `not_empty`, `missing_tool` | storing or restoring a fleet copy failed |
| `not_supported` | the provider cannot do this through its API (the hint names its panel) |
| `provider_auth`, `provider_error`, `provider_not_found`, `provider_timeout`, `provider_unreachable` | the provider's (or Tailscale's) API refused, failed or did not answer |
| `create_incomplete`, `rename_incomplete` | `server create` / `server rename` stopped half way; the message says what exists already |
| `tailnet_policy_invalid`, `dns_zone_unknown`, `github_error` | Tailscale, Cloudflare or GitHub rejected the request |
| `forge_error`, `forge_ips`, `forge_sites_left`, `dump_incomplete`, `not_adopted`, `no_origin`, `convert_order`, `convert_incomplete`, `convert_unsupported_vhost` | leaving Forge: the Forge API, the order of conversions, parts fornax cannot carry over |
| `binary_missing`, `build_failed` | no Linux build of fornax for the server |
| `internal_error` | a bug in fornax |

A command may also pass on the code of what failed under it (`server create` reports an SSH failure as `ssh_failed`).

## Exit codes

| Exit code | Meaning |
| --- | --- |
| 0 | done; also `--help`, `help` and `--version` |
| 1 | an error (see above) — or a result that is not ok, listed below |
| 2 | `health`: something is critical |
| other | `run` and `shell` exit with the exit code of the command on the server |

Results with exit code 1, still printed as a result:

| Command | exits 1 when |
| --- | --- |
| `health` | something needs attention (warning; 2 when critical) |
| `deploy` | the deploy failed or was rolled back |
| `server bootstrap`, `server provision`, `server create` | the server is not in sync after three rounds |
| `tailnet status` | the tailnet differs from what the fleet wants |
| `backup status` | a site's last backup failed or is older than 26 hours |
| `backup run` | the backup of a site failed |
| `ssl status` | a server could not be read |
| `site check` | a request got no answer or a 5xx status |
| `fleet push` | the copy could not be stored on a server |

`plan`, `diff`, `dns status` and `env diff` exit 0 also when they find differences; read `in_sync` in their JSON.

## Permission tiers

Every command has a tier (`tier:` in its help, `tier` in `agent-context --json`):

- `read` never changes a server, a provider or another remote API, nor the fleet config. It may write local files: plans and `.env` copies under `.fornax/`, a server's host key on first contact.
- `write` changes servers, remote APIs or the fleet config.
- `destroy` deletes something and always needs `--confirm=<name of what it deletes>`.

**A command keeps its tier within 1.x**, and no `read` command starts changing anything — an allowlist of read commands stays safe across updates. New commands come with a tier of their own.

| Tier | Commands |
| --- | --- |
| `read` | `agent-context`, `server list`, `site list`, `server status`, `ssl status`, `logs`, `explain`, `tailnet status`, `health`, `secrets list`, `plan`, `diff`, `releases`, `git key`, `env pull`, `env diff`, `provider list`, `provider catalog`, `dns status`, `backup status`, `backup list`, `backup key`, `site check`, `history`, `fleet copies`, `ui` |
| `write` | `init`, `fleet upgrade`, `server add`, `site add`, `site alias`, `tailnet sync`, `secrets setup`, `secrets sync`, `apply`, `server bootstrap`, `server provision`, `notify test`, `deploy`, `rollback`, `git connect`, `env push`, `server create`, `server rename`, `server snapshot`, `server rdns`, `dns sync`, `import forge`, `detach forge`, `backup run`, `backup restore`, `site convert`, `shell`, `run`, `fleet push`, `fleet restore` |
| `destroy` | `site remove`, `server destroy`, `server reinstall` |

Some write commands delete only in one variant, and then need a confirmation too: `apply` (and the commands that apply: `server bootstrap`, `server provision`, `server create`, `server rename`) when the plan deletes something (`--confirm=<server>`), `backup restore --replace` (`--confirm=<site>`).

## On the servers

These paths and names keep their meaning within 1.x. Should one ever have to move, fornax moves existing servers over in a full plan + apply — as it did for the rename from anvil — and refuses other commands on a server that has not moved yet (`legacy_layout`).

| | |
| --- | --- |
| `/usr/local/bin/fornax` | fornax itself (on servers that deploy or back up) |
| `/usr/local/sbin/fornax-trigger` | the one command the webhook may run via sudo |
| `/etc/fornax/` | what fornax keeps on the server: deploy config per site (`sites/<domain>.json`), webhook secrets (`hook-secrets/`), generated secrets (`secrets/`, root only), certificates (`tls/<domain>/`), Redis configs (`redis/`), the backup config (`backup/`), pinned host keys (`known_hosts`) |
| `/var/lib/fornax/` | state: deploy requests, backup status and staging, restores, the fleet copy, ACME challenges |
| `/var/log/fornax/` | the script of every apply, with its output |
| `/var/log/fornax-sites/<user>/` | a site's daemon logs, and its deploy logs under `deploys/` |
| `/home/<user>/<domain>/` | the site: `releases/<YYYYMMDDHHMMSS>/`, `current` → the live release, `.env`, `auth.json` and the shared paths (e.g. `storage`) linked into each release. With `deploy.mode: in_place` the directory is the checkout itself. |
| `fornax-deploy@<domain>.service` | one deploy of a site (push-to-deploy and `fornax deploy`) |
| `fornax-hook.service` | the webhook receiver, run as the user `fornax-hook` |
| `fornax-backup.service`, `fornax-backup.timer` | the nightly backup |
| `fornax-redis@<user>.service` | a site's own Redis, socket `/run/fornax-redis/<user>/redis.sock` |

The content of these files, and of everything else fornax generates (vhosts, PHP-FPM pools, supervisor programs, cron and logrotate files), is not an interface: a release may change it, and `fornax plan` shows every such change before it is applied.

What your app repos and receivers see stays compatible as well:

- the build script `.fornax/deploy.sh` (or `deploy.script`), run with `FORNAX_SITE`, `FORNAX_SITE_PATH`, `FORNAX_RELEASE_PATH`, `FORNAX_PHP` and `FORNAX_COMPOSER`;
- the webhook at `https://<site>/.well-known/fornax-hook` (and `/fornax/hook/<site>` on a server's `webhook.domain`), signed like GitHub's (`X-Hub-Signature-256`);
- the JSON a `notify.webhook` receives — `{"event": "deploy", …}` with the fields of the deploy result, as in `fornax deploy --json` — and the GitHub commit status context `fornax/deploy`.

### The binary on a server

Servers that deploy or back up run the Linux build of the fornax you run (`FORNAX_REMOTE_BINARY`, else the file next to the fornax binary; a source checkout builds it into `dist/`). Each build carries its build time: `fornax --version --json` prints it as `build`.

- `apply` installs your build when the server's differs (by checksum).
- `deploy`, `rollback`, `backup run`, `backup restore` and `notify test` do the same first, so a fix in the deploy or backup code reaches the server without an apply. `server_binary: manual` in `fornax.yaml` leaves that to `apply`.
- **Never a downgrade:** a server whose build is newer than yours is left as it is (those commands say so on stderr; for `apply` it counts as in sync). A build without a build time counts as older than any build with one.
- The new file is uploaded to a staging path and installed over the old one; a deploy running at that moment finishes with the old one. Before `deploy` and the others it is checked against its checksum on the server and moved into place atomically. The webhook is restarted.

Because a server can run a newer fornax than the one calling it, the commands fornax runs there stay compatible within 1.x (see [commands](#commands-and-options)).

Everyone applying to the same fleet should run the same fornax, or a newer one: `plan` compares the server with what your fornax would generate, so an older one plans to undo what a newer one changed. Read the plan before you apply it.

## Not covered

- **Human-readable output:** wording, layout, colours, the order of lines. Parse `--json`, not the text.
- **Files under `.fornax/` in the fleet repo** (plans, `.env` copies, saved tailnet policies): internal, may change in any release.
- **Plan ids and plans:** a plan id is opaque, and a plan is for the fornax that made it, for 24 hours. Make a new plan after updating fornax.
- **The content of generated files on servers** (see above) and of the files under `/etc/fornax` and `/var/lib/fornax`.
- **Everything before 1.0.**
