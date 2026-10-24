/**
 * Who may log in as root: exactly `ssh.root_keys` (e.g. one hardware key), and — with
 * `tailscale.ssh_server: false` — through sshd rather than Tailscale SSH, which trusts any of your
 * devices and so anyone at one of them. With a security key on top, an unlocked laptop alone does
 * not get root on a server. For every server fornax manages, adopted ones too.
 */
import { fail } from "../core/errors.ts";
import { check, dir, file, type Resource } from "../core/resource.ts";
import type { Fleet } from "../core/fleet.ts";
import type { Server } from "../core/schema.ts";
import { HEADER, type ModuleCtx } from "./common.ts";

/** The fleet's root_keys plus the server's own; undefined when neither sets any (then keys are only added). */
export function rootKeys(fleet: Fleet, server: Server): string[] | undefined {
  const fleetKeys = fleet.config.ssh.root_keys;
  const own = server.ssh?.root_keys;
  return fleetKeys || own ? [...(fleetKeys ?? []), ...(own ?? [])] : undefined;
}

export function rootAccessResources(ctx: ModuleCtx): Resource[] {
  const o = { owner: "root-access" };
  const keys = rootKeys(ctx.fleet, ctx.server);
  const r: Resource[] = [];
  if (keys) {
    r.push(dir("/root/.ssh", { ...o, mode: "0700" }), file("/root/.ssh/authorized_keys", `# ${HEADER}\n${keys.join("\n")}\n`, { ...o, mode: "0600" }));
  }
  if (ctx.fleet.config.access === "tailscale" && ctx.fleet.config.tailscale?.ssh_server === false) {
    // switched off with nothing else to log in with, the server would lock everyone out
    if (!keys?.length) fail("config_invalid", "tailscale.ssh_server: false needs ssh.root_keys (the keys sshd lets in as root)", "add your security key's public key to ssh.root_keys");
    r.push(
      check(
        "tailscale-ssh-off",
        "root logs in through sshd with ssh.root_keys, not Tailscale SSH",
        `tailscale debug prefs 2>/dev/null | grep -q '"RunSSH": false'`,
        // delayed: this very apply may be running over Tailscale SSH
        "systemd-run --quiet --on-active=3 tailscale set --ssh=false",
        o,
      ),
    );
  }
  return r;
}
