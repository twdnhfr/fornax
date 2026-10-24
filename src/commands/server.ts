import { defineCommand } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { getServer, loadFleet, writeServerFile } from "../core/fleet.ts";
import { assertServerName } from "../core/names.ts";
import { MODULES, SERVICES } from "../core/schema.ts";

defineCommand({
  name: "server add",
  summary: "add an existing server (bring your own, any provider) to the fleet config",
  tier: "write",
  args: [{ name: "name", help: "server name (lowercase, dashes)", required: true }],
  options: {
    host: { type: "string", help: "IP or hostname fornax connects to" },
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
    for (const s of services ?? []) if (!(SERVICES as readonly string[]).includes(s)) fail("invalid_option", `unknown service "${s}"`, `one of: ${SERVICES.join(", ")}`);
    const server: Record<string, unknown> = {
      server: name,
      host: String(input.host),
      provider: { type: String(input.provider), ...(input.providerId ? { id: String(input.providerId) } : {}) },
      php: input.php,
      modules,
      ...(services ? { services } : {}),
      sites: {},
    };
    const path = writeServerFile(fleet.dir, server);
    const runs = getServer(loadFleet(ctx), name).services;
    return {
      data: { created: path, server },
      human:
        `added ${name} → ${path}` +
        (modules.includes("data") ? `\nprovision installs: ${runs.join(", ")}${services ? "" : " (choose with --services, or services: in the file)"}` : "") +
        `\nnext: fornax server status ${name}` +
        (modules.length ? `, then fornax server bootstrap ${name}` : ""),
    };
  },
});
