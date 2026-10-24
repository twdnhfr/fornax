/**
 * Keeps fornax on a server current before commands that run it there (deploy, rollback, backups,
 * notify test): a fix in the deploy or backup logic reaches the server without a separate apply.
 * Only a newer build replaces the server's — one installed by a newer fornax (another machine,
 * another checkout) is left alone. Servers without fornax yet are set up by apply, not here.
 */
import { remoteBinary } from "./binary.ts";
import { fail } from "./errors.ts";
import type { Fleet } from "./fleet.ts";
import type { Server } from "./schema.ts";
import { q } from "./shell.ts";
import { runnerFor } from "./ssh.ts";

const BIN = "/usr/local/bin/fornax";
const STAGING = "/var/tmp/fornax-staging";

export async function ensureServerBinary(fleet: Fleet, server: Server, log: (line: string) => void): Promise<void> {
  if (fleet.config.server_binary === "manual") return;
  const runner = runnerFor(fleet, server);
  const probe = await runner.run(`uname -m
if [ -x ${BIN} ]; then sha256sum ${BIN} | cut -c1-64; ${BIN} --version --json 2>/dev/null | tail -1; elif [ -x /usr/local/bin/anvil ]; then echo legacy; fi`);
  const [machine, sha, version] = probe.stdout.trim().split("\n");
  if (sha === "legacy") {
    // set up under fornax's old name: the move happens in one full plan, not here
    fail("legacy_layout", `${server.server} still runs fornax under its old name (anvil)`, "its units, paths and webhook move over in one full plan + apply", `fornax plan ${server.server}`);
  }
  if (!sha) return;
  const local = await remoteBinary(machine === "aarch64" ? "arm64" : "x86_64");
  if (sha === local.sha) return;
  let remoteBuild: string | undefined;
  try {
    remoteBuild = (JSON.parse(version ?? "{}") as { build?: string }).build ?? undefined;
  } catch {}
  // ISO timestamps compare as strings; an unstamped server binary is always older
  if (remoteBuild && (!local.build || remoteBuild > local.build)) {
    log(`fornax on ${server.server} is newer (build ${remoteBuild}) than this one (${local.build ?? "unstamped"}) — left as it is`);
    return;
  }
  const staged = `${STAGING}/${local.sha}`;
  await runner.run(`install -d -m 0700 ${STAGING}`);
  await runner.upload(local.path, staged, "0755");
  // mv is atomic: a deploy running right now finishes with the old file
  await runner.run(`[ "$(sha256sum ${q(staged)} | cut -c1-64)" = ${q(local.sha)} ] || { echo "upload of fornax to ${server.server} is corrupt" >&2; exit 1; }
install -m 0755 ${q(staged)} ${BIN}.new && mv -f ${BIN}.new ${BIN} && rm -f ${q(staged)}
systemctl try-restart fornax-hook.service 2>/dev/null || true`);
  log(`updated fornax on ${server.server}: ${remoteBuild ?? "older build"} → ${local.build ?? local.sha.slice(0, 12)}`);
}
