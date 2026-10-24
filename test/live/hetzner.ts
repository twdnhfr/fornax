/**
 * Live test against real Hetzner Cloud servers (costs a few cents per run).
 *
 *   FORNAX_LIVE_HCLOUD=op://<vault>/<item>/credential \
 *   FORNAX_LIVE_OP_VAULT=<vault> [FORNAX_LIVE_OP_ACCOUNT=<account>] \
 *   bun test/live/hetzner.ts [arm24 x86-24 arm26]
 *
 * Use a Hetzner project that holds nothing else. Every server is destroyed at the end, also
 * when a step fails. Certificates come from Let's Encrypt *staging* via sslip.io names, so no
 * DNS zone is touched. Needs .dev/id_ed25519 (its public key becomes the servers' root key).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const KEY = join(ROOT, ".dev", "id_ed25519");
const FLEET = join(ROOT, ".dev", "fleet-live");
const LARAVEL = process.env.FORNAX_LIVE_LARAVEL ?? join(ROOT, ".dev", "demos", "laravel");
const HCLOUD = process.env.FORNAX_LIVE_HCLOUD;
const VAULT = process.env.FORNAX_LIVE_OP_VAULT;
const ACCOUNT = process.env.FORNAX_LIVE_OP_ACCOUNT;
if (!HCLOUD || !VAULT) throw new Error("set FORNAX_LIVE_HCLOUD (secret reference) and FORNAX_LIVE_OP_VAULT");

const MATRIX: Record<string, { size: string; location: string; ubuntu: string; php: string }> = {
  arm24: { size: "cax11", location: "nbg1", ubuntu: "24.04", php: "8.4" },
  "x86-24": { size: "cx23", location: "nbg1", ubuntu: "24.04", php: "8.4" },
  arm26: { size: "cax11", location: "nbg1", ubuntu: "26.04", php: "8.5" },
};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MATRIX);
const RUN = Date.now().toString(36);

mkdirSync(join(FLEET, "servers"), { recursive: true });
writeFileSync(
  join(FLEET, "fornax.yaml"),
  `fleet: live
ssh:
  user: root
  config_file: none
  identity_file: ${KEY}
  known_hosts_file: known_hosts
tls:
  issuer: letsencrypt
  acme_server: https://acme-staging-v02.api.letsencrypt.org/directory
onepassword:
  vault: ${VAULT}
${ACCOUNT ? `  account: ${ACCOUNT}\n` : ""}provider_credentials:
  hetzner-cloud: ${HCLOUD}
`,
);
writeFileSync(join(FLEET, ".gitignore"), ".fornax/\nknown_hosts\n");

async function fornax(...args: string[]): Promise<{ code: number; json: any; err: string }> {
  const p = Bun.spawn(["bun", join(ROOT, "src", "cli.ts"), ...args, "--json"], { cwd: FLEET, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    json = { raw: out.slice(-2000) };
  }
  return { code, json, err };
}

const ssh = (ip: string) => ["ssh", "-F", "/dev/null", "-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `root@${ip}`];
async function onServer(ip: string, script: string): Promise<string> {
  const p = Bun.spawn([...ssh(ip), "bash -s"], { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(err || out);
  return out;
}

async function publish(ip: string, name: string, dir: string, version: string, mutate?: (w: string) => void) {
  const work = mkdtempSync(join(tmpdir(), `fornax-live-${name}-`));
  cpSync(dir, work, { recursive: true, filter: (p) => !p.includes("/vendor/") && !p.includes("/node_modules/") });
  if (existsSync(join(work, ".git"))) Bun.spawnSync(["rm", "-rf", join(work, ".git")]);
  writeFileSync(join(work, "VERSION"), version + "\n");
  mutate?.(work);
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", work, ...a], { env: { ...process.env, GIT_SSH_COMMAND: ssh(ip).slice(0, -1).join(" ") } });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=live@fornax", "-c", "user.name=live", "commit", "-qm", version);
  await onServer(ip, `mkdir -p /srv/git; [ -d /srv/git/${name}.git ] || git init -q --bare -b main /srv/git/${name}.git; git config --system --get-all safe.directory | grep -qx /srv/git/${name}.git || git config --system --add safe.directory /srv/git/${name}.git`);
  const push = git("push", "-q", "--force", `root@${ip}:/srv/git/${name}.git`, "main");
  if (push.exitCode !== 0) throw new Error(push.stderr.toString());
  await onServer(ip, "chmod -R a+rX /srv/git");
}

const curl = (host: string, ip: string, path = "/") => Bun.spawnSync(["curl", "-sk", "--max-time", "15", "--resolve", `${host}:443:${ip}`, `https://${host}${path}`]).stdout.toString();

interface Step {
  step: string;
  ok: boolean;
  seconds: number;
  detail?: string;
}

async function runServer(key: string): Promise<Step[]> {
  const m = MATRIX[key]!;
  const name = `live-${key}-${RUN}`;
  const steps: Step[] = [];
  const log = (s: Step) => {
    steps.push(s);
    console.log(`[${key}] ${s.ok ? "✓" : "✗"} ${s.step} (${s.seconds}s)${s.detail ? ` — ${s.detail}` : ""}`);
  };
  let broken = false;
  // later steps need these; the remaining ones are independent checks
  const CRITICAL = new Set(["server create", "bootstrap", "provision", "publish demo repos", "site add + apply (Let's Encrypt staging)", "deploy"]);
  const step = async (title: string, fn: () => Promise<string | void>, critical = CRITICAL.has(title)) => {
    if (broken && title !== "server destroy") {
      log({ step: title, ok: false, seconds: 0, detail: "skipped after an earlier failure" });
      return false;
    }
    const t = Date.now();
    try {
      const detail = await fn();
      log({ step: title, ok: true, seconds: Math.round((Date.now() - t) / 1000), detail: detail || undefined });
      return true;
    } catch (e) {
      log({ step: title, ok: false, seconds: Math.round((Date.now() - t) / 1000), detail: (e as Error).message.slice(0, 600) });
      if (critical) broken = true;
      return false;
    }
  };
  const must = (r: { code: number; json: any }, what: string) => {
    if (r.code !== 0) throw new Error(`${what}: ${JSON.stringify(r.json).slice(0, 500)}`);
    return r.json;
  };
  let ip = "";
  let created = false;
  try {
    if (!(await step("server create", async () => {
      const r = must(await fornax("server", "create", name, "--provider", "hetzner-cloud", "--size", m.size, "--location", m.location, "--ubuntu", m.ubuntu), "create");
      ip = r.ipv4;
      created = true;
      const f = join(FLEET, "servers", `${name}.yaml`);
      writeFileSync(f, readFileSync(f, "utf8") + "services: [postgres, redis, supervisor, fail2ban]\ntools: [composer, bun]\n");
      return `${ip} (${m.size}, Ubuntu ${m.ubuntu})`;
    })))
      return steps;
    const dash = ip.replace(/\./g, "-");
    const app = `app.${dash}.sslip.io`;
    const shop = `shop.${dash}.sslip.io`;
    await step("bootstrap", async () => `${must(await fornax("server", "bootstrap", name), "bootstrap").applied} changes`);
    await step("provision", async () => {
      const r = must(await fornax("server", "provision", name), "provision");
      if (!r.in_sync) throw new Error(`not in sync: ${JSON.stringify(r.remaining)}`);
      return `${r.applied} changes in ${r.rounds} round(s)`;
    });
    await step("publish demo repos", async () => {
      await publish(ip, "demo-php", join(ROOT, "examples", "demo-php"), "v1");
      if (existsSync(LARAVEL)) await publish(ip, "laravel", LARAVEL, "v1");
    });
    await step("site add + apply (Let's Encrypt staging)", async () => {
      must(await fornax("site", "add", name, app, "--repo", "file:///srv/git/demo-php.git", "--preset", "php"), "site add app");
      if (existsSync(LARAVEL)) must(await fornax("site", "add", name, shop, "--repo", "file:///srv/git/laravel.git", "--db", "postgres", "--schedule", "--daemon", `php${m.php} artisan queue:work redis --sleep=1`), "site add shop");
      const f = join(FLEET, "servers", `${name}.yaml`);
      writeFileSync(f, readFileSync(f, "utf8").replace(`  ${app}:\n`, `  ${app}:\n    health_check: /health\n`).replace(`  ${shop}:\n`, `  ${shop}:\n    health_check: /health\n`));
      const r = must(await fornax("server", "provision", name), "provision sites");
      if (!r.in_sync) throw new Error("not in sync after sites");
      return `${r.applied} changes; 1Password: ${r.secrets_synced ? r.secrets_synced.written.join(",") || "unchanged" : "-"}`;
    });
    await step("certificates from LE staging", async () => {
      const certs = must(await fornax("ssl", "status", name), "ssl").certificates;
      const c = certs.find((x: any) => x.names.includes(app));
      if (!c || !/STAGING/i.test(c.issuer)) throw new Error(`issuer: ${c?.issuer}`);
      return `${certs.length} certs, issuer ${c.issuer}`;
    });
    await step("deploy", async () => {
      must(await fornax("deploy", app), "deploy app");
      const v = JSON.parse(curl(app, ip)).version;
      if (v !== "v1") throw new Error(`app answered ${v}`);
      if (!existsSync(LARAVEL)) return "app v1";
      must(await fornax("deploy", shop), "deploy shop");
      const j = JSON.parse(curl(shop, ip));
      return `app v1, shop ${j.version} on PHP ${j.php} with ${j.db}`;
    });
    if (existsSync(LARAVEL)) {
      await step("queue + scheduler", async () => {
        curl(shop, ip, "/dispatch/live-queue");
        for (let i = 0; i < 90; i++) {
          const mk = JSON.parse(curl(shop, ip, "/markers") || "{}");
          if (mk.job === "live-queue" && mk.schedule) return `job ok, scheduler ran ${mk.schedule}`;
          await Bun.sleep(2000);
        }
        throw new Error(`markers: ${curl(shop, ip, "/markers")}`);
      });
    }
    await step("broken release never goes live", async () => {
      await publish(ip, "demo-php", join(ROOT, "examples", "demo-php"), "v2-broken", (w) => {
        const f = join(w, "public", "index.php");
        writeFileSync(f, readFileSync(f, "utf8").replace("echo json_encode(['ok' => true]);", "http_response_code(500); echo 'broken';"));
      });
      const seen = new Set<string>();
      const t = setInterval(() => {
        try {
          seen.add(JSON.parse(curl(app, ip)).version);
        } catch {
          seen.add("error");
        }
      }, 200);
      const r = await fornax("deploy", app);
      clearInterval(t);
      if (r.code === 0) throw new Error("broken deploy succeeded");
      if ([...seen].join() !== "v1") throw new Error(`served: ${[...seen].join(",")}`);
      return `refused (${r.json.error}); served only v1`;
    });
    await step("redeploy + rollback", async () => {
      await publish(ip, "demo-php", join(ROOT, "examples", "demo-php"), "v3");
      must(await fornax("deploy", app), "deploy v3");
      if (JSON.parse(curl(app, ip)).version !== "v3") throw new Error("v3 not live");
      must(await fornax("rollback", app), "rollback");
      const v = JSON.parse(curl(app, ip)).version;
      if (v !== "v1") throw new Error(`after rollback: ${v}`);
      return "v3 → rollback → v1";
    });
    await step("plan in sync, status, secrets", async () => {
      const p = must(await fornax("plan", name), "plan");
      if (!p.in_sync) throw new Error(`drift: ${JSON.stringify(p.changes).slice(0, 300)}`);
      const st = must(await fornax("server", "status", name), "status");
      const extra = st.warnings.filter((w: string) => !w.startsWith(`last deploy of ${app}`));
      if (extra.length) throw new Error(`warnings: ${extra.join("; ")}`);
      const sec = must(await fornax("secrets", "list", name), "secrets");
      if (!sec.secrets.every((s: any) => s.in_1password === "same")) throw new Error(JSON.stringify(sec.secrets));
      return `ports ${st.public_ports.join(",")}, ${sec.secrets.length} secrets in 1Password`;
    });
  } finally {
    // also when create itself failed after the server existed
    if (created || existsSync(join(FLEET, "servers", `${name}.yaml`))) {
      await step("server destroy", async () => {
        must(await fornax("server", "destroy", name, `--confirm=${name}`), "destroy");
      });
    }
  }
  return steps;
}

const results = await Promise.all(wanted.map(async (k) => [k, await runServer(k)] as const));
const failed = results.flatMap(([k, s]) => s.filter((x) => !x.ok).map((x) => `${k}: ${x.step}`));
writeFileSync(join(FLEET, `result-${RUN}.json`), JSON.stringify(Object.fromEntries(results), null, 2));
console.log(failed.length ? `\nFAILED: ${failed.join(" | ")}` : "\nall steps passed");
process.exit(failed.length ? 1 : 0);
