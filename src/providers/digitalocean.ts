import { api } from "./http.ts";
import type { CatalogEntry, CreateSpec, Provider, ProviderServer } from "./types.ts";

interface Droplet {
  id: number;
  name: string;
  status: string;
  size_slug: string;
  region?: { slug: string };
  networks: { v4: Array<{ ip_address: string; type: string }>; v6: Array<{ ip_address: string; type: string }> };
}

const toServer = (d: Droplet): ProviderServer => ({
  id: String(d.id),
  name: d.name,
  status: d.status === "active" ? "running" : d.status,
  ipv4: d.networks.v4.find((n) => n.type === "public")?.ip_address ?? null,
  ipv6: d.networks.v6.find((n) => n.type === "public")?.ip_address ?? null,
  arch: "x86_64",
  size: d.size_slug,
  location: d.region?.slug,
});

/** DigitalOcean (https://docs.digitalocean.com/reference/api/). Base URL overridable via FORNAX_DIGITALOCEAN_API. */
export class DigitalOcean implements Provider {
  readonly type = "digitalocean";
  // PTR records follow the droplet name; there is no separate API for them.
  readonly capabilities = { create: true, destroy: true, reinstall: true, snapshot: true, rdns: false, catalog: true };
  readonly panel = "https://cloud.digitalocean.com";
  private readonly base = process.env.FORNAX_DIGITALOCEAN_API ?? "https://api.digitalocean.com/v2";
  constructor(private readonly token: string) {}

  private call<T>(method: string, path: string, body?: unknown) {
    return api<T>(this.base, this.token, method, path, body, "DigitalOcean");
  }

  async get(id: string) {
    return toServer((await this.call<{ droplet: Droplet }>("GET", `/droplets/${id}`)).droplet);
  }

  async list() {
    return (await this.call<{ droplets: Droplet[] }>("GET", "/droplets?per_page=200")).droplets.map(toServer);
  }

  private async keyIds(keys: string[]): Promise<number[]> {
    const known = (await this.call<{ ssh_keys: Array<{ id: number; public_key: string }> }>("GET", "/account/keys?per_page=200")).ssh_keys;
    const ids: number[] = [];
    for (const k of keys) {
      const material = k.trim().split(/\s+/).slice(0, 2).join(" ");
      const hit = known.find((x) => x.public_key.trim().split(/\s+/).slice(0, 2).join(" ") === material);
      ids.push(hit ? hit.id : (await this.call<{ ssh_key: { id: number } }>("POST", "/account/keys", { name: "fornax", public_key: k.trim() })).ssh_key.id);
    }
    return ids;
  }

  async create(spec: CreateSpec) {
    const ssh_keys = await this.keyIds(spec.sshKeys);
    const r = await this.call<{ droplet: Droplet }>("POST", "/droplets", { name: spec.name, region: spec.location, size: spec.size, image: `ubuntu-${spec.ubuntu.replace(".", "-")}-x64`, ssh_keys, ipv6: true, tags: ["fornax"] });
    return toServer(r.droplet);
  }

  async destroy(id: string) {
    await this.call("DELETE", `/droplets/${id}`);
  }

  async reinstall(id: string) {
    await this.call("POST", `/droplets/${id}/actions`, { type: "rebuild", image: "ubuntu-24-04-x64" });
  }

  async snapshot(id: string, description: string) {
    const r = await this.call<{ action: { id: number } }>("POST", `/droplets/${id}/actions`, { type: "snapshot", name: description });
    return String(r.action.id);
  }

  async catalog(): Promise<CatalogEntry[]> {
    const r = await this.call<{ sizes: Array<{ slug: string; vcpus: number; memory: number; disk: number; price_monthly: number; regions: string[]; available: boolean }> }>("GET", "/sizes?per_page=200");
    return r.sizes
      .filter((s) => s.available)
      .map((s) => ({ size: s.slug, arch: "x86_64" as const, cpus: s.vcpus, memory_gb: s.memory / 1024, disk_gb: s.disk, monthly: s.price_monthly, currency: "USD", locations: s.regions }));
  }
}
