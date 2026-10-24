import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "../core/command.ts";
import { FornaxError, fail } from "../core/errors.ts";
import { findSite, loadFleet, stateDir, type Fleet, type ResolvedSite } from "../core/fleet.ts";
import { DEPLOY_KEY, DEPLOY_LOG_DIR, HOOK_SECRET_DIR, REQUEST_DIR, repoUrl } from "../core/runtime.ts";
import type { Server } from "../core/schema.ts";
import { ensureServerBinary } from "../core/server-binary.ts";
import { asUser, b64, q } from "../core/shell.ts";
import { runnerFor, tail } from "../core/ssh.ts";
import { GitHub, sameKey } from "../githost/github.ts";
import { serve } from "../remote/hook.ts";
import { siteHookUrl } from "../modules/site.ts";
import { loadRuntime, notify, release, type ReleaseResult } from "../remote/release.ts";

// ---- internal: run on the server -------------------------------------------------

defineCommand({
  name: "release",
  summary: "(server) build and activate a release of a site — started by fornax-deploy@<site>.service",
  tier: "write",
  internal: true,
  args: [{ name: "site", help: "site domain", required: true }],
  options: { rollback: { type: "boolean", help: "switch back to the previous release" }, to: { type: "string", help: "with --rollback: release id" } },
  async run(input) {
    const r = await release(String(input.site), { rollback: Boolean(input.rollback), to: input.to as string | undefined });
    return { data: r, human: "", exitCode: r.status === "success" || (input.rollback && r.status === "rolled_back") ? 0 : 1 };
  },
});

defineCommand({
  name: "notify-test",
  summary: "(server) send a test deploy notification for a site",
  tier: "write",
  internal: true,
  args: [{ name: "site", help: "site domain", required: true }],
  async run(input) {
    const rt = loadRuntime(String(input.site));
    if (!rt.notify.ntfy && !rt.notify.url) fail("no_notify", `no notification target in the deploy config of ${rt.domain}`, "set notify.ntfy in fornax.yaml, then plan + apply");
    const now = new Date().toISOString();
    const lines: string[] = [];
    await notify({ ...rt, notify: { ...rt.notify, on: "always", github_status: false } }, { site: rt.domain, status: "failed", release: null, previous: null, sha: null, started: now, finished: now, seconds: 0, error: "test notification from `fornax notify test` — nothing happened", log: "-", source: "test" }, (l) => lines.push(l));
    return { data: { site: rt.domain, results: lines }, human: lines.join("\n") };
  },
});

defineCommand({
  name: "notify test",
  summary: "send a test notification from the site's server (as a failed deploy would)",
  tier: "write",
  args: [{ name: "site", help: "site domain", required: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    await ensureServerBinary(fleet, server, ctx.log);
    const res = await runnerFor(fleet, server).run(`/usr/local/bin/fornax notify-test ${q(site.domain)}`, { allowFail: true });
    if (res.code !== 0) fail("notify_failed", `test notification for ${site.domain} failed`, tail(res.stdout + res.stderr, 8), `fornax plan ${server.server}`);
    return { data: { site: site.domain, output: res.stdout.trim() }, human: res.stdout.trim() };
  },
});

defineCommand({
  name: "hook serve",
  summary: "(server) webhook receiver on 127.0.0.1 — runs as fornax-hook.service",
  tier: "write",
  internal: true,
  options: { port: { type: "number", help: "port", default: 9300 } },
  async run(input) {
    serve(Number(input.port));
    await new Promise(() => {});
    return { data: null };
  },
});

// ---- deploy / rollback / releases -------------------------------------------------

function ensureDeployable(site: ResolvedSite) {
  if (!site.spec.repo) fail("no_repo", `${site.domain} has no repo to deploy`, "set `repo:` for the site in the fleet config");
  if (!site.spec.deploy.enabled) fail("deploy_disabled", `deploys are disabled for ${site.domain} (deploy.enabled: false)`);
}

async function lastResult(fleet: Fleet, server: Server, site: ResolvedSite): Promise<ReleaseResult | null> {
  const out = await runnerFor(fleet, server).run(`f=$(ls -t ${DEPLOY_LOG_DIR(site.user)}/*.json 2>/dev/null | head -1); [ -n "$f" ] && cat "$f" || true`);
  return out.stdout.trim() ? (JSON.parse(out.stdout) as ReleaseResult) : null;
}

defineCommand({
  name: "deploy",
  summary: "deploy a site now (same path as push-to-deploy: fornax-deploy@<site> on the server)",
  tier: "write",
  args: [{ name: "site", help: "site domain", required: true }],
  options: {
    ref: { type: "string", help: "commit sha to deploy (default: head of the branch)" },
  },
  examples: ["fornax deploy shop.example.com", "fornax deploy shop.example.com --ref 3f2a…"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    ensureDeployable(site);
    const ref = input.ref ? String(input.ref) : undefined;
    if (ref && !/^[0-9a-f]{7,40}$/.test(ref)) fail("invalid_option", "--ref must be a commit sha");
    const unit = `fornax-deploy@${site.domain}.service`;
    const script = `[ -f /etc/fornax/sites/${site.domain}.json ] || { echo "site not set up for deploys on this server" >&2; exit 3; }
mkdir -p ${REQUEST_DIR}
printf %s ${q(b64(JSON.stringify({ sha: ref, source: "cli", at: new Date().toISOString() })))} | base64 -d > ${REQUEST_DIR}/${site.domain}.json
journalctl -n0 -f -o cat -u ${q(unit)} & J=$!
systemctl start ${q(unit)}; rc=$?
sleep 1; kill $J 2>/dev/null; wait $J 2>/dev/null
exit $rc`;
    await ensureServerBinary(fleet, server, ctx.log);
    ctx.log(`deploying ${site.domain} on ${server.server} …`);
    const res = await runnerFor(fleet, server).run(script, { allowFail: true, timeoutMs: 1_900_000, onStdout: (l) => ctx.log(`  ${l}`) });
    if (res.code === 3) fail("not_set_up", `${site.domain} is not set up for deploys on ${server.server}`, undefined, `fornax plan ${server.server} --site ${site.domain}`);
    const result = await lastResult(fleet, server, site);
    if (!result) throw new FornaxError("deploy_failed", "deploy did not produce a result", tail(res.stdout + res.stderr, 15));
    const ok = result.status === "success";
    return {
      data: { ...result, next: ok ? null : result.status === "rolled_back" ? `fornax logs ${site.domain} deploy` : `fornax logs ${site.domain} deploy` },
      human: `${result.status === "success" ? "✓" : "✗"} ${site.domain}: ${result.status} in ${result.seconds}s — release ${result.release ?? "-"} (${result.sha?.slice(0, 12) ?? "?"})${result.error ? `\n  ${result.error}` : ""}\nlog: ${result.log}`,
      exitCode: ok ? 0 : 1,
    };
  },
});

defineCommand({
  name: "rollback",
  summary: "switch a site back to its previous release (no rebuild); in-place sites rebuild the previously deployed commit",
  tier: "write",
  args: [{ name: "site", help: "site domain", required: true }],
  options: { to: { type: "string", help: "release id (in-place sites: commit sha); default: the one before the current" } },
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    ensureDeployable(site);
    await ensureServerBinary(fleet, server, ctx.log);
    const res = await runnerFor(fleet, server).run(`/usr/local/bin/fornax release ${q(site.domain)} --rollback${input.to ? ` --to ${q(String(input.to))}` : ""}`, {
      allowFail: true,
      onStdout: (l) => ctx.log(`  ${l}`),
    });
    const result = await lastResult(fleet, server, site);
    if (res.code !== 0 || !result || result.status !== "rolled_back") {
      fail("rollback_failed", result?.error ?? "rollback failed", tail(res.stdout + res.stderr, 10));
    }
    return { data: result, human: `rolled back ${site.domain} to ${result!.release ?? "commit"} (${result!.sha?.slice(0, 12)})` };
  },
});

defineCommand({
  name: "releases",
  summary: "releases of a site on its server and the latest deploys",
  tier: "read",
  args: [{ name: "site", help: "site domain", required: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    // git inside the site's tree runs as the site user: as root it would honour the repo's own config
    const tree = `cur=$(readlink ${q(site.current)} 2>/dev/null | xargs -r basename)
for d in $(ls -1 ${q(site.root)}/releases 2>/dev/null | sort -r); do printf 'release\\t%s|%s|%s\\n' "$d" "$(git -C ${q(site.root)}/releases/$d rev-parse --short=12 HEAD 2>/dev/null)" "$([ "$d" = "$cur" ] && echo current)"; done
${site.inPlace ? `printf 'inplace\\t%s\\n' "$(git -C ${q(site.root)} rev-parse --short=12 HEAD 2>/dev/null)"` : "true"}`;
    const out = await runnerFor(fleet, server).run(`${asUser(site.user, tree)}
for f in $(ls -t ${DEPLOY_LOG_DIR(site.user)}/*.json 2>/dev/null | head -10); do printf 'deploy\\t%s\\n' "$(tr -d '\\n' < "$f")"; done`);
    const releases: Array<{ release: string; commit: string; current: boolean }> = [];
    const deploys: ReleaseResult[] = [];
    let inPlace: string | null = null;
    for (const line of out.stdout.split("\n")) {
      if (line.startsWith("inplace\t")) inPlace = line.slice(8) || "?";
      if (line.startsWith("release\t")) {
        const [release, commit, cur] = line.slice(8).split("|");
        releases.push({ release: release!, commit: commit ?? "", current: cur === "current" });
      } else if (line.startsWith("deploy\t")) deploys.push(JSON.parse(line.slice(7)) as ReleaseResult);
    }
    const human = [
      ...(site.inPlace ? [`deployed in place at ${inPlace ?? "?"} (${site.root})`] : ["releases:", ...releases.map((r) => `  ${r.current ? "*" : " "} ${r.release}  ${r.commit}`)]),
      "recent deploys:",
      ...deploys.map((d) => `  ${d.started.slice(0, 19)}  ${d.status.padEnd(11)} ${d.source.padEnd(8)} ${d.sha?.slice(0, 12) ?? "-"}  ${d.seconds}s${d.error ? `  ${d.error}` : ""}`),
    ].join("\n");
    return { data: { site: site.domain, mode: site.inPlace ? "in_place" : "releases", ...(site.inPlace ? { commit: inPlace } : { releases }), deploys }, human };
  },
});

// ---- git host -------------------------------------------------------------------

async function readKeyAndSecret(fleet: Fleet, server: Server, site: ResolvedSite) {
  const out = await runnerFor(fleet, server).run(
    `printf 'key\\t'; ${asUser(site.user, `cat ${q(DEPLOY_KEY(site.user) + ".pub")} 2>/dev/null || echo`)}; printf 'secret\\t'; cat ${q(`${HOOK_SECRET_DIR}/${site.domain}`)} 2>/dev/null || echo`,
  );
  const get = (k: string) => out.stdout.split("\n").find((l) => l.startsWith(`${k}\t`))?.slice(k.length + 1).trim() || null;
  return { key: get("key"), secret: get("secret") };
}

defineCommand({
  name: "git key",
  summary: "public deploy key of a site — add it as a read-only deploy key at your git host",
  tier: "read",
  args: [{ name: "site", help: "site domain", required: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    const { key } = await readKeyAndSecret(fleet, server, site);
    if (!key) fail("no_deploy_key", `${site.domain} has no deploy key yet`, "it is created by apply for ssh repos", `fornax plan ${server.server} --site ${site.domain}`);
    return { data: { site: site.domain, public_key: key }, human: key! };
  },
});

defineCommand({
  name: "git connect",
  summary: "register the deploy key (read-only) and the push webhook at GitHub",
  tier: "write",
  args: [{ name: "site", help: "site domain", required: true }],
  options: {
    "replace-forge": { type: "boolean", help: "also remove Laravel Forge's push webhook from the repo (after fornax's is in place)" },
    "forge-hook": { type: "string", help: "with --replace-forge: id of the Forge webhook to remove when the repo has several (other Forge sites may deploy from the same repo)" },
    "key-only": { type: "boolean", help: "only the deploy key, no webhook (servers without push-to-deploy, e.g. a copy deployed with `fornax deploy`)" },
  },
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    ensureDeployable(site);
    const repo = repoUrl(site.spec.repo!).github;
    if (!repo) fail("not_github", `${site.spec.repo} is not a GitHub repo`, "add the key from `fornax git key` and a webhook to /fornax/hook/<site> by hand");
    const keyOnly = Boolean(input.keyOnly);
    if (keyOnly && input.replaceForge) fail("invalid_option", "--key-only cannot replace Forge's webhook", "without fornax's webhook, pushes would no longer deploy at all");
    // the site's own domain carries its webhook once fornax writes its vhost; a site still on Forge's
    // vhost only has the server's webhook hostname, if there is one
    const viaSite = site.spec.generate.vhost;
    if (!keyOnly && !viaSite && !server.webhook?.domain) {
      fail("no_webhook", `${site.domain} still has Forge's vhost and ${server.server} no webhook.domain, so there is no webhook URL yet`, "convert the site's web area first (fornax site convert --only web) — or pass --key-only and deploy with `fornax deploy`");
    }
    const gh = GitHub.fromEnvironment();
    // Several Forge hooks mean several Forge sites deploy this repo (e.g. production + a copy):
    // never guess which one belongs to this site. Checked before anything is changed.
    const forgeHooks = input.replaceForge ? (await gh.listHooks(repo!)).filter((x) => x.config.url?.startsWith("https://forge.laravel.com/")) : [];
    let toRemove = forgeHooks;
    if (input.replaceForge && forgeHooks.length > 1) {
      if (!input.forgeHook) {
        fail(
          "ambiguous_forge_hook",
          `${repo} has ${forgeHooks.length} Forge webhooks — other Forge sites deploy from it too`,
          `hook ids: ${forgeHooks.map((h) => h.id).join(", ")}; the one of this site is usually the newest (the Forge UI shows its URL under the site's deployment settings)`,
          `fornax git connect ${site.domain} --replace-forge --forge-hook <id>`,
        );
      }
      toRemove = forgeHooks.filter((h) => String(h.id) === String(input.forgeHook));
      if (!toRemove.length) fail("unknown_forge_hook", `${repo} has no Forge webhook ${input.forgeHook}`, `Forge hooks: ${forgeHooks.map((h) => h.id).join(", ")}`);
    }
    const { key, secret } = await readKeyAndSecret(fleet, server, site);
    if (!key || (!keyOnly && !secret)) fail("not_set_up", `deploy key or webhook secret missing on ${server.server}`, undefined, `fornax plan ${server.server} --site ${site.domain}`);
    const url = viaSite ? siteHookUrl(site) : `https://${server.webhook?.domain}/fornax/hook/${site.domain}`;
    const done: string[] = [];
    const keys = await gh.listKeys(repo!);
    if (!keys.some((k) => sameKey(k.key, key!))) {
      await gh.addKey(repo!, `fornax ${server.server} ${site.domain}`, key!);
      done.push("added deploy key");
    } else done.push("deploy key already present");
    if (keyOnly) return { data: { site: site.domain, repo, webhook: null, actions: done }, human: `${repo}: ${done.join(", ")} (no webhook: deploy with \`fornax deploy ${site.domain}\`)` };
    // never point GitHub at a URL that does not answer: a signed ping must come back from fornax's
    // webhook (it deploys nothing) — otherwise the old hook stays as it is
    await pingHook(url, secret!, site);
    // fornax hooks of this site at older URLs (the server's webhook hostname, /anvil/ from before the
    // rename) move to the new one — one hook per site, never two that deploy the same push
    const ours = (await gh.listHooks(repo!)).filter((h) => h.config.url === url || new RegExp(`/(fornax|anvil)/hook/${site.domain.replace(/\./g, "\\.")}$`).test(h.config.url ?? ""));
    if (ours.length) {
      await gh.updateHook(repo!, ours[0]!.id, url, secret!);
      done.push(ours[0]!.config.url === url ? "updated webhook" : `moved webhook from ${ours[0]!.config.url}`);
      for (const h of ours.slice(1)) {
        await gh.deleteHook(repo!, h.id);
        done.push(`removed duplicate webhook ${h.id}`);
      }
    } else {
      await gh.addHook(repo!, url, secret!);
      done.push("added webhook");
    }
    if (input.replaceForge) {
      // only now that fornax's hook exists: there is never a moment without push-to-deploy
      for (const h of toRemove) {
        await gh.deleteHook(repo!, h.id);
        done.push(`removed Forge webhook ${h.id}`);
      }
    }
    return { data: { site: site.domain, repo, webhook: url, actions: done }, human: `${repo}: ${done.join(", ")}\nwebhook → ${url}` };
  },
});

/** A signed GitHub "ping" to the site's webhook: proves the URL reaches fornax-hook with this secret. */
async function pingHook(url: string, secret: string, site: ResolvedSite): Promise<void> {
  const body = JSON.stringify({ zen: "fornax git connect", hook_id: 0 });
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": sig, "user-agent": "GitHub-Hookshot/fornax" },
      body,
      // a self-signed site (test servers) is still worth checking
      ...(site.tlsIssuer === "selfsigned" ? { tls: { rejectUnauthorized: false } } : {}),
    } as RequestInit);
  } catch (e) {
    fail("hook_unreachable", `${url} cannot be reached: ${(e as Error).message}`, "does the name point at the server, and is the site's vhost applied? (fornax plan)");
  }
  const text = await res!.text();
  if (res!.status !== 200 || !text.includes("pong")) {
    fail("hook_unreachable", `${url} did not answer as fornax's webhook (HTTP ${res!.status})`, res!.status === 403 ? "a proxy or the site's own rules block it (e.g. Cloudflare's bot protection): let POSTs to /.well-known/fornax-hook through" : `the site's vhost needs the hook first: fornax plan <server> and apply; answer: ${text.slice(0, 120)}`);
  }
}

// ---- .env -----------------------------------------------------------------------

const envLocal = (fleet: Fleet, site: ResolvedSite) => join(stateDir(fleet, "env"), `${site.domain}.env`);

function parseEnv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    const x = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (x) m.set(x[1]!, x[2]!);
  }
  return m;
}

function envDiff(server: string, local: string) {
  const a = parseEnv(server);
  const b = parseEnv(local);
  return {
    added: [...b.keys()].filter((k) => !a.has(k)),
    removed: [...a.keys()].filter((k) => !b.has(k)),
    changed: [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)),
  };
}

async function readEnv(fleet: Fleet, server: Server, site: ResolvedSite): Promise<string> {
  // as the site user: a symlinked .env must not hand out a file only root may read
  const out = await runnerFor(fleet, server).run(asUser(site.user, `[ -f ${q(site.root + "/.env")} ] && base64 -w0 ${q(site.root + "/.env")} || echo MISSING`));
  if (out.stdout.trim() === "MISSING") fail("no_env", `${site.root}/.env does not exist on ${server.server}`);
  return Buffer.from(out.stdout.trim(), "base64").toString("utf8");
}

defineCommand({
  name: "env pull",
  summary: "copy a site's .env from the server to <fleet>/.fornax/env/<site>.env (git-ignored, 0600)",
  tier: "read",
  args: [{ name: "site", help: "site domain", required: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    const text = await readEnv(fleet, server, site);
    const path = envLocal(fleet, site);
    writeFileSync(path, text);
    chmodSync(path, 0o600);
    return { data: { site: site.domain, file: path, keys: parseEnv(text).size }, human: `${site.domain}/.env → ${path} (${parseEnv(text).size} keys)\nedit it, then: fornax env push ${site.domain}` };
  },
});

defineCommand({
  name: "env diff",
  summary: "which keys differ between the local copy and the server's .env (values are never shown)",
  tier: "read",
  args: [{ name: "site", help: "site domain", required: true }],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    const path = envLocal(fleet, site);
    if (!existsSync(path)) fail("no_local_env", `no local copy at ${path}`, undefined, `fornax env pull ${site.domain}`);
    const d = envDiff(await readEnv(fleet, server, site), readFileSync(path, "utf8"));
    const same = !d.added.length && !d.removed.length && !d.changed.length;
    return { data: { site: site.domain, ...d, in_sync: same }, human: same ? "no differences" : [...d.added.map((k) => `+ ${k}`), ...d.changed.map((k) => `~ ${k}`), ...d.removed.map((k) => `- ${k}`)].join("\n") };
  },
});

defineCommand({
  name: "env push",
  summary: "upload the local .env copy to the server (backup kept), then refresh the config cache",
  tier: "write",
  args: [{ name: "site", help: "site domain", required: true }],
  options: { file: { type: "string", help: "env file to upload (default: <fleet>/.fornax/env/<site>.env)" } },
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    const path = input.file ? String(input.file) : envLocal(fleet, site);
    if (!existsSync(path)) fail("no_local_env", `no env file at ${path}`, undefined, `fornax env pull ${site.domain}`);
    const local = readFileSync(path, "utf8");
    let before = "";
    try {
      before = await readEnv(fleet, server, site);
    } catch {
      /* first upload */
    }
    const d = envDiff(before, local);
    const env = `${site.root}/.env`;
    const refresh = site.spec.preset === "laravel" ? `[ -f ${q(site.current)}/artisan ] && runuser -u ${site.user} -- bash -c ${q(`cd ${site.current} && php${site.php} artisan optimize >/dev/null`)} || true; systemctl reload php${site.php}-fpm || true` : "true";
    const write = `set -e; umask 027
[ ! -f ${q(env)} ] || cp -p ${q(env)} ${q(env)}.fornax-$(date +%Y%m%d%H%M%S)
printf %s ${q(b64(local))} | base64 -d > ${q(env)}.fornax-new
chmod 0640 ${q(env)}.fornax-new; mv -f ${q(env)}.fornax-new ${q(env)}`;
    await runnerFor(fleet, server).run(`set -e
${asUser(site.user, write)}
${refresh}`);
    mkdirSync(join(fleet.dir, ".fornax"), { recursive: true });
    return { data: { site: site.domain, ...d }, human: `pushed .env to ${site.domain} (+${d.added.length} ~${d.changed.length} -${d.removed.length} keys), previous copy kept next to it` };
  },
});
