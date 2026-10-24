/**
 * Local stand-ins for provider APIs. The fake Hetzner Cloud API "orders" a server by
 * cloning an OrbStack machine, so `fornax server create` → bootstrap → provision → deploy →
 * destroy runs end to end without any cloud account or cost.
 */

const orb = (...args: string[]) => {
  const p = Bun.spawnSync(["orb", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`orb ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};

export function machineIp(machine: string): string {
  try {
    return orb("-m", machine, "-u", "root", "bash", "-c", "ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1").trim();
  } catch {
    return "";
  }
}

interface FakeServer {
  id: number;
  name: string;
  machine: string;
  ip: string;
  deleteProtected?: boolean;
}

export function fakeHetzner(opts: { token: string; baseMachine: string; prefix: string }) {
  const servers = new Map<number, FakeServer>();
  const keys: Array<{ id: number; name: string; public_key: string }> = [];
  let next = 1000;
  const view = (s: FakeServer) => {
    // a fresh machine needs a moment for DHCP; until then it is "initializing", like at Hetzner
    if (!s.ip) s.ip = machineIp(s.machine);
    return viewOf(s);
  };
  const viewOf = (s: FakeServer) => ({
    id: s.id,
    name: s.name,
    status: s.ip ? "running" : "initializing",
    public_net: { ipv4: { ip: s.ip }, ipv6: null },
    server_type: { name: "cax11", architecture: "arm" },
    protection: { delete: Boolean(s.deleteProtected), rebuild: Boolean(s.deleteProtected) },
    datacenter: { location: { name: "nbg1" } },
  });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${opts.token}`) return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
      const u = new URL(req.url);
      const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : {};
      if (u.pathname === "/ssh_keys" && req.method === "GET") return Response.json({ ssh_keys: keys });
      if (u.pathname === "/ssh_keys" && req.method === "POST") {
        const k = { id: keys.length + 1, name: String(body.name), public_key: String(body.public_key) };
        keys.push(k);
        return Response.json({ ssh_key: k }, { status: 201 });
      }
      if (u.pathname === "/servers" && req.method === "POST") {
        const id = next++;
        const machine = `${opts.prefix}-${String(body.name)}`;
        orb("clone", opts.baseMachine, machine);
        orb("start", machine);
        const s = { id, name: String(body.name), machine, ip: machineIp(machine) };
        servers.set(id, s);
        return Response.json({ server: view(s), root_password: null }, { status: 201 });
      }
      if (u.pathname === "/servers" && req.method === "GET") return Response.json({ servers: [...servers.values()].map(view) });
      const protect = u.pathname.match(/^\/servers\/(\d+)\/actions\/change_protection$/);
      if (protect && req.method === "POST") {
        const s = servers.get(Number(protect[1]));
        if (!s) return Response.json({ error: { message: "not found" } }, { status: 404 });
        // like Hetzner: both fields, always the same value
        if (typeof body.delete !== "boolean" || body.delete !== body.rebuild) {
          return Response.json({ error: { code: "invalid_input", message: "'delete' and 'rebuild' field required to be the same value" } }, { status: 422 });
        }
        s.deleteProtected = body.delete;
        return Response.json({ action: { id: 2, status: "success" } }, { status: 201 });
      }
      const m = u.pathname.match(/^\/servers\/(\d+)$/);
      if (m) {
        const s = servers.get(Number(m[1]));
        if (!s) return Response.json({ error: { message: "not found" } }, { status: 404 });
        // like Hetzner: a protected server cannot be deleted
        if (req.method === "PUT") {
          const b = (await req.json()) as { name?: string };
          if (b.name) s.name = b.name;
          return Response.json({ server: view(s) });
        }
        if (req.method === "DELETE" && s.deleteProtected) return Response.json({ error: { code: "protected", message: "server is protected" } }, { status: 423 });
        if (req.method === "DELETE") {
          orb("delete", "-f", s.machine);
          servers.delete(s.id);
          return Response.json({ action: { id: 1 } });
        }
        return Response.json({ server: view(s) });
      }
      if (u.pathname === "/server_types") {
        return Response.json({
          server_types: [
            { name: "cax11", cores: 2, memory: 4, disk: 40, architecture: "arm", prices: [{ location: "nbg1", price_monthly: { gross: "4.5" } }] },
            { name: "cx23", cores: 2, memory: 4, disk: 40, architecture: "x86", prices: [{ location: "fsn1", price_monthly: { gross: "4.2" } }] },
          ],
        });
      }
      return Response.json({ error: { message: `no route ${req.method} ${u.pathname}` } }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, servers, keys, stop: () => server.stop(true) };
}

export function fakeCloudflare(opts: { token: string; zones: string[] }) {
  const records: Array<{ id: string; zone: string; type: string; name: string; content: string; proxied: boolean }> = [];
  let n = 1;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${opts.token}`) return Response.json({ success: false, errors: [{ message: "auth" }] }, { status: 403 });
      const u = new URL(req.url);
      const ok = (result: unknown) => Response.json({ success: true, result });
      if (u.pathname === "/zones") {
        const name = u.searchParams.get("name");
        return ok(opts.zones.filter((z) => z === name).map((z) => ({ id: `zone-${z}`, name: z })));
      }
      const m = u.pathname.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/);
      if (!m) return Response.json({ success: false, errors: [{ message: "route" }] }, { status: 404 });
      const [, zone, id] = m;
      if (req.method === "GET") return ok(records.filter((r) => r.zone === zone && (!u.searchParams.get("type") || r.type === u.searchParams.get("type")) && (!u.searchParams.get("name") || r.name === u.searchParams.get("name"))));
      if (req.method === "DELETE") {
        records.splice(records.findIndex((r) => r.id === id), 1);
        return ok({ id });
      }
      const body = (await req.json()) as { type: string; name: string; content: string; proxied: boolean };
      if (req.method === "POST") {
        const r = { id: `rec-${n++}`, zone: zone!, ...body };
        records.push(r);
        return ok(r);
      }
      const r = records.find((x) => x.id === id)!;
      Object.assign(r, body);
      return ok(r);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, records, stop: () => server.stop(true) };
}
