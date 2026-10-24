# Contributing

Bug reports, fixes and features are welcome. fornax runs as root on other people's servers, so changes are held to a few rules — they are below, together with how to build, test and document a change.

Security problems are not reported here: see [SECURITY.md](SECURITY.md).

## Building and running from source

You need [Bun](https://bun.sh) 1.3 or newer (CI uses 1.3.14) on macOS or Linux. fornax uses Bun only — no npm, yarn or pnpm.

```bash
git clone https://github.com/twdnhfr/fornax && cd fornax
bun install
bun src/cli.ts --help                # or: bun run fornax -- --help
alias fornax="bun $PWD/src/cli.ts"   # use the checkout as your fornax
bun run build                        # release binaries in dist/ (all four targets)
```

Run from a checkout, fornax builds the Linux binary it puts on servers into `dist/` by itself whenever the sources are newer (`FORNAX_REMOTE_BINARY` points it at another one).

To try a command without touching a server, give it a fleet of its own:

```bash
fornax init "$TMPDIR/fleet" --fleet-name acme
fornax server add web-1 --host 203.0.113.10 --php 8.5 --fleet "$TMPDIR/fleet"
```

Where things are:

| | |
| --- | --- |
| `src/cli.ts` | argument parsing, output, error handling |
| `src/commands/` | one file per command group; each command is a `defineCommand` with a tier |
| `src/core/` | fleet loading, the schema (`schema.ts`), resources, plans, SSH, shell quoting, secrets |
| `src/modules/` | what a server and a site should look like, as resources |
| `src/remote/` | what runs on the server: deploys, the webhook, backups |
| `src/providers/`, `src/dns/`, `src/githost/` | Hetzner, DigitalOcean, Cloudflare, GitHub |
| `src/forge/` | taking over Forge servers |
| `skills/fornax/SKILL.md` | the skill agents load to use fornax |
| `test/unit/`, `test/integration/`, `test/live/` | the three test tiers below |

## Tests

```bash
bun run typecheck
bun run test          # unit tests
```

Both must pass for every change; CI runs them on every push and pull request, and also checks that the release build compiles for every target.

**Unit tests** (`test/unit/`) run offline in seconds: fake provider APIs, a fake `op` (`test/support/fake-op`), fixtures. Anything that can be tested without a server should be tested here — generated configs, schema checks, plans, parsing, error codes.

**Integration tests** (`test/integration/`) run the real thing against Ubuntu machines on [OrbStack](https://orbstack.dev) — no cloud, no cost, macOS only. They need a dev key and a base machine per Ubuntu version:

```bash
mkdir -p .dev && ssh-keygen -t ed25519 -N '' -f .dev/id_ed25519   # .dev/ is git-ignored
orb create ubuntu:noble fornax-base                                 # Ubuntu 24.04
orb create ubuntu:resolute fornax-base-2604                         # Ubuntu 26.04, for FORNAX_E2E_UBUNTU=26.04
```

Install `openssh-server` on each and put `.dev/id_ed25519.pub` into root's `authorized_keys`; the tests clone these machines and never change them. Then `bun run test:int` (see [development](docs/development.md) for the 26.04 run). Changes to what fornax does on a server — modules, deploys, backups, the Forge takeover — should pass the integration tests, and add to them where unit tests cannot reach.

**Live tests** (`test/live/`) order real servers at Hetzner and cost money. Run them only with throwaway infrastructure: a cloud project, a 1Password vault and DNS names (the test uses sslip.io and Let's Encrypt staging) that hold nothing else. How to run them is at the top of `test/live/hetzner.ts`. Never point any test at servers or accounts that matter.

## Design rules

These hold throughout the code. A change that breaks one will be asked to change.

- **Every change to a server's configuration goes through plan → apply.** What a server should look like is a list of resources (`src/core/resource.ts`): a probe that prints the current state, the desired state, and a script that gets there. Configuration is never edited with ad-hoc SSH: `fornax apply` runs a saved plan, and `server bootstrap` / `server provision` plan and apply until the server is in sync. What is not configuration — deploys, rollbacks, `run`, `env push`, backups and restores, life-cycle steps such as joining the tailnet or renaming a server — runs as a command of its own with a `write` tier, never as a side effect of `plan`. Changes to nginx, PHP-FPM, sshd and sudoers go through a handler that validates before it reloads.
- **Resources are idempotent.** Applying a plan and planning again gives an empty plan, and re-running a failed command is safe. `apply` refuses with `plan_stale` when the server changed since the plan. A step that creates something the app owns checks again at apply time and keeps what exists by then (a site's `.env`).
- **Root never acts inside a site's home.** Anything below `/home/<user>` runs as that user: `asUser` (`src/core/shell.ts`) or `asSite` (`src/remote/release.ts`); `dir()` and `file()` do it for you. Root writes site logs only below `/var/log/fornax-sites/`. See "For contributors" in [SECURITY.md](SECURITY.md).
- **Quote every value, check every field.** Every value that reaches the shell goes through `q()` (file contents through `emit()`). Every new config field gets a check in `src/core/schema.ts` that admits only the characters its job needs — no line breaks outside free text — so a value cannot break out of the cron line, supervisor program or nginx directive it is written to. Give each key a `/** … */` comment and run `bun run docs`.
- **The CLI is agent-first.**
  - Every command declares a tier: `read` never changes a server or remote API, `write` changes servers, remote APIs or the fleet config, and `destroy` deletes something and takes `--confirm=<name>`.
  - Commands never prompt: what is missing is an error with a hint. The few exceptions (`fornax shell`, `fleet restore`, security key PIN and touch) are listed in compatibility.md.
  - With `--json` stdout carries exactly one JSON document; progress goes to stderr (`ctx.log`).
  - Errors are `fail(code, message, hint, next)`: a stable `code` to branch on, and in `next` the command that makes sense next.
  - Options are long options only; `-h` is the one exception.
- **Compatibility is promised.** [docs/compatibility.md](docs/compatibility.md) says what stays stable: config keys, command names and options, JSON fields, error and exit codes, tiers, the layout on servers. Add, do not rename or remove. A config key that changes its name or meaning needs a new config version with an upgrade step (`src/core/config-version.ts`). New commands and error codes go into that page — a unit test fails until they do.
- **Secrets are references.** The fleet holds `op://…`, `env:`, `file:` or `keychain:` references, resolved only while applying. A resource that needs a secret names it in `env` and the value travels in the apply script's environment — never in argv, a plan, a resource's `apply` or `content` (or mark the resource `sensitive`).
- **No lock-in.** What fornax writes on a server is ordinary nginx, PHP-FPM, supervisor, cron and certbot configuration that keeps working without fornax. There is no central service: the server runs the same binary for webhooks, deploys and backups.
- **No personal data** in code, tests, fixtures, docs or commit messages: no real host names, domains, IP addresses, user names, vault names or tokens. Use `example.com`, `web-1`, `203.0.113.x` and `acme`.

## Documenting a change

A change is finished when the people and agents using fornax can find out about it:

- **[CHANGELOG.md](CHANGELOG.md):** a bullet under the unreleased version at the top for everything a user notices — new behaviour, a fix, a changed default. Say what is different for them, not how it is coded.
- **[docs/](docs/):** the page the change belongs to. `docs/config.md` is generated from the schema — change the doc comment in `src/core/schema.ts` and run `bun run docs`; a unit test fails while it is out of date. `docs/compatibility.md` lists every command with its tier and every error code.
- **[skills/fornax/SKILL.md](skills/fornax/SKILL.md):** whatever changes how an agent should use fornax — a new command it would run, an error code it has to react to, a rule it must follow. The conventions `fornax agent-context` prints are in `src/commands/fleet.ts`.
- **[SECURITY.md](SECURITY.md):** when the change touches what fornax guarantees or a known limit.

## Commits and pull requests

- One logical change per commit, with its tests and docs in the same commit.
- The subject is one line of plain English that says what changed, optionally led by the area: `apply: never downgrade fornax on a server`, `Config reference generated from the schema`. Explain the why in the body when it is not obvious.
- Before you open a pull request: `bun run typecheck && bun run test`, and the integration tests when you changed what happens on a server. The pull request template has the checklist.
- For a larger feature or a change to the config format, open an issue first so the design can be agreed on before you build it.

## License

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE) of this project.
