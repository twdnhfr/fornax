/**
 * The Tailscale API (https://tailscale.com/api), with `tailscale.api_token` from the fleet config.
 * It takes the hand work out of a server's life in the tailnet: a one-off auth key to join, no key
 * expiry for servers, a new machine name on rename, the device gone when the server is.
 * Base URL overridable via FORNAX_TAILSCALE_API for tests.
 */
import { fail } from "./errors.ts";
import { secret, type Fleet } from "./fleet.ts";
import { api } from "../providers/http.ts";

export interface TailnetDevice {
  id: string;
  /** MagicDNS name, e.g. web-1.example-tailnet.ts.net */
  name: string;
  hostname: string;
  keyExpiryDisabled: boolean;
}

export class TailscaleApi {
  private readonly base = process.env.FORNAX_TAILSCALE_API ?? "https://api.tailscale.com/api/v2";
  constructor(private readonly token: string) {}

  private call<T>(method: string, path: string, body?: unknown) {
    return api<T>(this.base, this.token, method, path, body, "Tailscale");
  }

  /** A device by its MagicDNS name or its machine name (the first label). */
  async device(name: string): Promise<TailnetDevice | undefined> {
    const { devices } = await this.call<{ devices: TailnetDevice[] }>("GET", "/tailnet/-/devices");
    return devices.find((d) => d.name === name || d.name.split(".")[0] === name);
  }

  /** A single-use auth key, valid for an hour; with a tag, the device is the tag's, not the token user's. */
  async oneOffKey(description: string, tag?: string): Promise<string> {
    const r = await this.call<{ key: string }>("POST", "/tailnet/-/keys", {
      capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, ...(tag ? { tags: [tag] } : {}) } } },
      expirySeconds: 3600,
      description: description.replace(/[^\w -]/g, "-").slice(0, 50),
    });
    return r.key;
  }

  /** Servers do not log in again every few months: their node key never expires. */
  async disableKeyExpiry(id: string): Promise<void> {
    await this.call("POST", `/device/${id}/key`, { keyExpiryDisabled: true });
  }

  /** Set the machine name (and with it the MagicDNS name). */
  async rename(id: string, name: string): Promise<void> {
    await this.call("POST", `/device/${id}/name`, { name });
  }

  async remove(id: string): Promise<void> {
    await this.call("DELETE", `/device/${id}`);
  }

  async devices(): Promise<Array<TailnetDevice & { addresses: string[]; tags?: string[] }>> {
    return (await this.call<{ devices: Array<TailnetDevice & { addresses: string[]; tags?: string[] }> }>("GET", "/tailnet/-/devices")).devices;
  }

  async setTags(id: string, tags: string[]): Promise<void> {
    await this.call("POST", `/device/${id}/tags`, { tags });
  }

  /** The tailnet's DNS servers (the ones inside the tailnet are what servers must be allowed to reach). */
  async nameservers(): Promise<string[]> {
    return (await this.call<{ dns: string[] }>("GET", "/tailnet/-/dns/nameservers")).dns;
  }

  /** The policy file as written (HuJSON, comments kept). */
  async policy(): Promise<string> {
    const res = await fetch(`${this.base}/tailnet/-/acl`, { headers: { authorization: `Bearer ${this.token}`, accept: "application/hujson" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) fail(res.status === 401 || res.status === 403 ? "provider_auth" : "provider_error", `Tailscale GET /tailnet/-/acl: HTTP ${res.status}`);
    return res.text();
  }

  /** Check a policy without setting it; throws with Tailscale's reason. */
  async validatePolicy(text: string): Promise<void> {
    const r = await this.post("/tailnet/-/acl/validate", text);
    const body = r ? (JSON.parse(r) as { message?: string; data?: unknown }) : {};
    if (body.message) fail("tailnet_policy_invalid", `Tailscale rejects the policy: ${body.message}`, JSON.stringify(body.data ?? "").slice(0, 300));
  }

  async setPolicy(text: string): Promise<void> {
    await this.post("/tailnet/-/acl", text);
  }

  private async post(path: string, text: string): Promise<string> {
    const res = await fetch(`${this.base}${path}`, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/hujson" }, body: text, signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    if (!res.ok) fail("provider_error", `Tailscale POST ${path}: HTTP ${res.status} — ${body.slice(0, 300)}`);
    return body;
  }
}

/** The fleet's Tailscale API, if it has a token. */
export async function tailscaleApi(fleet: Fleet): Promise<TailscaleApi | undefined> {
  const ref = fleet.config.tailscale?.api_token;
  return ref ? new TailscaleApi(await secret(fleet, ref)) : undefined;
}
