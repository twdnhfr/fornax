/**
 * `fornax --on <server> <command …>`: run fornax on a peer (docs/peers.md). This machine
 *
 * 1. brings the peer's fleet repo to the newest signed state (peers-sync.ts),
 * 2. starts an agent of its own with the key that logs in as root (the security key, PIN and touch
 *    as usual) and forwards it — over a connection of its own, as a multiplexed one would forward
 *    the master's agent instead,
 * 3. hands the 1Password service-account token and its trusted state to the host on stdin
 *    (never on the command line, never written to the server's disk),
 * 4. and afterwards takes the host's new commits back, checked like any others.
 *
 * On the host, `fornax peers host-run` checks the repo against that trusted state and runs the
 * command detached from the connection: a change to the host's own network that drops the
 * session does not stop an apply halfway. `fornax --on <server> peers attach <run>` reattaches.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { askpassPath } from "./askpass.ts";
import { fail } from "./errors.ts";
import { getServer, loadFleet, secret, type Fleet } from "./fleet.ts";
import { needTrust } from "./peers.ts";
import { syncPeers } from "./peers-sync.ts";
import { q } from "./shell.ts";
import { sshSettings } from "./ssh.ts";
import type { Server } from "./schema.ts";

/** An ssh-agent of fornax's own holding the root login key, to forward; ends with this process. */
async function forwardAgent(fleet: Fleet): Promise<string> {
  const c = fleet.config.ssh;
  const rel = (p: string) => {
    const home = p.replace(/^~(?=\/)/, process.env.HOME ?? "~");
    return isAbsolute(home) ? home : join(fleet.dir, home);
  };
  const keyFile = c.security_key ? rel(c.security_key) : c.identity_file ? rel(c.identity_file) : undefined;
  // no key file of the fleet's: forward the agent you already use (e.g. your password manager's)
  if (!keyFile) return process.env.SSH_AUTH_SOCK ?? fail("no_ssh_key", "nothing to forward: no ssh.security_key, no ssh.identity_file and no SSH agent (SSH_AUTH_SOCK)");
  const dir = mkdtempSync(join(tmpdir(), "fornax-fwd-"));
  const sock = join(dir, "agent.sock");
  // the agent asks for a security key's PIN when it signs, through the askpass dialogs
  const env = { ...process.env, SSH_ASKPASS: askpassPath(), SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY ?? ":0" };
  const agent = Bun.spawn(["ssh-agent", "-D", "-a", sock], { stdout: "ignore", stderr: "ignore", env });
  process.once("exit", () => {
    agent.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  agent.unref();
  for (let i = 0; i < 100 && !existsSync(sock); i++) await Bun.sleep(20);
  const add = Bun.spawnSync(["ssh-add", "-q", keyFile], { env: { ...env, SSH_AUTH_SOCK: sock }, stdout: "ignore", stderr: "pipe" });
  if (add.exitCode !== 0) fail("ssh_key_invalid", `${keyFile} could not be loaded into the agent to forward`, add.stderr.toString().trim());
  return sock;
}

/** ssh to the host with the agent forwarded, on a connection of its own. */
function forwardingArgs(fleet: Fleet, server: Server, sock: string): string[] {
  const c = fleet.config.ssh;
  const { user, port } = sshSettings(fleet, server);
  const rel = (p: string) => (isAbsolute(p) ? p : join(fleet.dir, p));
  const args = ["-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", `IdentityAgent=${sock}`, "-o", `ForwardAgent=${sock}`, "-o", "BatchMode=no", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30"];
  if (c.config_file) args.push("-F", c.config_file === "none" ? "/dev/null" : rel(c.config_file));
  if (c.known_hosts_file) args.push("-o", `UserKnownHostsFile=${rel(c.known_hosts_file)}`);
  for (const [k, v] of Object.entries(c.options)) args.push("-o", `${k}=${v}`);
  return [...args, "-p", String(port), "-l", user, server.host];
}

export async function runOn(o: { cwd: string; fleetDir?: string; serverName: string; argv: string[]; log: (l: string) => void }): Promise<number> {
  const fleet = loadFleet({ cwd: o.cwd, fleetDir: o.fleetDir, tier: "read" });
  const p = fleet.config.peers;
  if (!p?.enabled) fail("no_peers", "peers are not enabled in fornax.yaml", "set peers.enabled: true and peers.signers, then plan + apply");
  const server = getServer(fleet, o.serverName);
  if (p!.hosts && !p!.hosts.includes(server.server)) fail("not_a_host", `${server.server} is not one of peers.hosts (${p!.hosts.join(", ")})`);
  if (!o.argv.length) fail("missing_argument", "--on needs a command to run there", undefined, `fornax --on ${server.server} plan ${server.server}`);

  o.log(`fornax on ${server.server}: bringing its fleet repo up to date …`);
  await syncPeers(fleet, { push: true, servers: [server], log: o.log });
  const trust = needTrust(fleet.config.fleet);
  const token = fleet.config.onepassword?.service_account ? await secret(fleet, fleet.config.onepassword.service_account) : "";
  const sock = await forwardAgent(fleet);

  const remote = `/usr/local/bin/fornax peers host-run --server ${q(server.server)} -- ${o.argv.map(q).join(" ")}`;
  const proc = Bun.spawn(["ssh", ...forwardingArgs(fleet, server, sock), remote], {
    stdin: new Blob([`${token}\n${trust.anchor}:${trust.head}\n`]),
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, SSH_ASKPASS: askpassPath(), SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY ?? ":0" },
  });
  const code = await proc.exited;

  // what the host committed comes back here — checked like everything else
  try {
    const r = await syncPeers(loadFleet({ cwd: o.cwd, fleetDir: o.fleetDir, tier: "read" }), { push: true, servers: [server], log: () => {} });
    if (r.fastForwarded) o.log(`fleet repo here moved forward to ${r.head.slice(0, 12)} (from ${server.server})`);
  } catch (e) {
    o.log(`warning: could not take ${server.server}'s fleet repo back: ${(e as Error).message}`);
  }
  return code;
}
