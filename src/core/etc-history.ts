/**
 * The history of a server's /etc: etckeeper keeps it in git (`/etc/.git`, root only), committing
 * after package installs and once a day by itself. fornax adds two kinds of commits around every
 * change it makes:
 *
 * - "outside fornax: …" just before — whatever changed since the last commit was not fornax;
 * - "fornax: …" right after — what fornax changed, with the plan, the fleet commit and who ran it.
 *
 * So the server's own git log answers "how did this file get like this" — for changes by fornax,
 * by packages and by hand alike — without a second copy of the configuration anywhere.
 */
import { hostname, userInfo } from "node:os";
import { q } from "./shell.ts";

export const FORNAX_PREFIX = "fornax:";
export const OUTSIDE_PREFIX = "outside fornax:";

/** Who runs fornax: FORNAX_ACTOR (e.g. an agent naming itself), else user@host. */
export const actor = () => process.env.FORNAX_ACTOR || `${userInfo().username}@${hostname().replace(/\.local$/, "")}`;

/** The fleet repo's commit, "+uncommitted" when its files differ from it; null outside git. */
export function fleetRevision(dir: string): string | null {
  const rev = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  if (rev.exitCode !== 0) return null;
  const dirty = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  return `${rev.stdout.toString().trim()}${dirty ? "+uncommitted" : ""}`;
}

/** Shell: commit what changed in /etc, if etckeeper keeps it; never fails the script around it. */
export const etcCommit = (message: string) => `if command -v etckeeper >/dev/null 2>&1 && [ -d /etc/.git ]; then etckeeper commit ${q(message)} >/dev/null 2>&1 || true; fi`;

/** Shell, before fornax changes anything: put what someone else changed into a commit of its own. */
export const etcCommitOutside = (what: string) => etcCommit(`${OUTSIDE_PREFIX} changes found before ${what}`);

/** The commit message for a fornax change. */
export function fornaxMessage(summary: string, details: Record<string, string | null | undefined>): string {
  const lines = Object.entries(details)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`);
  return `${FORNAX_PREFIX} ${summary}\n\n${lines.join("\n")}`;
}
