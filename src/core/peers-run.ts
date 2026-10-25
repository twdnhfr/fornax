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
import { needTrust, RUN_DONE } from "./peers.ts";
import { syncPeers } from "./peers-sync.ts";
import { q } from "./shell.ts";
import { sshSettings } from "./ssh.ts";
import type { Server } from "./schema.ts";

/**
 * An ssh-agent of fornax's own holding only the key fornax logs in with — never your personal agent —
 * to forward; it ends with this process. A key without a touch of its own (a file, ssh.key) is
 * added with -c: every use on the host asks you first.
 */
async function forwardAgent(fleet: Fleet): Promise<string> {
  const c = fleet.config.ssh;
  const rel = (p: string) => {
    const home = p.replace(/^~(?=\/)/, process.env.HOME ?? "~");
    return isAbsolute(home) ? home : join(fleet.dir, home);
  };
  const source = c.security_key ? { file: rel(c.security_key), touch: true } : c.identity_file ? { file: rel(c.identity_file), touch: false } : c.key ? { key: await secret(fleet, c.key), touch: false } : undefined;
  if (!source) fail("no_ssh_key", "nothing to forward: the fleet names no key fornax logs in with", "set ssh.security_key, ssh.identity_file or ssh.key — fornax --on never forwards your personal SSH agent");
  const dir = mkdtempSync(join(tmpdir(), "fornax-fwd-"));
  const sock = join(dir, "agent.sock");
  // the agent asks for a security key's PIN, and confirms each use of other keys, through the askpass dialogs
  const env = { ...process.env, SSH_ASKPASS: askpassPath(), SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY ?? ":0" };
  const agent = Bun.spawn(["ssh-agent", "-D", "-a", sock], { stdout: "ignore", stderr: "ignore", env });
  process.once("exit", () => {
    agent.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  agent.unref();
  for (let i = 0; i < 100 && !existsSync(sock); i++) await Bun.sleep(20);
  const confirm = source!.touch || process.env.FORNAX_FORWARD_NO_CONFIRM === "1" ? [] : ["-c"];
  const add = "file" in source!
    ? Bun.spawnSync(["ssh-add", "-q", ...confirm, source!.file!], { env: { ...env, SSH_AUTH_SOCK: sock }, stdout: "ignore", stderr: "pipe" })
    : Bun.spawnSync(["ssh-add", "-q", ...confirm, "-"], { stdin: new Blob([source!.key!.endsWith("\n") ? source!.key! : `${source!.key}\n`]), env: { ...env, SSH_AUTH_SOCK: sock }, stdout: "ignore", stderr: "pipe" });
  if (add.exitCode !== 0) fail("ssh_key_invalid", "the login key could not be loaded into the agent to forward", add.stderr.toString().trim());
  return sock;
}

/**
 * The host keys this machine knows for the fleet's servers: the host checks every server it
 * connects to against them (StrictHostKeyChecking=yes), never trusting a key on first sight.
 */
function knownHosts(fleet: Fleet, log: (l: string) => void): string {
  const c = fleet.config.ssh;
  const files = c.known_hosts_file ? [isAbsolute(c.known_hosts_file) ? c.known_hosts_file : join(fleet.dir, c.known_hosts_file)] : [join(process.env.HOME ?? "", ".ssh", "known_hosts")];
  const lines = new Set<string>();
  for (const server of fleet.servers.values()) {
    const { port } = sshSettings(fleet, server);
    const name = port === 22 ? server.host : `[${server.host}]:${port}`;
    let found = false;
    for (const f of files.filter((f) => existsSync(f))) {
      const r = Bun.spawnSync(["ssh-keygen", "-F", name, "-f", f], { stdout: "pipe", stderr: "ignore" });
      for (const l of r.stdout.toString().split("\n").filter((l) => l && !l.startsWith("#"))) {
        lines.add(l);
        found = true;
      }
    }
    if (!found) log(`note: no host key of ${server.server} (${name}) known here — a host will not connect to it; connect once from here first (e.g. fornax server status ${server.server})`);
  }
  return [...lines].join("\n") + "\n";
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
  const synced = await syncPeers(fleet, { push: true, servers: [server], log: o.log });
  const st = synced.peers[0];
  if (st && (st.state === "refused" || st.state === "unreachable" || st.state === "not_set_up" || st.pushed === false)) {
    if (st.state === "refused") fail("unsigned_fleet", `the fleet repo on ${server.server} cannot be used: ${st.reason}`, "a commit there is not signed by a signer — someone changed it on the server; look at it before anything else");
    fail("peer_push_failed", `the fleet repo on ${server.server} cannot be used: ${st.reason ?? st.state}`, "plan + apply sets the repo up; then fornax peers sync");
  }
  const trust = needTrust(fleet.config.fleet);
  // the token for hosts: peers.service_account (a narrower one), else the fleet's
  const tokenRef = p!.service_account ?? fleet.config.onepassword?.service_account;
  const token = tokenRef ? await secret(fleet, tokenRef) : "";
  const hostKeys = Buffer.from(knownHosts(fleet, o.log)).toString("base64");
  const sock = await forwardAgent(fleet);

  const remote = `/usr/local/bin/fornax peers host-run --server ${q(server.server)} -- ${o.argv.map(q).join(" ")}`;
  const proc = Bun.spawn(["ssh", ...forwardingArgs(fleet, server, sock), remote], {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "pipe",
    env: { ...process.env, SSH_ASKPASS: askpassPath(), SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY ?? ":0" },
  });
  proc.stdin.write(`${token}\n${trust.anchor}:${trust.head}\n${hostKeys}\n`);
  proc.stdin.flush();
  // the host's stderr goes through; its end-of-run marker gets the answer that lets it clean up
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of proc.stderr) {
    pending += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      if (line.startsWith(RUN_DONE)) {
        proc.stdin.write("ack\n");
        proc.stdin.end();
      } else process.stderr.write(line + "\n");
    }
  }
  if (pending) process.stderr.write(pending);
  const code = await proc.exited;

  // what the host committed comes back here — checked like everything else — and goes on to the other servers
  try {
    const r = await syncPeers(loadFleet({ cwd: o.cwd, fleetDir: o.fleetDir, tier: "read" }), { push: true, log: () => {} });
    if (r.fastForwarded) {
      const off = r.peers.filter((p) => p.state !== "same" && !p.pushed);
      o.log(`fleet repo moved forward to ${r.head.slice(0, 12)} (from ${server.server}), here and on ${r.peers.length - off.length}/${r.peers.length} servers${off.length ? ` — not on ${off.map((p) => p.server).join(", ")}: fornax peers sync` : ""}`);
    }
  } catch (e) {
    const err = e as { code?: string; message: string; next?: string };
    if (err.code === "trust_change_pending") o.log(`attention: ${server.server} committed a change to what trust rests on — not taken over. ${err.message}\nlook at it, then: fornax peers sync --accept-trust-changes`);
    else o.log(`warning: could not take ${server.server}'s fleet repo back: ${err.message}`);
  }
  return code;
}
