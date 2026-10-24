import { defineCommand } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { loadFleet, writeServerFile } from "../core/fleet.ts";
import { MODULES } from "../core/schema.ts";

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
  },
  examples: ["fornax server add web-1 --host 203.0.113.10", "fornax server add old-forge --host 203.0.113.11 --adopt --php 8.3,8.4"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const name = String(input.name);
    if (fleet.servers.has(name)) fail("exists", `server "${name}" already exists`, undefined, `fornax explain ${name} --offline`);
    if (!input.host) fail("missing_option", "--host is required", "the IP or hostname fornax connects to with SSH");
    const modules = input.modules ? (input.modules as string[]) : input.adopt ? [] : [...MODULES];
    for (const m of modules) if (!(MODULES as readonly string[]).includes(m)) fail("invalid_option", `unknown module "${m}"`, `one of: ${MODULES.join(", ")}`);
    const server: Record<string, unknown> = {
      server: name,
      host: String(input.host),
      provider: { type: String(input.provider), ...(input.providerId ? { id: String(input.providerId) } : {}) },
      php: input.php,
      modules,
      sites: {},
    };
    const path = writeServerFile(fleet.dir, server);
    return {
      data: { created: path, server },
      human: `added ${name} → ${path}\nnext: fornax server status ${name}` + (modules.length ? `, then fornax server bootstrap ${name}` : ""),
    };
  },
});
