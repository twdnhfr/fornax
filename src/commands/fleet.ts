import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { commands, defineCommand, describeCommand, GLOBAL_OPTIONS } from "../core/command.ts";
import { CONFIG_VERSION, upgradesFrom } from "../core/config-version.ts";
import { fail } from "../core/errors.ts";
import { configVersion, findFleetDir, isSecretRef, loadFleet, policyViolations, readDoc, sites, upgradeText } from "../core/fleet.ts";
import { VERSION } from "../core/version.ts";

defineCommand({
  name: "init",
  summary: "create a new fleet repo (fornax.yaml, servers/, snippets/)",
  tier: "write",
  args: [{ name: "dir", help: "directory to create the fleet in", required: true }],
  options: {
    "fleet-name": { type: "string", help: "name of the fleet (default: directory name)" },
    access: { type: "string", help: "ssh | tailscale", default: "ssh" },
    "ssh-key": { type: "string", help: "the private key fornax logs in with: a file (~/.ssh/id_ed25519) or a secret reference (op://…, env:…, file:…) — default: your ssh-agent and ~/.ssh/config" },
  },
  examples: ["fornax init ./fleet --fleet-name acme", "fornax init ./fleet --fleet-name acme --ssh-key ~/.ssh/id_ed25519"],
  async run(input) {
    const dir = resolve(String(input.dir));
    if (existsSync(join(dir, "fornax.yaml"))) fail("exists", `${dir}/fornax.yaml already exists`);
    const name = String(input.fleetName ?? dir.split("/").pop());
    if (!["ssh", "tailscale"].includes(String(input.access))) fail("invalid_option", "--access must be ssh or tailscale");
    const key = input.sshKey === undefined ? undefined : String(input.sshKey);
    // a reference goes to ssh.key (loaded into fornax's own agent), a plain path to ssh.identity_file
    const keyLine = !key ? "" : isSecretRef(key) ? `  key: ${key}\n` : `  identity_file: ${key}\n`;
    mkdirSync(join(dir, "servers"), { recursive: true });
    mkdirSync(join(dir, "snippets"), { recursive: true });
    writeFileSync(
      join(dir, "fornax.yaml"),
      `# fornax fleet — run \`fornax agent-context\` for the layout and conventions
version: ${CONFIG_VERSION}
fleet: ${name}
access: ${input.access}

ssh:
  user: root
${keyLine || `  # the key fornax logs in with (default: your ssh-agent and ~/.ssh/config):
  # identity_file: ~/.ssh/id_ed25519            # a key file
  # key: op://Vault/fleet ssh/private key       # or a secret reference, held in fornax's own ssh-agent
`}
policies:
  # Only deploy repos of these owners (GitHub user/org). Remove to allow any.
  # allowed_repo_owners: [${name}]
  # Sites, databases or servers that fornax must never delete.
  protected: []

tls:
  issuer: letsencrypt
  # email: ops@example.com
`,
    );
    writeFileSync(join(dir, ".gitignore"), ".fornax/\n");
    // the fleet is meant to be versioned: review changes like code, see who wanted what
    const git = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--is-inside-work-tree"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0 ? "already in a git repo" : Bun.spawnSync(["git", "init", "-q", dir], { stdout: "ignore", stderr: "ignore" }).exitCode === 0 ? "git repo initialised" : "no git found — keep the fleet under version control yourself";
    return {
      data: { created: dir, fleet: name, git, ssh_key: key ?? null },
      human: `created fleet "${name}" in ${dir} (fornax.yaml, servers/, snippets/; ${git})\nnext: fornax server add <name> --host <ip-or-hostname>\noptional: fornax secrets setup   (1Password vault + service account: every credential fornax creates is stored there)`,
    };
  },
});

defineCommand({
  name: "fleet upgrade",
  summary: "write the fleet config in the current config version (older ones load as upgraded in memory) — edits the fleet repo, nothing on servers",
  tier: "write",
  examples: ["fornax fleet upgrade", "git diff   # review, then commit"],
  async run(_input, ctx) {
    const fleet = loadFleet(ctx);
    let file = join(fleet.dir, "fornax.yaml");
    const changes: string[] = [];
    // the file name from before the rename
    if (!existsSync(file) && existsSync(join(fleet.dir, "anvil.yaml"))) {
      renameSync(join(fleet.dir, "anvil.yaml"), file);
      changes.push("anvil.yaml → fornax.yaml");
    }
    const from = configVersion(readDoc(file), file);
    if (from === CONFIG_VERSION && !changes.length) return { data: { version: from, changes }, human: `the fleet config is already version ${from}` };
    const steps = upgradesFrom(from);
    for (const [path, kind] of [[file, "fleet"], ...[...fleet.files.values()].map((p) => [p, "server"])] as [string, "fleet" | "server"][]) {
      const text = readFileSync(path, "utf8");
      const next = upgradeText(text, from, kind);
      if (next !== text) writeFileSync(path, next);
    }
    changes.push(...steps.map((s) => s.summary));
    loadFleet(ctx); // the result must load
    return {
      data: { from, to: CONFIG_VERSION, changes },
      human: [`fleet config ${from} → ${CONFIG_VERSION}`, ...changes.map((c) => `  ${c}`), "review with git diff, then commit"].join("\n"),
    };
  },
});

defineCommand({
  name: "agent-context",
  summary: "everything an agent needs: conventions, commands with tiers, and the current fleet",
  tier: "read",
  examples: ["fornax agent-context", "fornax agent-context --json"],
  async run(_input, ctx) {
    const cmds = commands()
      .filter((c) => !c.internal && !c.humanOnly)
      .map(describeCommand);
    let fleet: unknown = null;
    const dir = ctx.fleetDir ?? findFleetDir(ctx.cwd);
    if (dir) {
      try {
        const f = loadFleet({ cwd: ctx.cwd, fleetDir: dir });
        fleet = {
          name: f.config.fleet,
          dir: f.dir,
          access: f.config.access,
          policies: f.config.policies,
          servers: [...f.servers.values()].map((s) => ({
            server: s.server,
            host: s.host,
            provider: s.provider.type,
            modules: s.modules,
            sites: sites(f, s).map((x) => x.domain),
            policy_violations: policyViolations(f, s),
          })),
        };
      } catch (e) {
        fleet = { error: (e as Error).message };
      }
    }
    const conventions = [
      "Run fornax inside a fleet repo (the directory with fornax.yaml), pass --fleet <dir>, or set $FORNAX_FLEET; elsewhere ~/.config/fornax/fleet is used when it exists.",
      "First setup of a server: `fornax server add` → `fornax server bootstrap` → `fornax site add` → `fornax server provision` (plans and applies everything in one go) → `fornax deploy <site>`. After that, every change: edit (or `site add`) → `fornax plan` → `fornax apply`.",
      "Tiers: read = safe to run any time; write = changes servers/APIs/config, ask the human first; destroy = also needs --confirm=<name>.",
      "Change servers in two steps: `fornax plan <server>` (read, prints a plan id) then `fornax apply <plan-id>` (write). Never edit managed files on a server by hand — edit the fleet repo.",
      "Add --json for structured output. Errors are {error, code, hint, next}; `next` is the command to run next.",
      "Commands never prompt. If something is missing they fail with a hint instead of waiting.",
      "Re-running a failed command is safe: everything is idempotent.",
      "Use `fornax explain <site|server>` for facts (paths, users, logs, certs) instead of guessing.",
      "Secrets (.env, passwords) never go into the fleet repo; .env lives on the server (`fornax env pull|push`).",
    ];
    const data = { version: VERSION, conventions, global_options: Object.keys(GLOBAL_OPTIONS).map((k) => `--${k}`), commands: cmds, fleet };
    const human = [
      `# fornax ${VERSION} — agent context`,
      "",
      "## Conventions",
      ...conventions.map((c) => `- ${c}`),
      "",
      "## Commands",
      ...cmds.map((c) => `- \`${c.command}${c.args.map((a) => (a.required ? ` <${a.name}>` : ` [${a.name}]`)).join("")}\` [${c.tier}] — ${c.summary}`),
      "",
      "## Fleet",
      fleet ? "```json\n" + JSON.stringify(fleet, null, 2) + "\n```" : "no fleet found from the current directory",
    ].join("\n");
    return { data, human };
  },
});

defineCommand({
  name: "server list",
  summary: "list the servers of this fleet",
  tier: "read",
  async run(_input, ctx) {
    const f = loadFleet(ctx);
    const rows = [...f.servers.values()].map((s) => ({
      server: s.server,
      host: s.host,
      provider: s.provider.type,
      php: s.php,
      sites: Object.keys(s.sites).length,
    }));
    const human = rows.length
      ? rows.map((r) => `${r.server.padEnd(20)} ${r.host.padEnd(28)} ${r.provider.padEnd(14)} php ${r.php.join(",").padEnd(10)} ${r.sites} sites`).join("\n")
      : "no servers yet — fornax server add <name> --host <ip>";
    return { data: rows, human };
  },
});

defineCommand({
  name: "site list",
  summary: "list sites, optionally of one server",
  tier: "read",
  args: [{ name: "server", help: "only this server" }],
  async run(input, ctx) {
    const f = loadFleet(ctx);
    const rows = [...f.servers.values()]
      .filter((s) => !input.server || s.server === input.server)
      .flatMap((s) =>
        sites(f, s).map((x) => ({ site: x.domain, server: s.server, user: x.user, php: x.php, preset: x.spec.preset, repo: x.spec.repo ?? null, state: x.spec.state })),
      );
    const human = rows.map((r) => `${r.site.padEnd(32)} ${r.server.padEnd(16)} ${r.preset.padEnd(8)} php ${r.php}  ${r.repo ?? "-"}${r.state === "absent" ? "  (absent)" : ""}`).join("\n") || "no sites";
    return { data: rows, human };
  },
});
