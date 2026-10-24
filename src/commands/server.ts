import { readFileSync, writeFileSync } from "node:fs";
import { defineCommand } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { assertPolicies, editServerFile, getServer, loadFleet, writeServerFile, type Fleet } from "../core/fleet.ts";
import { assertServerName } from "../core/names.ts";
import { everPlannedWhole } from "../core/plan.ts";
import { MODULES, SERVICES, type Server } from "../core/schema.ts";

/** How fornax logs in to a server, said where it is set up: user, port and key. */
export function loginLine(fleet: Fleet, s: Server): string {
  const user = s.ssh?.user ?? fleet.config.ssh.user;
  const port = s.ssh?.port ?? fleet.config.ssh.port;
  const key = fleet.config.ssh.key ? "the fleet key (ssh.key)" : fleet.config.ssh.identity_file ? `the key ${fleet.config.ssh.identity_file} (ssh.identity_file)` : "the keys in your ssh-agent";
  return `fornax logs in as ${user}@${s.host}${port !== 22 ? ` port ${port}` : ""} with ${key}`;
}

const assertServices = (services: string[]) => {
  for (const s of services) if (!(SERVICES as readonly string[]).includes(s)) fail("invalid_option", `unknown service "${s}"`, `one of: ${SERVICES.join(", ")}`);
};

defineCommand({
  name: "server add",
  summary: "add an existing server (bring your own, any provider) to the fleet config",
  tier: "write",
  args: [{ name: "name", help: "server name (lowercase, dashes)", required: true }],
  options: {
    host: { type: "string", help: "IP or hostname fornax connects to with SSH" },
    "ssh-user": { type: "string", help: "the user fornax logs in as (default: ssh.user in fornax.yaml — root); needs passwordless sudo if not root" },
    "ssh-port": { type: "number", help: "SSH port (default: ssh.port in fornax.yaml — 22)" },
    provider: { type: "string", help: "provider adapter (manual, hetzner-cloud, digitalocean, netcup)", default: "manual" },
    "provider-id": { type: "string", help: "server id at the provider" },
    php: { type: "list", help: "PHP versions", default: ["8.4"] },
    adopt: { type: "boolean", help: "existing server with software on it: manage no server modules until you opt in" },
    modules: { type: "list", help: `server modules to manage (${MODULES.join(",")})` },
    services: { type: "list", help: `what the server runs (${SERVICES.join(",")}); default: mysql,postgres,redis,supervisor,fail2ban — e.g. --services postgres,redis,supervisor,fail2ban leaves MySQL out` },
  },
  examples: ["fornax server add web-1 --host 203.0.113.10", "fornax server add old-forge --host 203.0.113.11 --adopt --php 8.3,8.4"],
  async run(input, ctx) {
    const name = String(input.name);
    assertServerName(name);
    const fleet = loadFleet(ctx);
    if (fleet.servers.has(name)) fail("exists", `server "${name}" already exists`, undefined, `fornax explain ${name} --offline`);
    if (!input.host) fail("missing_option", "--host is required", "the IP or hostname fornax connects to with SSH");
    const modules = input.modules ? (input.modules as string[]) : input.adopt ? [] : [...MODULES];
    for (const m of modules) if (!(MODULES as readonly string[]).includes(m)) fail("invalid_option", `unknown module "${m}"`, `one of: ${MODULES.join(", ")}`);
    const services = input.services as string[] | undefined;
    assertServices(services ?? []);
    const server: Record<string, unknown> = {
      server: name,
      host: String(input.host),
      provider: { type: String(input.provider), ...(input.providerId ? { id: String(input.providerId) } : {}) },
      php: input.php,
      modules,
      ...(services ? { services } : {}),
      ...(input.sshUser || input.sshPort ? { ssh: { ...(input.sshUser ? { user: String(input.sshUser) } : {}), ...(input.sshPort ? { port: Number(input.sshPort) } : {}) } } : {}),
      sites: {},
    };
    const path = writeServerFile(fleet.dir, server);
    const after = loadFleet(ctx);
    const runs = getServer(after, name).services;
    const login = loginLine(after, getServer(after, name));
    return {
      data: { created: path, server, login },
      human:
        `added ${name} → ${path}\n${login}` +
        (modules.includes("data") ? `\nprovision installs: ${runs.join(", ")}${services ? "" : " (choose with --services, or services: in the file)"}` : "") +
        `\nnext: fornax server status ${name}` +
        (modules.length ? `, then fornax server bootstrap ${name}` : ""),
    };
  },
});
defineCommand({
  name: "server set",
  summary: "change a server's settings in the fleet config (then `fornax plan` + `fornax apply`)",
  tier: "write",
  args: [{ name: "name", help: "server name", required: true }],
  options: {
    host: { type: "string", help: "IP or hostname fornax connects to with SSH" },
    "ssh-user": { type: "string", help: "the user fornax logs in as" },
    "ssh-port": { type: "number", help: "SSH port" },
    "public-ipv4": { type: "string", help: "the address visitors reach it at, when --host is another (a tailnet or private IP): DNS records, site check --via public" },
    php: { type: "list", help: "PHP versions, e.g. 8.4,8.5" },
    services: { type: "list", help: `what the server runs (${SERVICES.join(",")}) — the full list, e.g. --services redis,supervisor,fail2ban` },
  },
  examples: ["fornax server set web-1 --services redis,supervisor,fail2ban", "fornax server set web-1 --php 8.4,8.5", "fornax server set web-1 --ssh-user ubuntu"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.name));
    if (![input.host, input.sshUser, input.sshPort, input.publicIpv4, input.php, input.services].some((v) => v !== undefined)) fail("missing_option", "nothing to change", "pass one or more options, e.g. --services redis,supervisor,fail2ban", "fornax server set --help");
    assertServices((input.services as string[] | undefined) ?? []);
    const changed: string[] = [];
    const path = fleet.files.get(server.server)!;
    const before = readFileSync(path, "utf8");
    editServerFile(fleet, server.server, (doc) => {
      const set = (k: string[], v: unknown, label: string) => {
        doc.setIn(k, Array.isArray(v) ? doc.createNode(v) : v);
        changed.push(label);
      };
      if (input.host !== undefined) set(["host"], String(input.host), `host ${input.host}`);
      if (input.sshUser !== undefined) set(["ssh", "user"], String(input.sshUser), `ssh.user ${input.sshUser}`);
      if (input.sshPort !== undefined) set(["ssh", "port"], Number(input.sshPort), `ssh.port ${input.sshPort}`);
      if (input.publicIpv4 !== undefined) set(["public_ipv4"], String(input.publicIpv4), `public_ipv4 ${input.publicIpv4}`);
      if (input.php !== undefined) set(["php"], input.php, `php ${(input.php as string[]).join(", ")}`);
      if (input.services !== undefined) set(["services"], input.services, `services ${(input.services as string[]).join(", ")}`);
    });
    // the fleet as a whole decides (a site on a PHP version that goes, policies): a change it refuses is undone
    let after: Fleet;
    try {
      after = loadFleet(ctx);
      assertPolicies(after, getServer(after, server.server));
    } catch (e) {
      writeFileSync(path, before);
      throw e;
    }
    const s = getServer(after, server.server);
    const dropped = server.services.filter((x) => !s.services.includes(x));
    const notes = dropped.length ? [`${dropped.join(", ")} stay installed where they already run: fornax manages what the config names, and does not remove a service with its data`] : [];
    // a server not set up yet gets it all in one go; afterwards a change is planned and applied
    const fresh = !everPlannedWhole(after, s.server);
    const next = fresh ? `fornax server provision ${s.server}` : `fornax plan ${s.server}`;
    return {
      data: { server: s.server, file: path, changed, login: loginLine(after, s), notes, next },
      human: [...changed.map((c) => `~ ${c}`), loginLine(after, s), ...notes.map((n) => `note: ${n}`), `next: ${next}${fresh ? "   (not set up from this fleet repo yet: installs and configures everything)" : ", then fornax apply <plan-id>"}`].join("\n"),
    };
  },
});

