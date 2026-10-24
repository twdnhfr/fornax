import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { defineCommand, requireConfirm, type Context } from "../core/command.ts";
import { FornaxError, fail } from "../core/errors.ts";
import { fleetFile, getServer, isProtected, loadFleet, onePassword, secret, sites, writeServerFile, type Fleet } from "../core/fleet.ts";
import { backupEnabled } from "../modules/backup.ts";
import { MODULES, type Server } from "../core/schema.ts";
import { fleetAgent } from "../core/ssh-agent.ts";
import { runnerFor } from "../core/ssh.ts";
import { actor, etcCommit, etcCommitOutside, fleetRevision, fornaxMessage } from "../core/etc-history.ts";
import { assertServerName, serverName } from "../core/names.ts";
import { tailscaleApi } from "../core/tailscale.ts";
import { q } from "../core/shell.ts";
import { patchYaml } from "../core/yaml-patch.ts";
import { applyOptions, converge, securityUpdates } from "./converge.ts";
import { dnsFor } from "../dns/index.ts";
import { notSupported, providerFor, PROVIDERS } from "../providers/index.ts";
import { itemTitle } from "../core/onepassword.ts";
import { DISTROS, SUPPORTED_UBUNTU } from "../modules/common.ts";
import type { ProviderServer } from "../providers/types.ts";

defineCommand({
  name: "provider list",
  summary: "provider adapters and what each can do via API",
  tier: "read",
  async run() {
    const rows = Object.entries(PROVIDERS).map(([type, p]) => ({ type, ...p }));
    const human = rows
      .map((r) => `${r.type.padEnd(14)} ${Object.entries(r.capabilities).filter(([, v]) => v).map(([k]) => k).join(", ") || "no API — bring your own server"}\n${" ".repeat(15)}${r.notes}`)
      .join("\n");
    return { data: rows, human };
  },
});

defineCommand({
  name: "provider catalog",
  summary: "server sizes, architectures, locations and prices of a provider",
  tier: "read",
  args: [{ name: "provider", help: "provider type", required: true }],
  options: { arch: { type: "string", help: "only arm64 or x86_64" } },
  examples: ["fornax provider catalog hetzner-cloud --arch arm64"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const p = await providerFor(fleet, String(input.provider));
    if (!p.catalog) notSupported(p, "list server sizes");
    const items = (await p.catalog!()).filter((c) => !input.arch || c.arch === input.arch).sort((a, b) => (a.monthly ?? 0) - (b.monthly ?? 0));
    const human = items.map((c) => `${c.size.padEnd(14)} ${c.arch.padEnd(7)} ${String(c.cpus).padStart(2)} cpu ${String(c.memory_gb).padStart(4)} GB ${String(c.disk_gb).padStart(4)} GB disk  ${c.monthly ?? "?"} ${c.currency}/mo  ${c.locations.join(",")}`).join("\n");
    return { data: items, human };
  },
});

async function publicKeys(fleet: Fleet, extra?: string): Promise<string[]> {
  const keys = [...fleet.config.ssh.authorized_keys];
  // the fleet's own key (ssh.key): its public half straight from the agent that holds it
  const agent = fleetAgent(fleet);
  if (agent) {
    const listed = Bun.spawnSync(["ssh-add", "-L"], { env: { ...process.env, SSH_AUTH_SOCK: await agent }, stdout: "pipe" });
    keys.push(...listed.stdout.toString().split("\n").filter((l) => l.startsWith("ssh-")));
  }
  const id = fleet.config.ssh.identity_file;
  const candidates = [extra, id ? `${id}.pub` : undefined].filter((x): x is string => Boolean(x));
  for (const c of candidates) {
    const p = isAbsolute(c) ? c : join(fleet.dir, c);
    if (existsSync(p)) keys.push(readFileSync(p, "utf8").trim());
  }
  if (!keys.length) fail("no_ssh_key", "no public SSH key to give the new server", "pass --ssh-key <file.pub> or set ssh.authorized_keys in fornax.yaml");
  return [...new Set(keys)];
}

function knownHostsFile(fleet: Fleet): string {
  const f = fleet.config.ssh.known_hosts_file;
  return f ? (isAbsolute(f) ? f : join(fleet.dir, f)) : join(process.env.HOME ?? "~", ".ssh", "known_hosts");
}

export function forgetHostKeys(fleet: Fleet, hosts: string[]) {
  const file = knownHostsFile(fleet);
  if (!existsSync(file)) return;
  for (const h of hosts) Bun.spawnSync(["ssh-keygen", "-R", h, "-f", file], { stdout: "ignore", stderr: "ignore" });
}

/**
 * The server is now reached under another name (its tailnet name, a new name after a rename):
 * the host key known for `from` becomes the one for `to`. Names get recycled — a server destroyed
 * last week may have had `to`, and its key must not lock this one out; nor is the new name trusted
 * blindly: the key stays the one already seen.
 */
export function moveHostKey(fleet: Fleet, from: string, to: string) {
  const file = knownHostsFile(fleet);
  if (!existsSync(file) || from === to) return;
  const known = Bun.spawnSync(["ssh-keygen", "-F", from, "-f", file], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
  const keys = known.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/).slice(1).join(" "));
  forgetHostKeys(fleet, [to]);
  if (keys.length) appendFileSync(file, keys.map((k) => `${to} ${k}\n`).join(""));
}

async function waitForSsh(fleet: Fleet, server: Server, ctx: Context, timeoutS = 300): Promise<void> {
  const until = Date.now() + timeoutS * 1000;
  for (let i = 1; ; i++) {
    try {
      await runnerFor(fleet, server).run("cloud-init status --wait >/dev/null 2>&1 || true; true", { timeoutMs: 120_000 });
      return;
    } catch (e) {
      if (Date.now() > until) throw new FornaxError("ssh_timeout", `${server.server} did not accept SSH within ${timeoutS}s`, (e as Error).message);
      if (i === 1) ctx.log(`waiting for SSH on ${server.host} …`);
      await Bun.sleep(5000);
    }
  }
}

async function waitRunning(get: () => Promise<ProviderServer>, ctx: Context): Promise<ProviderServer> {
  for (let i = 0; i < 60; i++) {
    const s = await get();
    if (s.status === "running" && s.ipv4) return s;
    if (i === 0) ctx.log(`waiting for the server to start (${s.status}) …`);
    await Bun.sleep(3000);
  }
  return fail("provider_timeout", "server did not reach running within 3 minutes");
}

defineCommand({
  name: "server create",
  summary: "order a new server at a provider and provision it (with Tailscale: joined to the tailnet first); named for you unless you name it",
  tier: "write",
  args: [{ name: "name", help: "server name (default: two words like silent-comet, made up for you)" }],
  options: {
    provider: { type: "string", help: "provider type (see `fornax provider list`)", default: "hetzner-cloud" },
    size: { type: "string", help: "server type / size slug (see `fornax provider catalog`)" },
    location: { type: "string", help: "location / region" },
    php: { type: "list", help: "PHP versions (default: 8.4 on 24.04, 8.5 on 26.04)" },
    ubuntu: { type: "string", help: "Ubuntu LTS: 24.04 or 26.04 (26.04 has only PHP 8.5 until the ondrej PPA supports it)", default: "24.04" },
    "ssh-key": { type: "string", help: "extra public key file for root (the fleet key ssh.key, or ssh.identity_file + .pub, and ssh.authorized_keys are always given)" },
    "no-provision": { type: "boolean", help: "stop once the server is reachable (then: fornax server bootstrap / provision)" },
    ...applyOptions,
  },
  examples: ["fornax server create --size cax21 --location nbg1        # named for you, e.g. silent-comet", "fornax server create web-2 --size cax21 --location nbg1 --no-provision"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const p = await providerFor(fleet, String(input.provider));
    // without a name: two words like Forge's, not used in the fleet nor at the provider
    const name = input.name ? String(input.name) : serverName([...fleet.servers.keys(), ...(await p.list()).map((s) => s.name)]);
    assertServerName(name);
    if (fleet.servers.has(name)) fail("exists", `server "${name}" already exists in the fleet`);
    if (!input.name) ctx.log(`name: ${name}`);
    if (!p.create) notSupported(p, "order servers", `fornax server add ${name} --provider ${p.type} --host <ip>`);
    if (!input.size || !input.location) fail("missing_option", "--size and --location are required", undefined, `fornax provider catalog ${p.type}`);
    const ubuntu = String(input.ubuntu);
    if (!SUPPORTED_UBUNTU.includes(ubuntu)) fail("invalid_option", `--ubuntu must be one of ${SUPPORTED_UBUNTU.join(", ")}`);
    const php = (input.php as string[] | undefined) ?? [ubuntu === "24.04" ? "8.4" : DISTROS[ubuntu]!.systemPhp];
    // a Tailscale fleet joins the new server to the tailnet: the auth key must work before anything is ordered
    const tailnet = fleet.config.access === "tailscale";
    const authRef = fleet.config.tailscale?.auth_key;
    const ts = tailnet ? await tailscaleApi(fleet) : undefined;
    if (tailnet && !ts && !authRef) fail("no_tailscale_key", "this fleet reaches its servers through Tailscale, but has neither tailscale.api_token nor tailscale.auth_key", "best: an API access token in the fleet's vault as tailscale: { api_token: op://<vault>/<item>/credential } — or a reusable auth key with tag:server as tailscale: { auth_key: … }");
    // with the API: a single-use key for this one server (made now, so a token without the right scope fails before anything is ordered)
    // tagged (tag:server by default): a server is not one of your own devices, so it gets none of their rights
    const authKey = tailnet ? (ts ? await ts.oneOffKey(`fornax ${name}`, fleet.config.tailscale?.tag || undefined) : await secret(fleet, authRef!)) : undefined;
    ctx.log(`ordering ${name} (${input.size} in ${input.location}) at ${p.type} …`);
    const created = await p.create!({ name, size: String(input.size), location: String(input.location), sshKeys: await publicKeys(fleet, input.sshKey as string | undefined), ubuntu });
    // ordered (and billed) from here on: a failure before it is in the fleet names it, so nothing is left unknown
    let running: ProviderServer;
    try {
      running = await waitRunning(() => p.get(created.id), ctx);
    } catch (e) {
      throw new FornaxError("create_incomplete", `${name} was ordered at ${p.type} (id ${created.id}) but did not come up: ${(e as Error).message}`, `delete it in ${p.panel} (it is not in the fleet yet)`, undefined, { created: true, id: created.id });
    }
    const server: Record<string, unknown> = {
      server: name,
      host: running.ipv4!,
      public_ipv4: running.ipv4!,
      ...(running.ipv6 ? { public_ipv6: running.ipv6 } : {}),
      provider: { type: p.type, id: running.id },
      ...(running.arch ? { arch: running.arch } : {}),
      php,
      modules: [...MODULES],
      sites: {},
    };
    const path = writeServerFile(fleet.dir, server);
    // Providers recycle IPs: a known_hosts entry for a server ordered seconds ago is stale by definition.
    forgetHostKeys(fleet, [running.ipv4!, ...(running.ipv6 ? [running.ipv6] : [])]);
    // from here on the server exists (and costs money): every failure says so and how to get rid of it
    const stuck = (e: unknown, what: string): never => {
      throw new FornaxError(
        (e as FornaxError).code ?? "create_incomplete",
        `${name} was created at ${p.type} (id ${running.id}, ${running.ipv4}) and is running — but ${what}: ${(e as Error).message}`,
        (e as FornaxError).hint,
        `fornax server destroy ${name} --confirm=${name}`,
        { created: true, id: running.id, ipv4: running.ipv4, file: path },
      );
    };
    // only now that it is in the fleet: a stray click in the console (or API call) cannot delete it; `server destroy` lifts this
    if (p.protect) {
      try {
        await p.protect(running.id, true);
      } catch (e) {
        stuck(e, "turning on the delete protection failed");
      }
    }
    let after = loadFleet(ctx);
    try {
      await waitForSsh(after, getServer(after, name), ctx);
    } catch (e) {
      stuck(e, "SSH did not come up");
    }
    let host = running.ipv4!;
    let keyExpiryOff = false;
    if (tailnet) {
      // the auth key travels in the script (SSH stdin) into tailscale's stdin: never in argv, on disk or in cloud metadata
      ctx.log(`joining ${name} to the tailnet …`);
      try {
        const out = await runnerFor(after, getServer(after, name)).run(`set -e
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
printf %s ${q(authKey!)} | tailscale up --ssh=${fleet.config.tailscale?.ssh_server !== false} --hostname=${q(name)} --auth-key=file:/dev/stdin
tailscale status --json`);
        const self = (JSON.parse(out.stdout) as { Self?: { DNSName?: string } }).Self;
        if (!self?.DNSName) throw new Error("tailscale reports no name for the server");
        host = self.DNSName.replace(/\.$/, "");
      } catch (e) {
        stuck(e, "joining the tailnet failed");
      }
      // from now on fornax reaches it through the tailnet — and must, before the firewall closes the public SSH port
      writeFileSync(path, patchYaml(readFileSync(path, "utf8"), (doc) => doc.set("host", host)));
      // Tailscale SSH shows the server's own host key: the one just seen on the public address
      moveHostKey(fleet, running.ipv4!, host);
      after = loadFleet(ctx);
      try {
        await waitForSsh(after, getServer(after, name), ctx, 120);
      } catch (e) {
        stuck(e, `Tailscale SSH to ${host} does not work (an auth key with a tag, or an ACL without "root"?) — nothing is closed yet, the fleet key still works on ${running.ipv4}`);
      }
      // a server must not drop out of the tailnet when its node key would expire in a few months
      if (ts) {
        try {
          const dev = await ts.device(host);
          if (dev) await ts.disableKeyExpiry(dev.id);
          keyExpiryOff = Boolean(dev);
        } catch (e) {
          ctx.log(`warning: could not turn off key expiry for ${name}: ${(e as Error).message}`);
        }
      }
    }
    if (input.noProvision) {
      return {
        data: { server: name, provider: p.type, id: running.id, host, ipv4: running.ipv4, ipv6: running.ipv6, file: path, next: `fornax server provision ${name}` },
        human: `${name} is up at ${host} (${p.type} id ${running.id}, delete-protected), added to ${path}\nnext: fornax server provision ${name}`,
      };
    }
    ctx.log(`provisioning ${name} …`);
    let result: Awaited<ReturnType<typeof converge>>;
    try {
      result = await converge(after, getServer(after, name), { modules: [], sites: [] }, input, ctx);
    } catch (e) {
      return stuck(e, "provisioning failed (run it again with: fornax server provision " + name + ")");
    }
    // the provider's image is months behind: security updates now, and the reboot they may need while nothing runs yet
    let updates: Awaited<ReturnType<typeof securityUpdates>> | undefined;
    try {
      updates = await securityUpdates(after, getServer(after, name), ctx);
      if (updates.reboot) {
        ctx.log(`rebooting ${name} for the updates …`);
        await runnerFor(after, getServer(after, name)).run("systemd-run --quiet --on-active=2 systemctl reboot", { allowFail: true });
        await Bun.sleep(15_000);
        await waitForSsh(after, getServer(after, name), ctx, 300);
      }
    } catch (e) {
      stuck(e, "installing the security updates failed (it is provisioned; run: fornax server bootstrap " + name + ")");
    }
    return {
      data: { server: name, provider: p.type, id: running.id, host, ipv4: running.ipv4, ipv6: running.ipv6, file: path, ...(tailnet ? { key_expiry_disabled: keyExpiryOff } : {}), provision: result, security_updates: updates },
      human: `${name} is ready at ${host} (${p.type} id ${running.id}, delete-protected): ${result.applied} changes, ${result.in_sync ? "in sync" : `${result.remaining.length} still differ — fornax plan ${name}`}${tailnet ? `\nreachable through Tailscale only; the fleet key is off the server again (it stays in the vault for the next one)${keyExpiryOff ? "; its node key never expires" : `\nTailscale admin → Machines → ${name}: "Disable key expiry", or it drops out of the tailnet when its node key expires`}` : ""}\nconfig: ${path}`,
      exitCode: result.in_sync ? 0 : 1,
    };
  },
});

defineCommand({
  name: "server destroy",
  summary: "delete a server at its provider and remove it from the fleet",
  tier: "destroy",
  args: [{ name: "server", help: "server name", required: true }],
  options: {
    "keep-config": { type: "boolean", help: "keep servers/<name>.yaml" },
    "keep-secrets": { type: "boolean", help: "leave the server's 1Password item as it is (default: archive it)" },
  },
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    if (isProtected(fleet, server.server)) fail("protected", `${server.server} is protected by policy`, "remove it from policies.protected first");
    const live = sites(fleet, server).filter((s) => s.spec.state === "present");
    for (const s of live) if (isProtected(fleet, s.domain)) fail("protected", `${server.server} hosts the protected site ${s.domain}`);
    requireConfirm(input, server.server);
    const p = await providerFor(fleet, server.provider.type, server);
    if (!p.destroy) notSupported(p, "delete servers", "delete it in the panel, then remove servers/<name>.yaml");
    if (!server.provider.id) fail("config_invalid", `${server.server} has no provider.id`);
    // out of the tailnet, so no dead machine stays behind in the Tailscale admin (best effort):
    // with the API the device is removed, without it the server at least logs itself out
    let leftTailnet = false;
    // deleted in the provider's panel already: what is left is the cleanup (tailnet, host keys, fleet, 1Password)
    const gone = await p.get(String(server.provider.id)).then(
      () => false,
      (e) => (e as FornaxError).code === "provider_not_found",
    );
    const ts = fleet.config.access === "tailscale" ? await tailscaleApi(fleet) : undefined;
    const device = ts ? await ts.device(server.host).catch(() => undefined) : undefined;
    if (fleet.config.access === "tailscale" && !device && !gone) {
      // (delayed: the logout cuts the Tailscale SSH session it was started from)
      try {
        leftTailnet = (await runnerFor(fleet, server).run("systemd-run --quiet --on-active=2 tailscale logout", { timeoutMs: 20_000, allowFail: true })).code === 0;
        if (leftTailnet) await Bun.sleep(6000);
      } catch {}
    }
    if (!gone) await p.destroy!(String(server.provider.id));
    // its names and addresses will belong to other servers one day: no stale host keys left behind
    forgetHostKeys(fleet, [server.host, ...(server.public_ipv4 ? [server.public_ipv4] : []), ...(server.public_ipv6 ? [server.public_ipv6] : [])]);
    if (device) {
      try {
        await ts!.remove(device.id);
        leftTailnet = true;
      } catch {}
    }
    const file = fleet.files.get(server.server)!;
    if (!input.keepConfig) rmSync(file);
    // The server is gone; its secrets go to the 1Password archive (restorable there), not to the bin.
    let secrets: { archived: boolean; item: string; error?: string } | null = null;
    const op = fleet.config.onepassword;
    if (op && !input.keepSecrets) {
      const item = itemTitle(fleet.config.fleet, server.server);
      try {
        const client = await onePassword(fleet);
        await client.adoptLegacyTitle(item, op.vault);
        secrets = { archived: await client.archive(item, op.vault), item: `${op.vault}/${item}` };
      } catch (e) {
        secrets = { archived: false, item: `${op.vault}/${item}`, error: (e as Error).message };
      }
    }
    const warn = secrets?.error ? `\nwarning: could not archive op://${secrets.item} (${secrets.error}) — archive it in 1Password by hand` : "";
    return {
      data: { destroyed: server.server, provider: p.type, id: server.provider.id, sites_lost: live.map((s) => s.domain), config_removed: !input.keepConfig, secrets, ...(fleet.config.access === "tailscale" ? { left_tailnet: leftTailnet } : {}) },
      human: `${gone ? `${server.server} was already gone at ${p.type} — cleaned up after it` : `destroyed ${server.server} at ${p.type}`}${live.length ? ` (sites gone: ${live.map((s) => s.domain).join(", ")})` : ""}${secrets?.archived ? `\n1Password item ${secrets.item} moved to the archive` : ""}${fleet.config.access === "tailscale" ? (leftTailnet ? (device ? "\nremoved from the tailnet" : "\nlogged out of the tailnet (remove the machine in the Tailscale admin, or give fornax tailscale.api_token)") : "\nwarning: could not log it out of the tailnet — remove the machine in the Tailscale admin") : ""}${warn}`,
    };
  },
});

defineCommand({
  name: "server rename",
  summary: "give a server a new name everywhere: fleet, provider, hostname, tailnet, 1Password item, backup repository (old backups stay listed)",
  tier: "write",
  args: [
    { name: "server", help: "current name", required: true },
    { name: "new-name", help: "new name (default: two words like silent-comet, made up for you)" },
  ],
  options: { ...applyOptions },
  examples: ["fornax server rename web-1 silent-comet", "fornax server rename web-1"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    const old = server.server;
    const p = server.provider.type !== "manual" && server.provider.id ? await providerFor(fleet, server.provider.type, server) : undefined;
    const name = input.newName ? String(input.newName) : serverName([...fleet.servers.keys(), ...(p ? (await p.list()).map((s) => s.name) : [])]);
    assertServerName(name);
    if (name === old) fail("invalid_argument", `${old} already has that name`);
    if (fleet.servers.has(name)) fail("exists", `server "${name}" already exists in the fleet`);
    const tailnet = fleet.config.access === "tailscale";
    const ts = tailnet ? await tailscaleApi(fleet) : undefined;
    const done: string[] = [];
    // anything that fails half way says what is renamed already and what is not
    const failed = (e: unknown, what: string): never => {
      throw new FornaxError(
        (e as FornaxError).code ?? "rename_incomplete",
        `renaming ${old} → ${name}: ${what} failed: ${(e as Error).message}`,
        done.length ? `already done: ${done.join("; ")}` : "nothing was changed yet",
        undefined,
        { done },
      );
    };

    // 1. on the server, through the name that still works: hostname and its name in the tailnet
    let newHost = server.host;
    // the tailnet device, found by its name before anything renames it (an automatic machine name follows the hostname at once)
    const device = ts ? await ts.device(server.host).catch(() => undefined) : undefined;
    try {
      await runnerFor(fleet, server).run(`set -e
${etcCommitOutside(`fornax rename ${old} → ${name}`)}
hostnamectl set-hostname ${q(name)}
awk -v o=${q(old)} -v n=${q(name)} '$1 == "127.0.1.1" { for (i = 2; i <= NF; i++) if ($i == o) $i = n } { print }' /etc/hosts > /etc/hosts.fornax && cat /etc/hosts.fornax > /etc/hosts && rm -f /etc/hosts.fornax
${tailnet ? `tailscale set --hostname=${q(name)}` : "true"}
${etcCommit(fornaxMessage(`server renamed ${old} → ${name}`, { fleet: fleetRevision(fleet.dir), by: actor() }))}`);
      done.push(`hostname on the server`);
    } catch (e) {
      failed(e, "setting the hostname on the server");
    }
    if (tailnet) {
      try {
        // the machine name (and so the MagicDNS name) follows the hostname only while it is automatic: set it outright
        const dev = device;
        if (dev) await ts!.rename(dev.id, name);
        // reached by its MagicDNS name (short or full)? then by the new one from now on
        if (server.host === old || server.host.startsWith(`${old}.`)) newHost = name + server.host.slice(old.length);
        done.push(dev ? "machine name in the tailnet" : "hostname in the tailnet (the machine name follows it if it was never set by hand)");
      } catch (e) {
        failed(e, "renaming the machine in the tailnet");
      }
    }

    // 2. at the provider (cloud-init takes the hostname from there after a reboot)
    if (p?.rename) {
      try {
        await p.rename(String(server.provider.id), name);
        done.push(`name at ${p.type}`);
      } catch (e) {
        failed(e, `renaming it at ${p.type}`);
      }
    } else if (p) ctx.log(`note: ${p.type} cannot rename servers through its API — rename it in ${p.panel}`);

    // 3. the 1Password item with its secrets
    const op = fleet.config.onepassword;
    if (op) {
      try {
        if (await (await onePassword(fleet)).renameItem(itemTitle(fleet.config.fleet, old), itemTitle(fleet.config.fleet, name), op.vault)) done.push("1Password item");
      } catch (e) {
        failed(e, "renaming the 1Password item");
      }
    }

    // 4. the fleet: servers/<new>.yaml with the old name remembered (backups made under it stay listed), policies
    const oldFile = fleet.files.get(old)!;
    const newFile = join(fleet.dir, "servers", `${name}.yaml`);
    writeFileSync(
      newFile,
      patchYaml(readFileSync(oldFile, "utf8"), (doc) => {
        doc.set("server", name);
        doc.set("host", newHost);
        doc.set("former_names", doc.createNode([...server.former_names.filter((n) => n !== name), old]));
      }),
    );
    rmSync(oldFile);
    const fleetYaml = fleetFile(fleet.dir)!;
    if (fleet.config.policies.protected.includes(old)) {
      writeFileSync(fleetYaml, patchYaml(readFileSync(fleetYaml, "utf8"), (doc) => doc.setIn(["policies", "protected"], doc.createNode(fleet.config.policies.protected.map((x) => (x === old ? name : x))))));
    }
    done.push(`servers/${name}.yaml`);

    // 5. reachable under the new name? (MagicDNS takes a moment; the host key is the one known for the old name,
    // which is free now — and one day another server's)
    moveHostKey(fleet, server.host, newHost);
    if (newHost !== server.host) forgetHostKeys(fleet, [server.host]);
    const after = loadFleet(ctx);
    try {
      await waitForSsh(after, getServer(after, name), ctx, 90);
    } catch (e) {
      failed(e, `reaching it as ${newHost} (servers/${name}.yaml has host: ${newHost} — set it to what works, then: fornax plan ${name})`);
    }

    // 6. the backup follows: repository on the Storage Box renamed, the server's backup config rewritten
    let backup: Awaited<ReturnType<typeof converge>> | null = null;
    if (backupEnabled({ fleet: after, server: getServer(after, name), sites: sites(after, getServer(after, name)) })) {
      try {
        backup = await converge(after, getServer(after, name), { modules: ["backup"], sites: [] }, input, ctx);
        done.push("backup repository and config");
      } catch (e) {
        failed(e, "moving the backup over (run: fornax plan " + name + ")");
      }
    }
    return {
      data: { from: old, to: name, host: newHost, done, backup },
      human: [`renamed ${old} → ${name}${newHost !== server.host ? ` (now reached as ${newHost})` : ""}`, ...done.map((d) => `  ✓ ${d}`), "", `check: fornax plan ${name}   (commit servers/ in the fleet repo)`].join("\n"),
    };
  },
});

defineCommand({
  name: "server snapshot",
  summary: "take a provider snapshot of a server (before risky changes)",
  tier: "write",
  args: [{ name: "server", help: "server name", required: true }],
  options: { description: { type: "string", help: "snapshot description" } },
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    const p = await providerFor(fleet, server.provider.type, server);
    if (!p.snapshot) notSupported(p, "take snapshots");
    const id = await p.snapshot!(String(server.provider.id), String(input.description ?? `fornax ${new Date().toISOString()}`));
    return { data: { server: server.server, snapshot: id }, human: `snapshot ${id} of ${server.server} requested` };
  },
});

defineCommand({
  name: "server reinstall",
  summary: "wipe a server and reinstall Ubuntu 24.04 at the provider (everything on it is lost)",
  tier: "destroy",
  args: [{ name: "server", help: "server name", required: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    if (isProtected(fleet, server.server)) fail("protected", `${server.server} is protected by policy`);
    requireConfirm(input, server.server);
    const p = await providerFor(fleet, server.provider.type, server);
    if (!p.reinstall) notSupported(p, "reinstall servers");
    await p.reinstall!(String(server.provider.id));
    // the old system may still answer for a moment: wait until it is gone, then for the new one
    ctx.log(`reinstalling ${server.server} …`);
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
      const r = await runnerFor(fleet, server).run("true", { timeoutMs: 10_000, allowFail: true }).catch(() => null);
      if (!r || r.code !== 0) break;
      await Bun.sleep(3000);
    }
    forgetHostKeys(fleet, [server.host, ...(server.public_ipv4 ? [server.public_ipv4] : []), ...(server.public_ipv6 ? [server.public_ipv6] : [])]);
    await waitForSsh(fleet, server, ctx, 600);
    return { data: { server: server.server, reinstalled: true, next: `fornax server bootstrap ${server.server}` }, human: `${server.server} is reinstalled and reachable again (new SSH host key)\nnext: fornax server bootstrap ${server.server} && fornax server provision ${server.server}` };
  },
});

defineCommand({
  name: "server rdns",
  summary: "set the reverse DNS (PTR) of a server's public addresses",
  tier: "write",
  args: [
    { name: "server", help: "server name", required: true },
    { name: "ptr", help: "hostname for the PTR record", required: true },
  ],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    const p = await providerFor(fleet, server.provider.type, server);
    if (!p.rdns) notSupported(p, "set reverse DNS");
    const ips = [server.public_ipv4, server.public_ipv6].filter((x): x is string => Boolean(x));
    if (!ips.length) fail("no_public_ip", `${server.server} has no public_ipv4/public_ipv6 in its config`);
    for (const ip of ips) await p.rdns!(String(server.provider.id), ip, String(input.ptr));
    return { data: { server: server.server, ptr: input.ptr, ips }, human: `PTR of ${ips.join(", ")} → ${input.ptr}` };
  },
});

// ---- DNS ------------------------------------------------------------------------

function dnsNames(server: Server, fleet: Fleet): string[] {
  const names = sites(fleet, server)
    .filter((s) => s.spec.state === "present")
    .flatMap((s) => s.certNames);
  if (server.webhook?.domain) names.push(server.webhook?.domain);
  return [...new Set(names)];
}

defineCommand({
  name: "dns status",
  summary: "do the DNS records of all site names point at their server?",
  tier: "read",
  args: [{ name: "server", help: "server name", required: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    const want = { A: server.public_ipv4, AAAA: server.public_ipv6 };
    if (!want.A && !want.AAAA) fail("no_public_ip", `${server.server} has no public_ipv4/public_ipv6 in its config`);
    const dns = fleet.config.dns ? await dnsFor(fleet) : null;
    const rows: Array<{ name: string; type: string; want: string; have: string[]; ok: boolean }> = [];
    for (const name of dnsNames(server, fleet)) {
      for (const type of ["A", "AAAA"] as const) {
        const target = want[type];
        if (!target) continue;
        const have = dns ? (await dns.get(name, type)).map((r) => r.content) : [];
        rows.push({ name, type, want: target, have, ok: have.length === 1 && have[0] === target });
      }
    }
    const human = rows.map((r) => `${r.ok ? "ok " : "!! "} ${r.name.padEnd(34)} ${r.type.padEnd(5)} ${r.have.join(",") || "(none)"}${r.ok ? "" : `  → should be ${r.want}`}`).join("\n");
    return { data: { server: server.server, adapter: dns?.type ?? null, records: rows, in_sync: rows.every((r) => r.ok) }, human: dns ? human : `no DNS adapter — set these by hand:\n${rows.map((r) => `${r.name} ${r.type} ${r.want}`).join("\n")}` };
  },
});

defineCommand({
  name: "dns sync",
  summary: "point the A/AAAA records of all site names at their server (DNS only, not proxied)",
  tier: "write",
  args: [{ name: "server", help: "server name", required: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    const dns = await dnsFor(fleet);
    const want = { A: server.public_ipv4, AAAA: server.public_ipv6 };
    if (!want.A && !want.AAAA) fail("no_public_ip", `${server.server} has no public_ipv4/public_ipv6 in its config`);
    const results: Array<{ name: string; type: string; result: string }> = [];
    for (const name of dnsNames(server, fleet)) {
      for (const type of ["A", "AAAA"] as const) {
        if (!want[type]) continue;
        results.push({ name, type, result: await dns.set(name, type, want[type]!) });
      }
    }
    const changed = results.filter((r) => r.result !== "unchanged");
    return { data: { server: server.server, results }, human: changed.length ? changed.map((r) => `${r.result} ${r.name} ${r.type}`).join("\n") : "all records already correct" };
  },
});
