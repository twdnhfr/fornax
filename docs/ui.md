# Local dashboard

```bash
fornax ui                      # random free port, opens the browser
fornax ui --no-open --port 7700
```

`fornax ui` starts a small web server on your machine and prints a link with a token in it. It runs until Ctrl-C, or stops by itself after 30 minutes without requests. Starting it changes nothing (tier `read`); every action in it carries the tier of the command it runs.

The CLI stays the interface for agents and scripts. The dashboard is for humans who would rather look and click — and it is a layer over the very same commands, not a second implementation: each button runs a command through fornax's command registry in the same process, with the CLI's argument checks, tiers, errors (`code`, `hint`, `next`) and output. Each card shows the command line it ran, so everything can be repeated or scripted in a terminal.

## What it shows

| | |
| --- | --- |
| **Overview** | the fleet, its servers (host, provider, PHP, sites) and sites — read from the fleet config, no SSH |
| **Server** | `server status`, `health`, `ssl status`, `backup status`, `plan` |
| **Site** | `releases`, `logs` (kind, lines, grep), `plan --site`, `deploy` |
| **Fleet** | `health` for all servers, `ssl status` |
| **New site** | the fields of `fornax site add` → the plan for it → "Apply plan …" |

Long commands (status, health, plan, apply, deploy) stream their progress into the page as it happens. A plan is shown exactly as the CLI prints it; applying it takes an explicit click and a confirmation, and runs `fornax apply <id>` — which, as always, refuses if the server changed since the plan was made. A plan that deletes something is not applied from the dashboard: it shows the `fornax apply <id> --confirm=<server>` to run in a terminal. Destroy-tier commands (`site remove`, `server destroy`, `server reinstall`) are not offered at all.

With a hardware key (`ssh.security_key`), the PIN dialog and the touch work as on the CLI; the dashboard shows "Touch your security key" while SSH waits for it.

If the browser tab is closed while a command runs, the command still finishes (an apply never stops halfway); its output is then only in the server log, not in the page.

## How it is secured

- It listens on `127.0.0.1` only — nothing else on the network can connect.
- The link carries a random 256-bit token. The page trades it for an HttpOnly, SameSite=Strict cookie and removes it from the address bar; every request without the token or cookie is refused.
- Requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` are refused, so a web page cannot reach it through DNS rebinding.
- Every POST needs the header `X-Fornax: 1` and JSON, and a foreign `Origin` is refused — a cross-site form or image cannot start anything.
- Only a fixed list of commands and options can be run, and arguments are passed after `--`, so they can never become options.
- The page loads nothing from the internet (no CDN, no fonts); a strict Content-Security-Policy allows only its own script and stylesheet. Everything the server sends is rendered as text.

It runs with your permissions — your SSH keys, your 1Password session — like the CLI does. Keep the link to yourself, as you would a terminal.

## Development

The page is plain HTML and JavaScript in `src/ui/` (no framework, no build step for the code) and is embedded into the binary. The styles are Tailwind CSS, compiled ahead of time: `src/ui/input.css` → `src/ui/style.css` with `bun run ui:css`. The generated `style.css` is committed so that `bun src/cli.ts ui` works straight from a checkout; a unit test fails when it is out of date with `index.html` and `app.js`, and `scripts/build.sh` regenerates it before compiling.
