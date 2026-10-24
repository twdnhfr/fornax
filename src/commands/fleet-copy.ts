import { resolve } from "node:path";
import { defineCommand } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { getServer, loadFleet } from "../core/fleet.ts";
import { pushCopy, readCopy, restoreCopy } from "../core/fleet-copy.ts";

defineCommand({
  name: "fleet push",
  summary: "put the encrypted, signed copy of the fleet repo on servers now (apply does it by itself)",
  tier: "write",
  args: [{ name: "servers", help: "server names (default: all)", variadic: true }],
  examples: ["fornax fleet push", "fornax fleet push web-1"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    if (!fleet.config.fleet_copy) fail("config_invalid", "fleet_copy is not set up in fornax.yaml", "add fleet_copy.recipients (age recipients)");
    const names = (input.servers as string[]).length ? (input.servers as string[]) : [...fleet.servers.keys()];
    const results: Array<{ server: string; created?: string; error?: string }> = [];
    for (const name of names) {
      try {
        const m = await pushCopy(fleet, getServer(fleet, name));
        results.push({ server: name, created: m.created });
      } catch (e) {
        results.push({ server: name, error: (e as Error).message });
      }
    }
    const failed = results.filter((r) => r.error);
    return {
      data: { results },
      human: results.map((r) => (r.error ? `✗ ${r.server}: ${r.error}` : `✓ ${r.server}: copy from ${r.created}`)).join("\n"),
      exitCode: failed.length ? 1 : 0,
    };
  },
});

defineCommand({
  name: "fleet copies",
  summary: "which server holds which copy of the fleet repo, and whether its signature holds",
  tier: "read",
  args: [{ name: "servers", help: "server names (default: all)", variadic: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const names = (input.servers as string[]).length ? (input.servers as string[]) : [...fleet.servers.keys()];
    const rows: Array<Record<string, unknown>> = [];
    for (const name of names) {
      try {
        const c = await readCopy(fleet, getServer(fleet, name));
        rows.push(c ? { server: name, created: c.manifest.created, commit: c.manifest.commit, dirty: c.manifest.dirty, valid: c.valid } : { server: name, created: null });
      } catch (e) {
        rows.push({ server: name, error: (e as Error).message });
      }
    }
    const line = (r: Record<string, unknown>) =>
      r.error ? `${r.server}: ${r.error}` : !r.created ? `${r.server}: no copy` : `${r.server}: ${r.created} · ${String(r.commit ?? "no commit").slice(0, 12)}${r.dirty ? " + uncommitted" : ""} · ${r.valid ? "signature ok" : "SIGNATURE INVALID"}`;
    return { data: { copies: rows }, human: rows.map(line).join("\n") };
  },
});

defineCommand({
  name: "fleet restore",
  summary: "bring the fleet repo back from the servers' encrypted copies — needs ssh to a server, the fleet key's public key and one of the age identities",
  tier: "write",
  args: [{ name: "dir", help: "new directory for the fleet repo", required: true }],
  options: {
    from: { type: "list", help: "ssh targets, e.g. root@web-1 (several: the newest signed copy wins)" },
    signer: { type: "string", help: "the fleet SSH key's public key: key line, file or op:// reference" },
    identity: { type: "list", help: "age identity files or op:// references (a FIDO2 identity asks for PIN and touch)" },
    "fleet-name": { type: "string", help: "only copies of this fleet" },
    "ssh-key": { type: "string", help: "SSH key to log in with, e.g. a security key handle (ssh-keygen -K)" },
  },
  examples: [
    "fornax fleet restore ~/fleet --from root@web-1,root@web-2 --signer 'op://Fleet/fleet ssh/public key' --identity 'op://Private/fleet restore/yubikey'",
  ],
  async run(input, ctx) {
    const from = (input.from as string[] | undefined) ?? [];
    if (!from.length) fail("missing_option", "--from is required: where to fetch the copy (root@<server>)");
    if (!input.signer) fail("missing_option", "--signer is required: without it a copy a broken-into server made up would be taken as yours");
    const r = await restoreCopy({
      from,
      signer: String(input.signer),
      identities: (input.identity as string[] | undefined) ?? [],
      dir: resolve(ctx.cwd, String(input.dir)),
      fleetName: input.fleetName as string | undefined,
      sshKey: input.sshKey as string | undefined,
      log: ctx.log,
    });
    return {
      data: r,
      human: `restored to ${r.dir} from ${r.from} — copy of ${r.manifest.created}${r.manifest.dirty ? " (had uncommitted changes: see git status)" : ""}\nnext: cd ${r.dir} && git log -3 && fornax plan <server>`,
    };
  },
});
