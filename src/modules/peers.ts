/**
 * The fleet repo on a server, for peers (core/peers.ts): a plain git repository at PEER_DIR that
 * apply keeps current. It takes fast-forwards only, and its pre-receive hook refuses commits that
 * are not signed by a signer — so a server that was broken into cannot push its own history to an
 * honest one, even if it ever got a key to it. Commits made here are signed through the agent the
 * client forwarded: the server itself has nothing to sign with.
 */
import { check, packages, type Resource } from "../core/resource.ts";
import { q, sha256 } from "../core/shell.ts";
import type { ModuleCtx } from "./common.ts";
import { binaryResource } from "./deploy.ts";

export const PEER_DIR = "/var/lib/fornax/fleet";

export const PRE_RECEIVE = `#!/bin/sh
# managed by fornax: fast-forwards of signed commits only (each against the signers of the commit before)
exec /usr/local/bin/fornax peers receive
`;

/** The repo's settings: one script, its hash marks a repo set up by this version of it. */
export function peerRepoScript(server: string): string {
  return `set -e
d=${PEER_DIR}
# /var/lib/fornax itself stays as the server module keeps it (0755: the webhook and ACME live below it)
[ -d /var/lib/fornax ] || install -d -m 0755 -o root -g root /var/lib/fornax
install -d -m 0700 -o root -g root "$d"
[ -d "$d/.git" ] || git init -q -b main "$d"
c() { git -C "$d" config "$@"; }
c receive.denyCurrentBranch updateInstead
c receive.denyNonFastForwards true
c receive.denyDeletes true
c gpg.format ssh
c commit.gpgsign true
c gpg.ssh.defaultKeyCommand "/usr/local/bin/fornax peers signing-key"
c user.name ${q(`fornax on ${server}`)}
c user.email ${q(`fornax@${server}.invalid`)}
grep -qxF .fornax/ "$d/.git/info/exclude" 2>/dev/null || echo .fornax/ >> "$d/.git/info/exclude"
printf '%s' ${q(PRE_RECEIVE)} > "$d/.git/hooks/pre-receive"
chmod 0755 "$d/.git/hooks/pre-receive"
chmod 0700 "$d"`;
}

export function peerResources(ctx: ModuleCtx): Resource[] {
  const p = ctx.fleet.config.peers;
  if (!p?.enabled) return [];
  const o = { owner: "peers" };
  const script = peerRepoScript(ctx.server.server);
  const mark = sha256(script).slice(0, 16);
  const bin = binaryResource(ctx);
  return [
    packages("peers", ["git"], o),
    ...(bin ? [bin] : []),
    check(
      "peers-repo",
      `fleet repo for peers at ${PEER_DIR} (fast-forwards of signed commits only)`,
      `[ "$(git -C ${PEER_DIR} config fornax.setup)" = ${q(mark)} ]`,
      `${script}\ngit -C ${PEER_DIR} config fornax.setup ${q(mark)}`,
      o,
    ),
  ];
}
