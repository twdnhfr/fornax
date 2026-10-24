/**
 * `fornax release <site>` — runs ON the server (as root, via fornax-deploy@<site>.service).
 * Clones into releases/<ts>, links shared paths, builds, switches `current` atomically,
 * reloads, health-checks (rolling back on failure), prunes old releases and reports.
 * Node apps switch between two slots instead (switchNode): the new release runs next to the old one.
 * In-place sites (taken over from Forge without zero-downtime) are their own checkout:
 * fetch, reset to the commit, build in place; a rollback rebuilds an older commit.
 */
import { appendFileSync, chownSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { DEPLOY_KEY, DEPLOY_LOG_DIR, KNOWN_HOSTS, nodeUpstreamConf, REQUEST_DIR, RUNTIME_DIR, SITE_LOG_DIR, type SiteRuntime } from "../core/runtime.ts";
import { RETENTION } from "../core/plan.ts";

export interface ReleaseResult {
  site: string;
  status: "success" | "failed" | "rolled_back";
  release: string | null;
  previous: string | null;
  sha: string | null;
  started: string;
  finished: string;
  seconds: number;
  error?: string;
  log: string;
  source: string;
}

class StepError extends Error {}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

export function loadRuntime(domain: string): SiteRuntime {
  const p = join(RUNTIME_DIR, `${domain}.json`);
  if (!existsSync(p)) throw new StepError(`no deploy config ${p} — run \`fornax plan\`/\`apply\` for this site first`);
  return JSON.parse(readFileSync(p, "utf8")) as SiteRuntime;
}

function ids(user: string): { uid: number; gid: number } {
  const r = Bun.spawnSync(["id", "-u", user]);
  const g = Bun.spawnSync(["id", "-g", user]);
  return { uid: Number(r.stdout.toString().trim()), gid: Number(g.stdout.toString().trim()) };
}

export async function release(domain: string, o: { rollback?: boolean; to?: string; restart?: boolean } = {}): Promise<ReleaseResult> {
  const rt = loadRuntime(domain);
  const unlock = await lock(domain);
  try {
    return await releaseLocked(domain, rt, o);
  } finally {
    unlock();
  }
}

/**
 * One run per site at a time: a deploy, a rollback and a restart (after `apply` changed a node
 * app's units) would otherwise move `current` and the slots under each other. The later one waits.
 */
async function lock(domain: string): Promise<() => void> {
  const dir = "/run/fornax-release";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${domain}.lock`);
  for (let waited = 0; waited < 1800; waited++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => rmSync(path, { force: true });
    } catch {
      const pid = Number(readSafe(path));
      // left behind by a run that died
      if (!pid || !existsSync(`/proc/${pid}`)) rmSync(path, { force: true });
      else {
        if (waited === 0) process.stdout.write(`=> waiting for the run of ${domain} in progress (pid ${pid})\n`);
        await Bun.sleep(1000);
      }
    }
  }
  throw new StepError(`another deploy of ${domain} has been running for 30 minutes`);
}

async function releaseLocked(domain: string, rt: SiteRuntime, o: { rollback?: boolean; to?: string; restart?: boolean }): Promise<ReleaseResult> {
  const started = new Date();
  const ts = stamp();
  const { uid, gid } = ids(rt.user);
  const who = { uid, gid };
  // root-owned, outside the site's home (`plan`/`apply` creates them; servers not applied since get them here)
  if (!existsSync(SITE_LOG_DIR(rt.user))) {
    mkdirSync(SITE_LOG_DIR(rt.user), { recursive: true, mode: 0o750 });
    chownSync(SITE_LOG_DIR(rt.user), 0, gid);
  }
  const logDir = DEPLOY_LOG_DIR(rt.user);
  mkdirSync(logDir, { recursive: true, mode: 0o750 });
  const logPath = join(logDir, `${ts}${o.rollback ? "-rollback" : o.restart ? "-restart" : ""}.log`);
  writeFileSync(logPath, "");
  const log = (line: string) => {
    appendFileSync(logPath, line + "\n");
    process.stdout.write(line + "\n");
  };

  // a restart leaves a push that is waiting to be deployed alone
  const request = o.restart ? null : readRequest(domain);
  const source = o.rollback ? "rollback" : o.restart ? "restart" : (request?.source ?? "cli");
  const releases = join(rt.root, "releases");
  const current = join(rt.root, "current");
  const previous = existsSync(current) ? readlinkSync(current) : null;
  const result: ReleaseResult = {
    site: domain,
    status: "failed",
    release: null,
    previous,
    sha: null,
    started: started.toISOString(),
    finished: "",
    seconds: 0,
    log: logPath,
    source,
  };

  /** Run a command; as the site user unless asRoot. Output goes to the deploy log. */
  const run = (cmd: string, opts: { asRoot?: boolean; cwd?: string; allowFail?: boolean; env?: Record<string, string> } = {}) => {
    log(`$ ${cmd}`);
    const env = {
      HOME: `/home/${rt.user}`,
      USER: rt.user,
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      COMPOSER_ALLOW_SUPERUSER: "0",
      LANG: "C.UTF-8",
      ...opts.env,
    };
    // setpriv instead of runuser/sudo: no PAM session, so nothing extra lands in the journal
    const argv = opts.asRoot
      ? ["bash", "-c", cmd]
      : ["setpriv", `--reuid=${uid}`, `--regid=${gid}`, "--init-groups", "--", "env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "bash", "-c", cmd];
    const p = Bun.spawnSync(argv, { cwd: opts.cwd ?? "/", env: opts.asRoot ? { ...process.env, ...env } : undefined, stdout: "pipe", stderr: "pipe" });
    const out = (p.stdout.toString() + p.stderr.toString()).trimEnd();
    if (out) log(out);
    if (p.exitCode !== 0 && !opts.allowFail) throw new StepError(`command failed (exit ${p.exitCode}): ${cmd}`);
    return { code: p.exitCode ?? 1, out };
  };

  const reload = () => {
    if (rt.preset !== "static" && rt.preset !== "node") run(`systemctl reload php${rt.php}-fpm`, { asRoot: true, allowFail: true });
    const live = rt.mode === "in_place" ? rt.root : current;
    if (rt.preset === "laravel" && existsSync(join(live, "artisan"))) run(`php${rt.php} artisan queue:restart`, { cwd: live, allowFail: true });
    for (const p of rt.programs.filter((p) => /^[\w.-]+$/.test(p))) run(`supervisorctl restart '${p}:*'`, { asRoot: true, allowFail: true });
  };

  const activate = (target: string) => {
    run(`ln -sfn '${target}' '${current}.fornax-tmp' && mv -Tf '${current}.fornax-tmp' '${current}'`);
  };

  /**
   * Blue/green for node apps: `dir` starts in the idle slot, next to the live one, and must answer
   * on its own port; then nginx is switched to it (validated reload), and the old slot stops once
   * nginx's old workers have finished their requests. Before the switch, a failure stops the new
   * slot and throws — the live one never noticed. After it, a failed check through nginx switches
   * back ("rolled_back").
   */
  const switchNode = async (dir: string): Promise<"ok" | "rolled_back"> => {
    const n = rt.node!;
    const conf = readSafe(n.upstream.file);
    const pointed = n.slots.find((x) => conf?.includes(`server 127.0.0.1:${x.port};`));
    // the new release goes to the slot nginx does not point at; the other one serves, if it runs
    const next = n.slots.find((x) => x !== (pointed ?? n.slots[1]))!;
    const other = n.slots.find((x) => x !== next)!;
    const live = Bun.spawnSync(["systemctl", "is-active", "-q", other.unit]).exitCode === 0 && pointed === other ? other : undefined;
    // a slot that is stopped is done with: no "failed" state left behind for `fornax health` to report
    const unit = (verb: "restart" | "enable" | "disable --now", x: { unit: string }) =>
      verb === "disable --now"
        ? run(`systemctl disable --now '${x.unit}'; systemctl reset-failed '${x.unit}' 2>/dev/null || true`, { asRoot: true, allowFail: true })
        : run(`systemctl ${verb} '${x.unit}'`, { asRoot: true });
    log(`=> starting ${dir.split("/").pop()} in slot ${next.name} (port ${next.port})${live ? `; slot ${live.name} (port ${live.port}) keeps serving` : ""}`);
    run(`ln -sfn '${dir}' '${next.link}.fornax-tmp' && mv -Tf '${next.link}.fornax-tmp' '${next.link}'`);
    const appLog = join(SITE_LOG_DIR(rt.user), "app.log");
    const logFrom = existsSync(appLog) ? statSync(appLog).size : 0;
    unit("restart", next);
    if (!(await nodeCheck(rt, next, log, { path: appLog, from: logFrom }))) {
      unit("disable --now", next);
      throw new StepError(`the new release did not answer on port ${next.port} — ${live ? `slot ${live.name} keeps serving` : "nothing was serving before"}`);
    }
    // nginx is the only way in that knows the site's basic auth and IP rules
    const open = Bun.spawnSync(["ss", "-ltnH", `sport = :${next.port}`]).stdout.toString().split("\n").map((l) => l.trim().split(/\s+/)[3] ?? "").filter((a) => a && !/^(127\.0\.0\.1|\[::1\]):/.test(a));
    if (open.length) log(`   warning: the app listens on ${open.join(", ")}, not only on 127.0.0.1 — start it bound to 127.0.0.1 (e.g. next start -H 127.0.0.1)`);
    const point = (x: { port: number; name: string }) => {
      const before = conf ?? "";
      writeAtomic(n.upstream.file, nodeUpstreamConf(n.upstream.name, x.port));
      if (run("nginx -t -q", { asRoot: true, allowFail: true }).code !== 0) {
        writeAtomic(n.upstream.file, before);
        throw new StepError(`nginx rejected the switch to slot ${x.name} — nothing changed`);
      }
      run("systemctl reload nginx", { asRoot: true });
      // old workers finish what they started with the old upstream before that slot may stop
      // ("dow[n]": the pattern must not match this shell's own command line)
      run("sleep 0.3; for i in $(seq 300); do pgrep -f 'nginx: worker process is shutting dow[n]' >/dev/null || break; sleep 0.1; done", { asRoot: true, allowFail: true });
    };
    log(`=> switching nginx to slot ${next.name}`);
    unit("enable", next);
    try {
      point(next);
    } catch (e) {
      unit("disable --now", next);
      throw e;
    }
    activate(dir);
    reload();
    if (rt.health_check) {
      // the app itself passed on its port; through nginx, the site's basic auth or IP rules may
      // answer (401, 403) — only a gateway error or no answer says nginx does not reach the slot
      log(`=> health check after the switch ${rt.health_check.url}`);
      if (!(await healthCheck(rt, log, (code) => code >= 200 && code < 500))) {
        if (!live || !previous) throw new StepError("health check failed after the switch and there is no previous release to go back to");
        log(`=> health check failed — switching back to slot ${live.name}`);
        point(live);
        unit("disable --now", next);
        activate(previous);
        reload();
        return "rolled_back";
      }
    }
    if (live) log(`=> stopping slot ${live.name}`);
    unit("disable --now", other);
    return "ok";
  };

  const build = (dir: string) => {
    log("=> building");
    const vars = { SITE: domain, SITE_PATH: rt.root, RELEASE_PATH: dir, PHP: `php${rt.php}`, COMPOSER: `php${rt.php} /usr/local/bin/composer` };
    // ANVIL_* as well: deploy scripts and commands written before the rename keep working
    const env = Object.fromEntries(Object.entries(vars).flatMap(([k, v]) => [[`FORNAX_${k}`, v], [`ANVIL_${k}`, v]]));
    const legacyScript = join(dir, ".anvil", "deploy.sh");
    const custom = !existsSync(join(dir, rt.deploy_script)) && rt.deploy_script === ".fornax/deploy.sh" && existsSync(legacyScript) ? legacyScript : join(dir, rt.deploy_script);
    if (existsSync(custom)) {
      run(`bash '${custom}'`, { cwd: dir, env });
    } else if (rt.deploy_commands) {
      run(`set -e\n${rt.deploy_commands}`, { cwd: dir, env });
    } else if (rt.preset === "node") {
      // the project's own package manager: its lockfile says which
      const has = (f: string) => existsSync(join(dir, f));
      if (has("yarn.lock") || has("pnpm-lock.yaml")) throw new StepError("yarn and pnpm projects need their build in deploy.commands (or .fornax/deploy.sh)");
      const pm = has("bun.lock") || has("bun.lockb") || (!has("package-lock.json") && existsSync("/usr/local/bin/bun")) ? "bun" : "npm";
      if (pm === "bun" && !existsSync("/usr/local/bin/bun")) throw new StepError("the project uses bun (bun.lock), but bun is not on the server — add bun to the server's tools");
      const pkg = join(dir, "package.json");
      const scripts = existsSync(pkg) ? ((JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}) : {};
      if (existsSync(pkg)) run(pm === "bun" ? "bun install --frozen-lockfile" : has("package-lock.json") ? "npm ci" : "npm install", { cwd: dir, env });
      if (scripts.build) run(`${pm} run build`, { cwd: dir, env });
    } else {
      const php = `php${rt.php}`;
      const laravel = rt.preset === "laravel";
      if (laravel && !existsSync(join(dir, "artisan"))) {
        const has = (f: string) => existsSync(join(dir, f));
        const fits = has("public/index.php") || has("index.php") ? "php" : has("package.json") && /"start"\s*:/.test(readFileSync(join(dir, "package.json"), "utf8")) ? "node" : "static";
        throw new StepError(`the repo has no artisan — it is no Laravel app; preset ${fits} looks right: fornax site set ${domain} --preset ${fits}, then plan, apply and deploy again`);
      }
      if (existsSync(join(dir, "composer.json"))) run(`${php} /usr/local/bin/composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader --no-progress`, { cwd: dir, env });
      // before the frontend build: Tailwind also scans the compiled views in storage/framework/views
      if (laravel) run(`${php} artisan optimize`, { cwd: dir, env });
      const pkg = join(dir, "package.json");
      if (existsSync(pkg)) {
        const scripts = (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
        if (scripts.build) {
          run("bun install --frozen-lockfile || bun install", { cwd: dir, env });
          run("bun run build", { cwd: dir, env });
        }
      }
      // last: a release whose build failed never touches the database
      if (laravel) {
        run(`${php} artisan storage:link --force`, { cwd: dir, env, allowFail: true });
        run(`${php} artisan migrate --force`, { cwd: dir, env });
      }
    }
  };

  const gitSsh: Record<string, string> = rt.uses_deploy_key && existsSync(DEPLOY_KEY(rt.user)) ? { GIT_SSH_COMMAND: `ssh -i ${DEPLOY_KEY(rt.user)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${KNOWN_HOSTS}` } : {};

  try {
    if (rt.mode === "in_place") return await inPlace();
    if (o.restart) {
      if (!rt.node) throw new StepError("--restart is for node apps");
      if (!previous) {
        log("=> nothing deployed yet — nothing to restart");
        result.status = "success";
        return finish();
      }
      log(`=> restarting ${domain} without downtime: ${previous.split("/").pop()} in the other slot`);
      result.release = previous.split("/").pop() ?? null;
      result.sha = shaOf(who, previous);
      if ((await switchNode(previous)) !== "ok") throw new StepError("the restarted app failed its health check after the switch — the running one serves again");
      result.status = "success";
      return finish();
    }
    if (o.rollback) {
      const all = listReleases(releases);
      const cur = previous ? previous.split("/").pop() : undefined;
      const target = o.to ?? all.filter((r) => r < (cur ?? "~")).pop();
      if (!target || !all.includes(target)) throw new StepError(`no release to roll back to (current: ${cur ?? "none"}, available: ${all.join(", ") || "none"})`);
      log(`=> rolling back ${domain}: ${cur} → ${target}`);
      if (rt.node) {
        // like a deploy without the build: the old release must answer before it serves again
        if ((await switchNode(join(releases, target))) !== "ok") throw new StepError(`release ${target} failed its health check after the switch — ${cur} serves again`);
      } else {
        activate(join(releases, target));
        reload();
      }
      result.status = "rolled_back";
      result.release = target;
      result.sha = shaOf(who, join(releases, target));
      return finish();
    }

    const dir = join(releases, ts);
    result.release = ts;
    log(`=> deploying ${domain} (${rt.repo_url} ${request?.sha ?? rt.branch}) into ${dir}`);
    run(`git clone --quiet --depth 1 --branch '${rt.branch}' '${rt.repo_url}' '${dir}'`, { env: gitSsh });
    if (request?.sha) {
      const head = run(`git -C '${dir}' rev-parse HEAD`).out.trim();
      if (!head.startsWith(request.sha)) run(`git -C '${dir}' fetch --quiet --depth 1 origin '${request.sha}' && git -C '${dir}' checkout --quiet FETCH_HEAD`, { env: gitSsh });
    }
    result.sha = run(`git -C '${dir}' rev-parse HEAD`).out.trim();

    log("=> linking shared files");
    for (const name of [".env", "auth.json"]) {
      if (existsSync(join(rt.root, name))) run(`ln -sfn '${join(rt.root, name)}' '${join(dir, name)}'`);
    }
    for (const p of rt.shared) {
      const target = join(rt.root, p);
      const inRelease = join(dir, p);
      if (!existsSync(target)) run(existsSync(inRelease) ? `mv '${inRelease}' '${target}'` : `mkdir -p '${target}'`);
      if (p === "storage" && rt.preset === "laravel") {
        run(`mkdir -p '${target}/app/public' '${target}/framework/cache/data' '${target}/framework/sessions' '${target}/framework/views' '${target}/logs'`);
      }
      run(`rm -rf '${inRelease}' && mkdir -p "$(dirname '${inRelease}')" && ln -s '${target}' '${inRelease}'`);
    }

    build(dir);

    if (rt.node) {
      if ((await switchNode(dir)) === "ok") {
        prune(who, releases, rt.keep_releases, ts, log);
        result.status = "success";
      } else {
        result.status = "rolled_back";
        result.error = "health check failed after the switch";
        removeTree(who, dir);
        result.release = previous?.split("/").pop() ?? null;
        result.sha = previous ? shaOf(who, previous) : null;
      }
      return finish();
    }

    // Health check BEFORE switching: nginx serves releases/next on a local socket. A broken
    // release never goes live; the check after activation below stays as a second net.
    const next = join(rt.root, "next");
    if (rt.health_check && rt.preview_socket && existsSync(rt.preview_socket)) {
      run(`ln -sfn '${dir}' '${next}'`);
      log(`=> health check before activation (releases/${ts} via ${rt.preview_socket})`);
      const ok = await previewCheck(rt, log);
      removeTree(who, next);
      if (!ok) throw new StepError("health check failed before activation — the current release was not touched");
    }

    log("=> activating");
    activate(dir);
    reload();

    if (rt.health_check) {
      log(`=> health check after activation ${rt.health_check.url}`);
      const ok = await healthCheck(rt, log);
      if (!ok) {
        if (previous && existsSync(previous)) {
          log(`=> health check failed — rolling back to ${previous}`);
          activate(previous);
          reload();
          result.status = "rolled_back";
          result.error = "health check failed";
          removeTree(who, dir);
          result.release = previous.split("/").pop() ?? null;
          result.sha = shaOf(who, previous);
          return finish();
        }
        throw new StepError("health check failed and there is no previous release to roll back to");
      }
    }

    prune(who, releases, rt.keep_releases, ts, log);
    result.status = "success";
    return finish();
  } catch (e) {
    result.status = "failed";
    result.error = (e as Error).message;
    log(`=> FAILED: ${result.error}`);
    // a failed build never becomes current; drop it so it cannot be rolled back to
    if (result.release && !o.rollback && !o.restart && readlinkSafe(current) !== join(releases, result.release)) {
      removeTree(who, join(releases, result.release));
    }
    return finish();
  }

  /** Deploy (or roll back) inside the site directory itself. */
  async function inPlace(): Promise<ReleaseResult> {
    const dir = rt.root;
    const git = (args: string, opts: { allowFail?: boolean } = {}) => run(`git -C '${dir}' ${args}`, { env: gitSsh, ...opts });
    if (!existsSync(join(dir, ".git"))) {
      // a new site: the (empty) site directory becomes the checkout
      const empty = !existsSync(dir) || readdirSync(dir).length === 0;
      if (!empty || o.rollback) throw new StepError(`${dir} is not a git checkout — in-place deploys need the site directory to be one (or empty, for the first deploy)`);
      log(`=> first deploy: cloning ${rt.repo_url} into ${dir}`);
      run(`git clone --quiet --branch '${rt.branch}' '${rt.repo_url}' '${dir}'`, { env: gitSsh });
    }
    // hand edits on the server are never thrown away silently
    const dirty = git("status --porcelain --untracked-files=no").out.trim();
    if (dirty) throw new StepError(`tracked files were changed on the server — commit or discard them first:\n${dirty}`);
    const before = git("rev-parse HEAD").out.trim();
    result.previous = before;
    let target: string;
    if (o.rollback) {
      target = o.to ?? previousDeployed(logDir, before) ?? "";
      if (!/^[0-9a-f]{7,40}$/.test(target)) throw new StepError(`no earlier deployed commit to roll back to (current: ${before.slice(0, 12)}); pass --to <sha>`);
      log(`=> rolling back ${domain} in place: ${before.slice(0, 12)} → ${target.slice(0, 12)}`);
      if (git(`cat-file -e '${target}^{commit}'`, { allowFail: true }).code !== 0) git(`fetch --quiet '${rt.repo_url}' '${target}'`);
    } else {
      log(`=> deploying ${domain} in place (${rt.repo_url} ${request?.sha ?? rt.branch}) in ${dir}`);
      git(`fetch --quiet '${rt.repo_url}' '${rt.branch}'`);
      target = request?.sha ?? git("rev-parse FETCH_HEAD").out.trim();
      if (request?.sha && git(`cat-file -e '${target}^{commit}'`, { allowFail: true }).code !== 0) git(`fetch --quiet '${rt.repo_url}' '${target}'`);
    }
    const checkout = (sha: string) => {
      git(`reset --quiet --hard '${sha}'`);
      return git("rev-parse HEAD").out.trim();
    };
    result.sha = checkout(target);
    try {
      build(dir);
    } catch (e) {
      // the build may have half-replaced vendor/ or build output: put the previous commit back, built
      if (before !== result.sha) {
        log(`=> build failed — rebuilding the previous commit ${before.slice(0, 12)}`);
        result.sha = checkout(before);
        try {
          build(dir);
        } catch {
          log("=> the previous commit does not build either — the site may be broken");
        }
        reload();
      }
      throw e;
    }
    reload();
    if (rt.health_check) {
      log(`=> health check ${rt.health_check.url}`);
      if (!(await healthCheck(rt, log))) {
        if (before === result.sha) throw new StepError("health check failed (the commit did not change)");
        log(`=> health check failed — rebuilding the previous commit ${before.slice(0, 12)}`);
        result.sha = checkout(before);
        build(dir);
        reload();
        result.status = "rolled_back";
        result.error = "health check failed";
        return finish();
      }
    }
    result.status = o.rollback ? "rolled_back" : "success";
    return finish();
  }

  async function finish(): Promise<ReleaseResult> {
    const end = new Date();
    result.finished = end.toISOString();
    result.seconds = Math.round((end.getTime() - started.getTime()) / 100) / 10;
    log(`=> ${result.status} in ${result.seconds}s`);
    const jsonPath = logPath.replace(/\.log$/, ".json");
    writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    pruneDeployLogs(logDir);
    await notify(rt, result, log);
    return result;
  }
}

/**
 * What to roll an in-place site back to: the commit checked out before the deploy that brought
 * `current` (also when that was Forge's), else the newest other successfully deployed commit.
 */
function previousDeployed(logDir: string, current: string): string | null {
  const runs: ReleaseResult[] = [];
  for (const f of readdirSync(logDir).filter((f) => f.endsWith(".json")).sort().reverse()) {
    try {
      runs.push(JSON.parse(readFileSync(join(logDir, f), "utf8")) as ReleaseResult);
    } catch {}
  }
  const brought = runs.find((r) => r.status === "success" && r.sha === current);
  if (brought?.previous && /^[0-9a-f]{40}$/.test(brought.previous) && brought.previous !== current) return brought.previous;
  return runs.find((r) => r.status === "success" && r.sha && r.sha !== current)?.sha ?? null;
}

const readSafe = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** At most the last 64 KiB of what a file got after offset `from`. */
function readFrom(path: string, from: number): string {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(from, size - 65536);
      const buf = Buffer.alloc(Math.max(0, size - start));
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Root's own files only (the upstream of a node app, outside any home). */
function writeAtomic(path: string, content: string) {
  writeFileSync(`${path}.fornax-tmp`, content, { mode: 0o644 });
  renameSync(`${path}.fornax-tmp`, path);
}

/**
 * A node release in its slot, before nginx sends it anything: it must answer on its own port within
 * a minute (frameworks take a few seconds to boot). A process that exits gives up at once.
 */
async function nodeCheck(rt: SiteRuntime, slot: NonNullable<SiteRuntime["node"]>["slots"][number], log: (l: string) => void, appLog: { path: string; from: number }): Promise<boolean> {
  const hc = rt.health_check;
  const path = hc ? new URL(hc.url).pathname + new URL(hc.url).search : "/";
  const restarts = () => Number(Bun.spawnSync(["systemctl", "show", "-p", "NRestarts", "--value", slot.unit]).stdout.toString().trim()) || 0;
  const before = restarts();
  log(`=> health check before the switch: http://127.0.0.1:${slot.port}${path}`);
  let last = "";
  const t0 = Date.now();
  for (let i = 1; i <= 60; i++) {
    const p = Bun.spawnSync(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", "-H", `Host: ${rt.domain}`, "-H", `X-Forwarded-Proto: ${hc?.https ? "https" : "http"}`, `http://127.0.0.1:${slot.port}${path}`]);
    const code = Number(p.stdout.toString().trim());
    const seen = `HTTP ${code || "no answer"}`;
    if (seen !== last) log(`   after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${seen}`);
    last = seen;
    if (code >= 200 && code < 400) return true;
    const state = Bun.spawnSync(["systemctl", "is-active", slot.unit]).stdout.toString().trim();
    if (restarts() > before || state === "failed") {
      // what it wrote since it was started (both slots share the log; the live one is usually quiet)
      const out = readFrom(appLog.path, appLog.from).trimEnd().split("\n").slice(-20).join("\n");
      log(`   the process exited (${state})${out ? ":" : ""}`);
      if (out) log(out.replace(/^/gm, "   | "));
      return false;
    }
    await Bun.sleep(1000);
  }
  return false;
}

const readlinkSafe = (p: string) => {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
};

interface SiteIds {
  uid: number;
  gid: number;
}

/**
 * Everything inside a site's tree runs as the site user: as root, git would honour the repo's own
 * config and a recursive delete could be raced into following a symlink.
 */
function asSite(who: SiteIds, argv: string[]) {
  return Bun.spawnSync(["setpriv", `--reuid=${who.uid}`, `--regid=${who.gid}`, "--init-groups", "--", "env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/", ...argv]);
}

function shaOf(who: SiteIds, dir: string): string | null {
  const p = asSite(who, ["git", "-C", dir, "rev-parse", "HEAD"]);
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
}

const removeTree = (who: SiteIds, path: string) => asSite(who, ["rm", "-rf", "--", path]);

export function listReleases(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^\d{14}$/.test(n) && statSync(join(dir, n)).isDirectory())
    .sort();
}

function prune(who: SiteIds, dir: string, keep: number, current: string, log: (l: string) => void) {
  const all = listReleases(dir);
  const drop = all.slice(0, Math.max(0, all.length - keep)).filter((r) => r !== current);
  for (const r of drop) {
    removeTree(who, join(dir, r));
    log(`=> pruned release ${r}`);
  }
}

/** Keep the newest deploy logs (each deploy writes a .log and a .json). */
function pruneDeployLogs(dir: string) {
  const runs = [...new Set(readdirSync(dir).filter((f) => /\.(log|json)$/.test(f)).map((f) => f.replace(/\.(log|json)$/, "")))].sort();
  for (const run of runs.slice(0, Math.max(0, runs.length - RETENTION.deployLogs))) {
    for (const ext of [".log", ".json"]) rmSync(join(dir, run + ext), { force: true });
  }
}

interface DeployRequest {
  sha?: string;
  ref?: string;
  source?: string;
}

function readRequest(domain: string): DeployRequest | null {
  const p = join(REQUEST_DIR, `${domain}.json`);
  if (!existsSync(p)) return null;
  try {
    // written by the webhook user: only a commit id is taken from it, never anything for the shell
    const r = JSON.parse(readFileSync(p, "utf8")) as DeployRequest;
    return { ...r, sha: typeof r.sha === "string" && /^[0-9a-f]{7,40}$/.test(r.sha) ? r.sha : undefined, source: typeof r.source === "string" && /^[\w-]+$/.test(r.source) ? r.source : undefined };
  } catch {
    return null;
  } finally {
    rmSync(p, { force: true });
  }
}

async function previewCheck(rt: SiteRuntime, log: (l: string) => void): Promise<boolean> {
  const hc = rt.health_check!;
  const path = new URL(hc.url).pathname + new URL(hc.url).search;
  for (let i = 1; i <= 3; i++) {
    const p = Bun.spawnSync(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", "--unix-socket", rt.preview_socket!, "-H", `X-Forwarded-Proto: ${hc.https ? "https" : "http"}`, `http://${hc.host}${path}`]);
    const code = Number(p.stdout.toString().trim());
    log(`   attempt ${i}: HTTP ${code || "error"}`);
    if (code >= 200 && code < 400) return true;
    await Bun.sleep(1000 * i);
  }
  return false;
}

async function healthCheck(rt: SiteRuntime, log: (l: string) => void, ok = (code: number) => code >= 200 && code < 400): Promise<boolean> {
  const hc = rt.health_check!;
  const port = hc.https ? 443 : 80;
  for (let i = 1; i <= 5; i++) {
    const p = Bun.spawnSync(["curl", "-sk", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", "--resolve", `${hc.host}:${port}:127.0.0.1`, hc.url]);
    const code = Number(p.stdout.toString().trim());
    log(`   attempt ${i}: HTTP ${code || "error"}`);
    if (ok(code)) return true;
    await Bun.sleep(1000 * i);
  }
  return false;
}

export async function notify(rt: SiteRuntime, r: ReleaseResult, log: (l: string) => void) {
  const ntfy = rt.notify.ntfy;
  if (ntfy && (rt.notify.on === "always" || r.status !== "success")) {
    const what = r.status === "success" ? (r.source === "restart" ? "restarted" : "deployed") : r.source === "restart" ? "restart FAILED" : r.status === "rolled_back" ? (r.source === "rollback" ? "rolled back" : "deploy failed, rolled back") : "deploy FAILED";
    const host = Bun.spawnSync(["hostname"]).stdout.toString().trim();
    const token = ntfy.token_file && existsSync(ntfy.token_file) ? readFileSync(ntfy.token_file, "utf8").trim() : "";
    const send = (email?: string) =>
      fetch(ntfy.url, {
        method: "POST",
        headers: {
          title: `${rt.domain}: ${what}`,
          priority: r.status === "success" ? "default" : "high",
          tags: r.status === "success" ? "white_check_mark" : r.status === "rolled_back" ? "rewind" : "x",
          ...(email ? { email } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "user-agent": "fornax",
        },
        body: [`${what} on ${host} after ${r.seconds}s (${r.source}, ${r.sha?.slice(0, 12) ?? "no commit"})`, r.error ?? "", `log: ${r.log}`, `fornax logs ${rt.domain} deploy`].filter(Boolean).join("\n"),
        signal: AbortSignal.timeout(10_000),
      });
    try {
      let res = await send(ntfy.email);
      if (!res.ok && ntfy.email) {
        // the push matters more than the mail (ntfy.sh only mails for accounts, 5 a day on the free plan)
        log(`=> ntfy refused the mail (HTTP ${res.status}: ${(await res.text()).trim().slice(0, 160)}) — sending the push without it`);
        res = await send();
      }
      log(`=> ntfy: HTTP ${res.status}`);
    } catch (e) {
      log(`=> ntfy failed: ${(e as Error).message}`);
    }
  }
  if (rt.notify.url) {
    try {
      const res = await fetch(rt.notify.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "fornax" },
        body: JSON.stringify({ event: "deploy", ...r }),
        signal: AbortSignal.timeout(10_000),
      });
      log(`=> notified ${new URL(rt.notify.url).host}: HTTP ${res.status}`);
    } catch (e) {
      log(`=> notification failed: ${(e as Error).message}`);
    }
  }
  if (rt.notify.github_status && rt.github_repo && r.sha) {
    const tokenFile = "/etc/fornax/secrets/github-token";
    if (!existsSync(tokenFile)) return log(`=> no ${tokenFile}, skipping GitHub commit status`);
    const api = process.env.FORNAX_GITHUB_API ?? "https://api.github.com";
    const state = r.status === "success" ? "success" : r.status === "rolled_back" ? "error" : "failure";
    try {
      const res = await fetch(`${api}/repos/${rt.github_repo}/statuses/${r.sha}`, {
        method: "POST",
        headers: { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}`, accept: "application/vnd.github+json", "user-agent": "fornax" },
        body: JSON.stringify({ state, context: "fornax/deploy", description: `${r.status} on ${rt.domain} in ${r.seconds}s` }),
        signal: AbortSignal.timeout(10_000),
      });
      log(`=> GitHub commit status ${state}: HTTP ${res.status}`);
    } catch (e) {
      log(`=> GitHub commit status failed: ${(e as Error).message}`);
    }
  }
}

/** HMAC-SHA256 as GitHub sends it in X-Hub-Signature-256. */
export const signature = (secret: string, body: string | Uint8Array) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
