import { isAbsolute, join } from "node:path";
import { fail } from "./errors.ts";
import { secret, type Fleet } from "./fleet.ts";
import { fleetAgent } from "./ssh-agent.ts";
import { askpassPath, controlDir } from "./askpass.ts";
import { notice } from "./notice.ts";
import { q } from "./shell.ts";
import type { Server } from "./schema.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Called for every stderr line as it arrives (progress). */
  onStderr?: (line: string) => void;
  /** Called for every stdout line as it arrives. */
  onStdout?: (line: string) => void;
  timeoutMs?: number;
  /** Return non-zero exits instead of throwing. */
  allowFail?: boolean;
}

export interface Runner {
  readonly target: string;
  /** Run a bash script as the SSH user (root) on the server. */
  run(script: string, opts?: RunOptions): Promise<RunResult>;
  /** Copy a local file to the server. */
  upload(localPath: string, remotePath: string, mode?: string): Promise<void>;
}

/** SSH settings for a server: the fleet's, overridden per server. */
export function sshSettings(fleet: Fleet, server: Server) {
  const c = fleet.config.ssh;
  return {
    user: server.ssh?.user ?? c.user,
    port: server.ssh?.port ?? c.port,
    sudoPassword: server.ssh?.sudo_password ?? c.sudo_password,
  };
}

/** The environment for ssh: with a hardware key, its PIN and touch prompts as dialogs (askpass.ts). */
export function sshEnv(fleet: Fleet): Record<string, string | undefined> | undefined {
  if (!fleet.config.ssh.security_key) return undefined;
  return { ...process.env, SSH_ASKPASS: askpassPath(), SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY ?? ":0" };
}

/** `agent`: socket of the agent holding the fleet's key (see ssh-agent.ts), when `ssh.key` is set. */
export function sshArgs(fleet: Fleet, server: Server, agent?: string): string[] {
  const c = fleet.config.ssh;
  const { user, port } = sshSettings(fleet, server);
  // ~/… is the home directory; other relative paths are relative to the fleet repo
  const rel = (p: string) => {
    const home = p.replace(/^~(?=\/)/, process.env.HOME ?? "~");
    return isAbsolute(home) ? home : join(fleet.dir, home);
  };
  // a hardware key needs its PIN asked (no batch mode — but never a password prompt) and one touch
  // per connection: one connection per server, kept open for ssh.keep_open, carries all of a run's commands
  const sk = c.security_key ? rel(c.security_key) : undefined;
  const args = [
    ...(sk ? ["-o", "BatchMode=no", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "ControlMaster=auto", "-o", `ControlPath=${controlDir()}/%C`, "-o", `ControlPersist=${c.keep_open ?? "10m"}`] : ["-o", "BatchMode=yes"]),
    "-o",
    "ConnectTimeout=15",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=30",
  ];
  if (c.config_file) args.push("-F", c.config_file === "none" ? "/dev/null" : rel(c.config_file));
  if (sk) args.push("-i", sk);
  if (agent) args.push("-o", `IdentityAgent=${agent}`);
  else if (c.identity_file) args.push("-i", rel(c.identity_file), "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none");
  if (c.known_hosts_file) args.push("-o", `UserKnownHostsFile=${rel(c.known_hosts_file)}`);
  for (const [k, v] of Object.entries(c.options)) args.push("-o", `${k}=${v}`);
  args.push("-p", String(port), "-l", user, server.host);
  return args;
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine?: (l: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  let all = "";
  let buf = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    all += text;
    if (onLine) {
      buf += text;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
  }
  if (onLine && buf) onLine(buf);
  return all;
}

/**
 * Runs scripts as root on a server: directly when the SSH user is root, otherwise through sudo.
 * With sudo the script is first written to a private file and then executed, so stdin carries
 * nothing but the sudo password — it can never end up being run as a command.
 */
/** Login links already shown in this run (several connections may wait for the same one). */
const announced = new Set<string>();

export class SshRunner implements Runner {
  readonly target: string;
  private readonly settings: ReturnType<typeof sshSettings>;
  private sudoPw?: Promise<string>;

  constructor(
    private readonly fleet: Fleet,
    private readonly server: Server,
  ) {
    this.settings = sshSettings(fleet, server);
    this.target = `${this.settings.user}@${server.host}`;
  }

  private get viaSudo() {
    return this.settings.user !== "root";
  }

  private async exec(remote: string, stdin: Blob | undefined, opts: RunOptions = {}): Promise<RunResult> {
    const proc = Bun.spawn(["ssh", ...sshArgs(this.fleet, this.server, await fleetAgent(this.fleet)), remote], { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe", env: sshEnv(this.fleet) });
    const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : undefined;
    // Tailscale SSH in "check" mode holds the connection until you log in again: say so right away
    const onStderr = (line: string) => {
      const url = line.match(/https:\/\/login\.tailscale\.com\/a\/\S+/)?.[0];
      if (url && !announced.has(url)) {
        announced.add(url);
        notice(`Tailscale asks for a fresh login before SSH to ${this.server.server}: open ${url} — fornax goes on once you have`);
      }
      // a hardware key waits for a touch: say so in the terminal too (the dialog may be behind a window)
      if (/Confirm user presence for key/.test(line)) notice(`touch your security key (SSH to ${this.server.server})`);
      opts.onStderr?.(line);
    };
    const [stdout, stderr] = await Promise.all([readLines(proc.stdout, opts.onStdout), readLines(proc.stderr, onStderr)]);
    const code = await proc.exited;
    if (timer) clearTimeout(timer);
    if (code === 255 && !stdout) {
      // ssh's words for "no PIN given" and "nobody touched the key" are misleading: say what it was
      if (/signing failed for .*-SK .*(incorrect passphrase|invalid format|device not found)/i.test(stderr)) {
        fail("security_key", `the security key did not sign in to ${this.server.server}`, "the PIN dialog was cancelled, the key was not touched in time, or the key plugged in is not one in ssh.root_keys — try again", undefined, { stderr: stderr.trim() });
      }
      const last = stderr.trim().split("\n").pop() ?? "ssh failed";
      // a refused key is the usual first-run problem: say which key fornax offered and where to set another
      const refused = /Permission denied|Too many authentication failures/i.test(last);
      fail(
        "ssh_failed",
        `cannot reach ${this.target}: ${last}`,
        refused
          ? `${this.target} refused the key — fornax logged in with ${loginKey(this.fleet)}. Set the key in fornax.yaml: ssh.identity_file: <private key file> or ssh.key: <secret reference> (op://…, env:…, file:…)`
          : `check that the server is up and reachable on port ${this.settings.port}, and that ${this.settings.user} may log in`,
        `fornax server status ${this.server.server}`,
        { stderr: stderr.trim() },
      );
    }
    return { code, stdout, stderr };
  }

  private async sudo(command: string, opts: RunOptions): Promise<RunResult> {
    let stdin: Blob | undefined;
    let sudo = "sudo -n";
    if (this.settings.sudoPassword) {
      this.sudoPw ??= secret(this.fleet, this.settings.sudoPassword);
      stdin = new Blob([(await this.sudoPw) + "\n"]);
      // -k: never use cached credentials, so sudo always consumes the password line
      sudo = "sudo -S -k -p ''";
    }
    const res = await this.exec(`${sudo} ${command}`, stdin, opts);
    if (res.code !== 0 && /incorrect password|a password is required|try again|not in the sudoers|may not run sudo/i.test(res.stderr)) {
      fail("sudo_failed", `sudo as ${this.settings.user} on ${this.server.server} failed`, res.stderr.trim().split("\n").pop(), undefined, { stderr: tail(res.stderr, 5) });
    }
    return res;
  }

  /** Put a file into a private temp file in the SSH user's home; returns its path. */
  private async stage(content: Blob): Promise<string> {
    const r = await this.exec(`umask 077; f=$(mktemp "$HOME/.fornax-stage.XXXXXX") && cat > "$f" && echo "$f"`, content);
    if (r.code !== 0) fail("ssh_failed", `cannot stage a file on ${this.server.server}`, r.stderr.trim());
    return r.stdout.trim();
  }

  async run(script: string, opts: RunOptions = {}): Promise<RunResult> {
    let res: RunResult;
    if (this.viaSudo) {
      const f = await this.stage(new Blob([script]));
      try {
        res = await this.sudo(`bash -c 'bash "$0"; rc=$?; rm -f "$0"; exit $rc' '${f}'`, opts);
      } finally {
        // a failed sudo never ran the script: it (and the secrets in it) must not stay behind
        await this.exec(`rm -f '${f}'`, undefined);
      }
    } else {
      res = await this.exec("bash -s", new Blob([script]), opts);
    }
    if (res.code !== 0 && !opts.allowFail) {
      fail("remote_failed", `script failed on ${this.server.server} (exit ${res.code})`, tail(res.stderr || res.stdout, 15), undefined, { code: res.code, stderr: tail(res.stderr, 60) });
    }
    return res;
  }

  async upload(localPath: string, remotePath: string, mode = "0755"): Promise<void> {
    const tmp = `${remotePath}.fornax-upload`;
    if (this.viaSudo) {
      const f = await this.stage(Bun.file(localPath));
      await this.run(`set -e; mkdir -p "$(dirname '${remotePath}')"; install -m ${mode} -o root -g root '${f}' '${tmp}'; rm -f '${f}'; mv -f '${tmp}' '${remotePath}'`);
      return;
    }
    const proc = Bun.spawn(
      ["ssh", ...sshArgs(this.fleet, this.server, await fleetAgent(this.fleet)), `mkdir -p "$(dirname '${remotePath}')" && cat > '${tmp}' && chmod ${mode} '${tmp}' && mv -f '${tmp}' '${remotePath}'`],
      { stdin: Bun.file(localPath), stdout: "pipe", stderr: "pipe", env: sshEnv(this.fleet) },
    );
    const err = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) fail("upload_failed", `upload to ${this.server.server}:${remotePath} failed`, err.trim());
  }
}

/**
 * An interactive session: ssh with a terminal, wired to this one. `remote` runs as the SSH user;
 * a non-root user gets it through sudo, which asks for its password on the terminal.
 * Returns the remote exit code.
 */
export async function interactive(fleet: Fleet, server: Server, remote: string): Promise<number> {
  const { user } = sshSettings(fleet, server);
  const cmd = user === "root" ? remote : `sudo bash -c ${q(remote)}`;
  const proc = Bun.spawn(["ssh", "-t", ...sshArgs(fleet, server, await fleetAgent(fleet)), cmd], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: sshEnv(fleet) });
  return proc.exited;
}

/** Which key a connection offers, in words (for errors). */
function loginKey(fleet: Fleet): string {
  const c = fleet.config.ssh;
  if (c.security_key) return `the security key ${c.security_key}`;
  if (c.key) return `the fleet key ${c.key} (ssh.key)`;
  if (c.identity_file) return `${c.identity_file} (ssh.identity_file)`;
  return "your ssh-agent's keys and ~/.ssh/config (no ssh.key or ssh.identity_file set)";
}

export const tail = (s: string, n: number) => s.trimEnd().split("\n").slice(-n).join("\n");

export const runnerFor = (fleet: Fleet, server: Server): Runner => new SshRunner(fleet, server);
