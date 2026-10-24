/**
 * /etc in git (etckeeper): the server's own history of every configuration change — by fornax
 * (commits around each apply, see core/etc-history.ts), by packages (etckeeper's apt hooks) and by
 * hand (the daily autocommit, or the "outside fornax" commit before the next apply).
 * Keys and secrets never go into it: a rotated secret would stay readable in the history forever.
 */
import { check, packages, type Resource } from "../core/resource.ts";
import { q } from "../core/shell.ts";
import type { ModuleCtx } from "./common.ts";

const MARK = "# fornax: keys and secrets stay out of the history";

/** Anchored to /etc; private keys and generated secrets, wherever fornax, certbot or Forge put them. */
export const ETC_UNTRACKED = ["/fornax/secrets/", "/fornax/hook-secrets/", "/fornax/tls/", "/letsencrypt/archive/", "/letsencrypt/keys/", "/nginx/ssl/", "/ssl/private/", "/ssh/ssh_host_*_key"];

export function historyResources(ctx: ModuleCtx): Resource[] {
  if (ctx.server.history === false) return [];
  const o = { owner: "history" };
  const block = [MARK, ...ETC_UNTRACKED].join("\n");
  const tracked = `git -C /etc ls-files -- ${ETC_UNTRACKED.map((p) => q(p.replace(/^\//, "").replace(/\/$/, ""))).join(" ")}`;
  return [
    // before etckeeper's first commit: what is ignored then never enters the history at all
    check("etc-ignore", "keep keys and secrets out of /etc's history (/etc/.gitignore)", `grep -qxF ${q(MARK)} /etc/.gitignore`, `printf '\\n%s\\n' ${q(block)} >> /etc/.gitignore`, o),
    packages("history", ["etckeeper", "git"], o),
    check("etckeeper", "/etc kept in git (etckeeper)", "git -C /etc rev-parse --verify HEAD", `[ -d /etc/.git ] || etckeeper init; etckeeper commit ${q("fornax: /etc history starts")} >/dev/null 2>&1 || true; git -C /etc rev-parse --verify HEAD`, o),
    // where etckeeper ran before fornax came: stop tracking what was committed already
    check("etc-untracked", "no keys or secrets tracked in /etc's history", `[ -z "$(${tracked})" ]`, `git -C /etc rm -r -q --cached --ignore-unmatch -- ${ETC_UNTRACKED.map((p) => q(p.replace(/^\//, "").replace(/\/$/, ""))).join(" ")}; etckeeper commit ${q("fornax: stop tracking keys and secrets")} >/dev/null 2>&1 || true`, o),
  ];
}
