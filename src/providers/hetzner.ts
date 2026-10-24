import { api } from "./http.ts";
import type { CatalogEntry, CreateSpec, Provider, ProviderServer } from "./types.ts";

interface HServer {
  id: number;
  name: string;
  status: string;
  public_net: { ipv4: { ip: string } | null; ipv6: { ip: string } | null };
  server_type: { name: string; architecture?: string };
  datacenter?: { location?: { name: string } };
}

const toServer = (s: HServer): ProviderServer => ({
  id: String(s.id),
  name: s.name,
  status: s.status,
  ipv4: s.public_net.ipv4?.ip ?? null,
  // Hetzner reports the /64; the first address is the server's.
  ipv6: s.public_net.ipv6?.ip ? s.public_net.ipv6.ip.replace(/::\/64$/, "::1") : null,
  arch: s.server_type.architecture === "arm" ? "arm64" : "x86_64",
  size: s.server_type.name,
  location: s.datacenter?.location?.name,
});

/** Hetzner Cloud (https://docs.hetzner.cloud). Base URL overridable via FORNAX_HETZNER_API for tests. */
export class HetznerCloud implements Provider {
  readonly type = "hetzner-cloud";
  readonly capabilities = { create: true, destroy: true, reinstall: true, snapshot: true, rdns: true, catalog: true };
  readonly panel = "https://console.hetzner.cloud";
  private readonly base = process.env.FORNAX_HETZNER_API ?? "https://api.hetzner.cloud/v1";
  constructor(private readonly token: string) {}

  private call<T>(method: string, path: string, body?: unknown) {
    return api<T>(this.base, this.token, method, path, body, "Hetzner Cloud");
  }

  async get(id: string) {
    return toServer((await this.call<{ server: HServer }>("GET", `/servers/${id}`)).server);
  }

  /** Delete (and rebuild) protection on or off. While another action runs (right after ordering) Hetzner answers "locked": wait it out. */
  async protect(id: string, on: boolean) {
    for (let i = 0; ; i++) {
      try {
        await this.call("POST", `/servers/${id}/actions/change_protection`, { delete: on, rebuild: on }); // Hetzner wants both, always the same
        return;
      } catch (e) {
        if (i >= 60 || !/locked/i.test((e as Error).message)) throw e;
        await Bun.sleep(2000);
      }
    }
  }

  async list() {
    return (await this.call<{ servers: HServer[] }>("GET", "/servers?per_page=50")).servers.map(toServer);
  }

  /** Hetzner wants registered key ids; register the ones it does not know yet. */
  private async keyIds(keys: string[]): Promise<number[]> {
    const known = (await this.call<{ ssh_keys: Array<{ id: number; public_key: string }> }>("GET", "/ssh_keys?per_page=50")).ssh_keys;
    const ids: number[] = [];
    for (const k of keys) {
      const material = k.trim().split(/\s+/).slice(0, 2).join(" ");
      const hit = known.find((x) => x.public_key.trim().split(/\s+/).slice(0, 2).join(" ") === material);
      if (hit) ids.push(hit.id);
      else {
        const name = `fornax-${new Bun.CryptoHasher("sha256").update(material).digest("hex").slice(0, 10)}`;
        ids.push((await this.call<{ ssh_key: { id: number } }>("POST", "/ssh_keys", { name, public_key: k.trim() })).ssh_key.id);
      }
    }
    return ids;
  }

  async create(spec: CreateSpec) {
    const ssh_keys = await this.keyIds(spec.sshKeys);
    const res = await this.call<{ server: HServer }>("POST", "/servers", {
      name: spec.name,
      server_type: spec.size,
      location: spec.location,
      image: `ubuntu-${spec.ubuntu}`,
      ssh_keys,
      start_after_create: true,
      labels: { "managed-by": "fornax" },
    });
    return toServer(res.server);
  }

  async rename(id: string, name: string) {
    await this.call("PUT", `/servers/${id}`, { name });
  }

  async destroy(id: string) {
    await this.protect(id, false);
    await this.call("DELETE", `/servers/${id}`);
  }

  async reinstall(id: string) {
    // a protected server cannot be rebuilt: lift the protection for it and put it back as it was
    const was = (await this.call<{ server: { protection?: { delete: boolean } } }>("GET", `/servers/${id}`)).server.protection?.delete ?? false;
    if (was) await this.protect(id, false);
    await this.call("POST", `/servers/${id}/actions/rebuild`, { image: "ubuntu-24.04" });
    if (was) await this.protect(id, true);
  }

  async snapshot(id: string, description: string) {
    const r = await this.call<{ image: { id: number } }>("POST", `/servers/${id}/actions/create_image`, { type: "snapshot", description });
    return String(r.image.id);
  }

  async rdns(id: string, ip: string, ptr: string) {
    await this.call("POST", `/servers/${id}/actions/change_dns_ptr`, { ip, dns_ptr: ptr });
  }

  async catalog(): Promise<CatalogEntry[]> {
    const r = await this.call<{
      server_types: Array<{ name: string; cores: number; memory: number; disk: number; architecture: string; deprecated?: boolean; prices: Array<{ location: string; price_monthly: { gross: string } }> }>;
    }>("GET", "/server_types?per_page=50");
    return r.server_types
      .filter((t) => !t.deprecated)
      .map((t) => ({
        size: t.name,
        arch: t.architecture === "arm" ? ("arm64" as const) : ("x86_64" as const),
        cpus: t.cores,
        memory_gb: t.memory,
        disk_gb: t.disk,
        monthly: t.prices.length ? Math.min(...t.prices.map((p) => Number(p.price_monthly.gross))) : null,
        currency: "EUR",
        locations: t.prices.map((p) => p.location),
      }));
  }
}
