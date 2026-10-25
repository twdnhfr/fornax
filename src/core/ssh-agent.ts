/**
 * The fleet's SSH key (`ssh.key`, a secret reference — usually an SSH key item in the fleet's
 * 1Password vault) in an ssh-agent of fornax's own: the private key is read through the service
 * account and only ever lives in that agent's memory — no key file on disk, no desktop app, no
 * Touch ID. The agent ends with the fornax process; should that be killed hard, the key still
 * expires after an hour.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "./errors.ts";
import { secret, type Fleet } from "./fleet.ts";

const agents = new Map<string, Promise<string>>();

/** Socket of the agent holding the fleet's key, or undefined when the fleet has none. */
export function fleetAgent(fleet: Fleet): Promise<string> | undefined {
  // a peer host uses only the agent its client forwarded (ssh.ts, peerHost)
  if (process.env.FORNAX_PEER_HOST === "1") return undefined;
  const ref = fleet.config.ssh.key;
  if (!ref) return undefined;
  if (!agents.has(ref)) agents.set(ref, start(fleet, ref));
  return agents.get(ref);
}

async function start(fleet: Fleet, ref: string): Promise<string> {
  const key = await secret(fleet, ref);
  const dir = mkdtempSync(join(tmpdir(), "fornax-agent-"));
  chmodSync(dir, 0o700);
  const sock = join(dir, "agent.sock");
  const agent = Bun.spawn(agentCommand(sock, ["-t", "3600"]), { stdout: "ignore", stderr: "ignore" });
  const stop = () => {
    agent.kill();
    rmSync(dir, { recursive: true, force: true });
  };
  process.once("exit", stop);
  agent.unref();
  for (let i = 0; i < 100 && !existsSync(sock); i++) await Bun.sleep(20);
  const add = Bun.spawnSync(["ssh-add", "-q", "-"], { stdin: new Blob([key.endsWith("\n") ? key : `${key}\n`]), env: { ...process.env, SSH_AUTH_SOCK: sock }, stdout: "ignore", stderr: "pipe" });
  if (add.exitCode !== 0) {
    stop();
    fail("ssh_key_invalid", `the fleet's SSH key (${ref}) could not be loaded`, add.stderr.toString().trim() || "is it an OpenSSH private key? For 1Password items use …/private key?ssh-format=openssh");
  }
  return sock;
}

/**
 * ssh-agent bound to this process: it runs a watcher as its command and ends when that ends — when
 * this process is gone, however it ended (the exit handlers do not run on every way out).
 */
export const agentCommand = (sock: string, options: string[] = []) => ["ssh-agent", ...options, "-a", sock, "sh", "-c", `while kill -0 ${process.pid} 2>/dev/null; do sleep 2; done`];
