import { afterAll, describe, expect, test } from "bun:test";
import { DigitalOcean } from "../../src/providers/digitalocean.ts";
import { HetznerCloud } from "../../src/providers/hetzner.ts";
import { Cloudflare } from "../../src/dns/index.ts";
import { FornaxError } from "../../src/core/errors.ts";
import { resolveSecret } from "../../src/core/secrets.ts";

const calls: string[] = [];
const droplet = {
  id: 7,
  name: "web",
  status: "active",
  size_slug: "s-1vcpu-1gb",
  region: { slug: "fra1" },
  networks: { v4: [{ ip_address: "10.0.0.2", type: "private" }, { ip_address: "203.0.113.7", type: "public" }], v6: [{ ip_address: "2001:db8::7", type: "public" }] },
};
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    calls.push(`${req.method} ${u.pathname}`);
    if (req.headers.get("authorization") !== "Bearer tok") return Response.json({ message: "Unable to authenticate you" }, { status: 401 });
    if (u.pathname === "/v2/account/keys" && req.method === "GET") return Response.json({ ssh_keys: [] });
    if (u.pathname === "/v2/account/keys") return Response.json({ ssh_key: { id: 42 } }, { status: 201 });
    if (u.pathname === "/v2/droplets" && req.method === "POST") {
      const b = (await req.json()) as { ssh_keys: number[]; image: string };
      expect(b.ssh_keys).toEqual([42]);
      expect(b.image).toBe("ubuntu-24-04-x64");
      return Response.json({ droplet }, { status: 202 });
    }
    if (u.pathname === "/v2/droplets/7") return Response.json({ droplet });
    if (u.pathname === "/v2/sizes") return Response.json({ sizes: [{ slug: "s-1vcpu-1gb", vcpus: 1, memory: 1024, disk: 25, price_monthly: 6, regions: ["fra1"], available: true }] });
    if (u.pathname === "/hz/servers/1") return Response.json({ server: { id: 1, name: "h", status: "running", public_net: { ipv4: { ip: "198.51.100.1" }, ipv6: { ip: "2001:db8:1::/64" } }, server_type: { name: "cax11", architecture: "arm" } } });
    return Response.json({ message: "nope" }, { status: 404 });
  },
});
afterAll(() => fake.stop(true));
const base = `http://127.0.0.1:${fake.port}`;

describe("DigitalOcean adapter", () => {
  test("create registers the key and maps the droplet", async () => {
    process.env.FORNAX_DIGITALOCEAN_API = `${base}/v2`;
    const s = await new DigitalOcean("tok").create({ name: "web", size: "s-1vcpu-1gb", location: "fra1", sshKeys: ["ssh-ed25519 AAAA test"], ubuntu: "24.04" });
    expect(s).toEqual({ id: "7", name: "web", status: "running", ipv4: "203.0.113.7", ipv6: "2001:db8::7", arch: "x86_64", size: "s-1vcpu-1gb", location: "fra1" });
    expect((await new DigitalOcean("tok").catalog())[0]!.memory_gb).toBe(1);
  });
  test("auth errors become provider_auth", async () => {
    try {
      await new DigitalOcean("wrong").get("7");
      throw new Error("should fail");
    } catch (e) {
      expect((e as FornaxError).code).toBe("provider_auth");
      expect((e as FornaxError).message).toContain("Unable to authenticate you");
    }
  });
});

describe("Hetzner adapter", () => {
  test("maps arch and the first IPv6 address of the /64", async () => {
    process.env.FORNAX_HETZNER_API = `${base}/hz`;
    const s = await new HetznerCloud("tok").get("1");
    expect(s.arch).toBe("arm64");
    expect(s.ipv6).toBe("2001:db8:1::1");
  });
});

describe("secrets", () => {
  test("env and file references resolve, literals are refused", async () => {
    process.env.FORNAX_TEST_SECRET = "abc";
    expect(await resolveSecret("env:FORNAX_TEST_SECRET", "/tmp")).toBe("abc");
    await expect(resolveSecret("hcloud_plaintext_token", "/tmp")).rejects.toThrow(/not a secret reference/);
    await expect(resolveSecret("keychain:fornax-definitely-missing-item", "/tmp")).rejects.toThrow(/no Keychain item/);
  });
});

describe("Cloudflare", () => {
  test("unknown zones fail with a hint", async () => {
    process.env.FORNAX_CLOUDFLARE_API = `${base}/cf`;
    await expect(new Cloudflare("tok", ["example.com"]).get("a.other.org", "A")).rejects.toThrow(/no Cloudflare zone/);
  });
});
