import { fail } from "../core/errors.ts";
import { secret, type Fleet } from "../core/fleet.ts";
import type { Server } from "../core/schema.ts";
import { DigitalOcean } from "./digitalocean.ts";
import { HetznerCloud } from "./hetzner.ts";
import { NONE, type Capabilities, type Provider, type ProviderServer } from "./types.ts";

/** Any server you got yourself. fornax only needs root SSH; everything else happens in the provider's panel. */
class Manual implements Provider {
  readonly type: string;
  readonly capabilities: Capabilities = NONE;
  readonly panel: string;
  constructor(
    private readonly servers: Server[],
    type = "manual",
    panel = "your provider's control panel",
  ) {
    this.type = type;
    this.panel = panel;
  }
  async get(id: string): Promise<ProviderServer> {
    const s = this.servers.find((x) => String(x.provider.id ?? x.server) === id || x.server === id);
    if (!s) fail("provider_not_found", `no server ${id}`);
    return { id, name: s!.server, status: "unknown", ipv4: s!.public_ipv4 ?? null, ipv6: s!.public_ipv6 ?? null, arch: s!.arch };
  }
  async list() {
    return Promise.all(this.servers.filter((s) => s.provider.type === this.type).map((s) => this.get(s.server)));
  }
}

export const PROVIDERS: Record<string, { capabilities: Capabilities; panel: string; notes: string }> = {
  manual: { capabilities: NONE, panel: "your provider's control panel", notes: "any server with Ubuntu 24.04 and root SSH; order and delete it yourself" },
  "hetzner-cloud": { capabilities: new HetznerCloud("").capabilities, panel: "https://console.hetzner.cloud", notes: "API token with read/write access to the project" },
  digitalocean: { capabilities: new DigitalOcean("").capabilities, panel: "https://cloud.digitalocean.com", notes: "personal access token with write scope" },
  netcup: {
    capabilities: NONE,
    panel: "https://www.customercontrolpanel.de (order) and https://www.servercontrolpanel.de (reinstall, snapshots)",
    notes: "netcup servers cannot be ordered via API; order in the CCP, install Ubuntu 24.04 in the SCP, then `fornax server add --provider netcup`",
  },
};

export async function credentialsFor(fleet: Fleet, type: string, server?: Server): Promise<string> {
  const ref = server?.provider.credentials ?? fleet.config.provider_credentials[type];
  if (!ref) {
    fail("no_credentials", `no credentials for provider ${type}`, `set provider_credentials.${type} in fornax.yaml to a secret reference (op://…, env:NAME, file:path)`);
  }
  return secret(fleet, ref!);
}

export async function providerFor(fleet: Fleet, type: string, server?: Server): Promise<Provider> {
  switch (type) {
    case "hetzner-cloud":
      return new HetznerCloud(await credentialsFor(fleet, type, server));
    case "digitalocean":
      return new DigitalOcean(await credentialsFor(fleet, type, server));
    case "manual":
    case "netcup":
      return new Manual([...fleet.servers.values()], type, PROVIDERS[type]!.panel);
    default:
      return fail("unknown_provider", `unknown provider "${type}"`, `known: ${Object.keys(PROVIDERS).join(", ")}`);
  }
}

/** The answer when an adapter cannot do something: the manual way, as an error an agent can act on. */
export function notSupported(p: Provider, what: string, next?: string): never {
  return fail("not_supported", `${p.type} cannot ${what} via API`, `do it in ${p.panel}`, next);
}
