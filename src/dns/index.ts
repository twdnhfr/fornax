import { fail } from "../core/errors.ts";
import { secret, type Fleet } from "../core/fleet.ts";
import { api } from "../providers/http.ts";

export interface DnsRecord {
  id: string;
  type: "A" | "AAAA";
  name: string;
  content: string;
}

export interface Dns {
  readonly type: string;
  get(name: string, type: "A" | "AAAA"): Promise<DnsRecord[]>;
  /** Make `name` point to exactly `content` (creates, updates or removes extra records). */
  set(name: string, type: "A" | "AAAA", content: string): Promise<"created" | "updated" | "unchanged">;
}

/** Cloudflare DNS (https://developers.cloudflare.com/api/). Records are created "DNS only" (not proxied). */
export class Cloudflare implements Dns {
  readonly type = "cloudflare";
  private readonly base = process.env.FORNAX_CLOUDFLARE_API ?? "https://api.cloudflare.com/client/v4";
  private zones = new Map<string, string>();
  constructor(
    private readonly token: string,
    private readonly knownZones: string[] = [],
  ) {}

  private call<T>(method: string, path: string, body?: unknown) {
    return api<{ result: T }>(this.base, this.token, method, path, body, "Cloudflare").then((r) => r.result);
  }

  /** Zone of a name: the longest configured or existing zone that is a suffix of it. */
  private async zoneOf(name: string): Promise<string> {
    const labels = name.split(".");
    const candidates = labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
    for (const z of candidates) {
      if (this.zones.has(z)) return this.zones.get(z)!;
      if (this.knownZones.length && !this.knownZones.includes(z)) continue;
      const res = await this.call<Array<{ id: string; name: string }>>("GET", `/zones?name=${encodeURIComponent(z)}`);
      if (res.length) {
        this.zones.set(z, res[0]!.id);
        return res[0]!.id;
      }
    }
    return fail("dns_zone_unknown", `no Cloudflare zone for ${name}`, "the token must have Zone:Read + DNS:Edit on the zone");
  }

  async get(name: string, type: "A" | "AAAA") {
    const zone = await this.zoneOf(name);
    const r = await this.call<Array<{ id: string; type: "A" | "AAAA"; name: string; content: string }>>("GET", `/zones/${zone}/dns_records?type=${type}&name=${encodeURIComponent(name)}`);
    return r.map((x) => ({ id: x.id, type: x.type, name: x.name, content: x.content }));
  }

  async set(name: string, type: "A" | "AAAA", content: string) {
    const zone = await this.zoneOf(name);
    const existing = await this.get(name, type);
    if (existing.length === 1 && existing[0]!.content === content) return "unchanged" as const;
    const body = { type, name, content, ttl: 1, proxied: false };
    if (existing.length) {
      await this.call("PUT", `/zones/${zone}/dns_records/${existing[0]!.id}`, body);
      for (const extra of existing.slice(1)) await this.call("DELETE", `/zones/${zone}/dns_records/${extra.id}`);
      return "updated" as const;
    }
    await this.call("POST", `/zones/${zone}/dns_records`, body);
    return "created" as const;
  }
}

export async function dnsFor(fleet: Fleet): Promise<Dns> {
  const cfg = fleet.config.dns;
  if (!cfg) fail("no_dns", "this fleet has no DNS adapter", "add `dns: { type: cloudflare, credentials: op://… }` to fornax.yaml, or set the records by hand (see `fornax dns status`)");
  if (cfg!.type !== "cloudflare") fail("unknown_dns", `unknown DNS adapter "${cfg!.type}"`, "supported: cloudflare");
  return new Cloudflare(await secret(fleet, cfg!.credentials), cfg!.zones);
}
