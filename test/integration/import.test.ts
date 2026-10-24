/**
 * Forge import on OrbStack: clone `fornax-base`, provision a stack, dress it up as a Forge
 * server from test/fixtures/forge, import it, and require the first plan to be empty.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { machineIp } from "./fakes.ts";

const ROOT = join(import.meta.dir, "..", "..");
const KEY = join(ROOT, ".dev", "id_ed25519");
const MACHINE = `fornax-import-${Date.now().toString(36)}`;
const FIX = join(ROOT, "test", "fixtures", "forge");
let ip = "";

const fleetYaml = `fleet: import-test
ssh:
  user: root
  config_file: none
  identity_file: ${KEY}
  known_hosts_file: known_hosts
tls:
  issuer: selfsigned
`;
const provisionFleet = mkdtempSync(join(tmpdir(), "fornax-prov-"));
const importFleet = mkdtempSync(join(tmpdir(), "fornax-imp-"));

async function fornax(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["bun", join(ROOT, "src", "cli.ts"), ...args, "--json"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    json = { raw: out, err };
  }
  return { code, json, err };
}

function onServer(script: string, stdin?: Uint8Array) {
  const ssh = ["ssh", "-F", "/dev/null", "-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `root@${ip}`, script];
  const p = Bun.spawnSync(ssh, { stdin: stdin ? new Blob([stdin]) : undefined, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString() + p.stdout.toString());
  return p.stdout.toString();
}

beforeAll(async () => {
  Bun.spawnSync(["orb", "clone", "fornax-base", MACHINE]);
  Bun.spawnSync(["orb", "start", MACHINE]);
  for (let i = 0; i < 30 && !ip; i++) {
    ip = machineIp(MACHINE);
    if (!ip) await Bun.sleep(1000);
  }
  for (const d of [provisionFleet, importFleet]) {
    writeFileSync(join(d, "fornax.yaml"), fleetYaml);
    Bun.spawnSync(["mkdir", "-p", join(d, "servers")]);
  }
  writeFileSync(join(provisionFleet, "servers", "box.yaml"), `server: box\nhost: ${ip}\nphp: ["8.4"]\nservices: [supervisor]\ntools: []\n`);
}, 120_000);

afterAll(() => {
  if (process.env.FORNAX_KEEP_VMS) return console.error(`kept ${MACHINE} (${ip}), fleets ${provisionFleet} ${importFleet}`);
  Bun.spawnSync(["orb", "delete", "-f", MACHINE]);
});

describe("adopting a Forge server", () => {
  test("a stack like Forge's is provisioned and dressed up with Forge's files", async () => {
    const r = await fornax(provisionFleet, "server", "provision", "box");
    expect(r.code).toBe(0);
    // COPYFILE_DISABLE: no macOS ._* metadata files in the archive
    const tar = Bun.spawnSync(["tar", "--no-xattrs", "-cz", "-C", join(FIX, "files"), "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).stdout;
    expect(onServer(`bash -c "$(printf %s '${Buffer.from(readFileSync(join(import.meta.dir, "seed-forge.sh"))).toString("base64")}' | base64 -d)"`, tar)).toContain("seeded");
  }, 900_000);

  test("import reads the files over SSH and writes an adopted config", async () => {
    const r = await fornax(importFleet, "import", "forge", "box", "--server-id", "100", "--dump", join(FIX, "api"), "--host", ip);
    expect(r.code).toBe(0);
    expect(r.json.sites.map((s: any) => s.site)).toEqual(["shop.example.com", "docs.example.com"]);
    expect(r.json.warnings.join("\n")).toContain(".htpasswd-1 holds password hashes");
    const yaml = readFileSync(join(importFleet, "servers", "box.yaml"), "utf8");
    expect(yaml).not.toContain("$apr1$");
  }, 120_000);

  test("the first plan is empty: nothing is regenerated or rewritten", async () => {
    const r = await fornax(importFleet, "plan", "box");
    if (r.code !== 0 || !r.json.in_sync) console.error(JSON.stringify(r.json, null, 2).slice(0, 3000));
    expect(r.code).toBe(0);
    expect(r.json.changes).toEqual([]);
    expect(r.json.in_sync).toBe(true);
  }, 120_000);

  test("a hand edit on the server shows up as drift against the adopted copy", async () => {
    onServer("echo '# hand edit' >> /etc/nginx/forge-conf/200/site.conf");
    const r = await fornax(importFleet, "diff", "box");
    expect(r.json.changes.map((c: any) => c.id)).toEqual(["file:/etc/nginx/forge-conf/200/site.conf"]);
    expect(r.json.diffs["/etc/nginx/forge-conf/200/site.conf"]).toContain("-# hand edit");
  }, 120_000);

  test("convert step 1: cron, logrotate, daemons", async () => {
    const c = await fornax(importFleet, "site", "convert", "shop.example.com", "--only", "cron,logrotate,daemons");
    expect(c.code).toBe(0);
    const plan = await fornax(importFleet, "plan", "box");
    const ids = plan.json.changes.map((x: any) => x.id);
    expect(ids).toContain("file:/etc/cron.d/fornax-shop-example-com");
    expect(ids).toContain("absent:/etc/supervisor/conf.d/daemon-300.conf");
    expect((await fornax(importFleet, "apply", plan.json.plan)).code).toBe(0);
    expect(onServer("grep -c shop-ab12cd34 /etc/crontab || true").trim()).toBe("0");
    expect(onServer("cat /etc/cron.d/fornax-shop-example-com")).toContain("artisan schedule:run");
    expect(onServer("supervisorctl status")).toContain("fornax-shop-example-com-horizon");
    expect(onServer("supervisorctl status")).not.toContain("daemon-300");
    expect((await fornax(importFleet, "plan", "box")).json.in_sync).toBe(true);
  }, 300_000);

  test("convert step 2: web (vhost + pool + snippets) keeps the site answering", async () => {
    const before = await fornax(importFleet, "site", "check", "shop.example.com");
    expect(before.json.results.find((r: any) => r.url === "https://shop.example.com/").status).toBe(200);
    const kill = () => onServer("curl -sk -o /dev/null -w %{http_code} -H 'X-Kill: yes' --resolve shop.example.com:443:127.0.0.1 https://shop.example.com/");
    expect(kill()).toBe("418");
    const conv = await fornax(importFleet, "site", "convert", "shop.example.com", "--only", "web");
    expect(conv.code).toBe(0);
    // the hand edits in Forge's vhost came along as snippets
    expect(conv.json.snippets).toEqual(expect.arrayContaining(["snippets/shop.example.com/vhost-http.conf", "snippets/shop.example.com/vhost-server.conf"]));
    const plan = await fornax(importFleet, "plan", "box");
    const apply = await fornax(importFleet, "apply", plan.json.plan);
    if (apply.code !== 0) console.error(JSON.stringify(apply.json, null, 2));
    expect(apply.code).toBe(0);
    const after = await fornax(importFleet, "site", "check", "shop.example.com");
    expect(after.json.results.find((r: any) => r.url === "https://shop.example.com/").status).toBe(200);
    expect(after.json.results.find((r: any) => r.url === "https://shop.example.net/").status).toBe(200);
    expect(after.json.results.find((r: any) => r.url === "http://shop.example.com/").redirect).toBe("https://shop.example.com/");
    // Forge's custom header came over as a snippet
    expect(onServer("curl -skI --resolve shop.example.com:443:127.0.0.1 https://shop.example.com/").toLowerCase()).toContain("x-robots-tag: noindex");
    expect(onServer("ls /etc/php/8.4/fpm/pool.d/")).not.toContain("www-shop-ab12cd34.conf");
    expect(kill()).toBe("418");
    expect(onServer("grep max_children /etc/php/8.4/fpm/pool.d/fornax-shop-example-com.conf")).toContain("20");
    expect((await fornax(importFleet, "plan", "box")).json.in_sync).toBe(true);
  }, 300_000);

  test("refresh takes over what Forge changed on unconverted sites and keeps conversions", async () => {
    // Forge keeps running docs.example.com: a new nginx file from its UI, a new scheduler job
    onServer(`printf 'add_header X-Forge-Edit "1";\\n' > /etc/nginx/forge-conf/docs.example.com/server/edit.conf && nginx -t -q && systemctl reload nginx
echo '5 5 * * * docs echo forge-job > /dev/null 2>&1' >> /etc/crontab`);
    const drift = await fornax(importFleet, "plan", "box");
    expect(drift.json.changes.map((c: any) => c.id)).toContain("file:/etc/crontab");
    const y = join(importFleet, "servers", "box.yaml");
    const shop = (t: string) => t.split("  shop.example.com:")[1]!.split("\n  docs.example.com:")[0];
    const shopBefore = shop(readFileSync(y, "utf8"));
    const r = await fornax(importFleet, "import", "forge", "box", "--server-id", "100", "--dump", join(FIX, "api"), "--refresh");
    expect(r.code).toBe(0);
    expect(r.json.refreshed).toEqual(["docs.example.com"]);
    expect(r.json.skipped.map((x: any) => x.site)).toEqual(["shop.example.com"]);
    expect(shop(readFileSync(y, "utf8"))).toBe(shopBefore);
    expect(readFileSync(y, "utf8")).toContain("/etc/nginx/forge-conf/docs.example.com/server/edit.conf");
    const crontab = readFileSync(join(importFleet, "adopted", "box", "etc", "crontab"), "utf8");
    expect(crontab).toContain("forge-job");
    expect(crontab).not.toContain("shop-ab12cd34");
    const plan = await fornax(importFleet, "plan", "box");
    if (!plan.json.in_sync) console.error(JSON.stringify(plan.json.changes, null, 2));
    expect(plan.json.in_sync).toBe(true);
  }, 300_000);

  test("convert step 3: tls refuses to jump ahead, then switches the certificate", async () => {
    expect((await fornax(importFleet, "site", "convert", "docs.example.com", "--only", "tls")).json.code).toBe("convert_order");
    expect((await fornax(importFleet, "site", "convert", "shop.example.com", "--only", "tls")).code).toBe(0);
    const plan = await fornax(importFleet, "plan", "box");
    expect((await fornax(importFleet, "apply", plan.json.plan)).code).toBe(0);
    const ssl = (await fornax(importFleet, "ssl", "status", "box")).json.certificates;
    expect(ssl.find((c: any) => c.path === "/etc/fornax/tls/shop.example.com/fullchain.pem").used_by).toContain("shop.example.com");
    expect((await fornax(importFleet, "site", "check", "shop.example.com")).json.results[1].status).toBe(200);
  }, 300_000);

  test("convert step 4 + finalize: deploys by fornax, nothing of Forge left for the site", async () => {
    // the fixture repo lives on GitHub; point the test at a local copy of the demo
    const tar = Bun.spawnSync(["tar", "--no-xattrs", "-cz", "-C", join(ROOT, "examples", "demo-php"), "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).stdout;
    onServer("rm -rf /tmp/demo && mkdir /tmp/demo && tar -xz --no-same-owner -C /tmp/demo && cd /tmp/demo && git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm v1 && git clone -q --bare /tmp/demo /srv/demo.git && git config --system --add safe.directory /srv/demo.git && chmod -R a+rX /srv/demo.git", tar);
    const y = join(importFleet, "servers", "box.yaml");
    writeFileSync(y, readFileSync(y, "utf8").replace("repo: acme/shop", "repo: file:///srv/demo.git").replace("    preset: laravel\n", "    preset: php\n"));
    const conv = await fornax(importFleet, "site", "convert", "shop.example.com", "--only", "deploy,finalize");
    expect(conv.code).toBe(0);
    // Forge's own build steps came along (in Forge's order) …
    expect(conv.json.changes.join("\n")).toContain("$FORNAX_PHP artisan optimize");
    // … but this test deploys a plain PHP demo instead of the Laravel app: drop them again
    const doc = YAML.parseDocument(readFileSync(y, "utf8"));
    doc.deleteIn(["sites", "shop.example.com", "deploy", "commands"]);
    writeFileSync(y, doc.toString());
    const plan = await fornax(importFleet, "plan", "box");
    expect((await fornax(importFleet, "apply", plan.json.plan)).code).toBe(0);
    const d = await fornax(importFleet, "deploy", "shop.example.com");
    expect(d.json.status).toBe("success");
    expect(JSON.parse(onServer("curl -sk --resolve shop.example.com:443:127.0.0.1 https://shop.example.com/")).app).toBe("fornax-demo-php");
    const site = readFileSync(y, "utf8").split("  docs.example.com:")[0]!;
    expect(site).not.toContain("adopted: true");
    expect((await fornax(importFleet, "plan", "box")).json.in_sync).toBe(true);
  }, 600_000);

  test("an in-place site (Forge without zero-downtime) converts and keeps deploying in place", async () => {
    expect((await fornax(importFleet, "detach", "forge", "box")).json.code).toBe("forge_sites_left");
    // like Forge: the site directory is the checkout, dist/ is built there
    const build = `<?php @mkdir(__DIR__."/dist"); file_put_contents(__DIR__."/dist/index.html", "docs ".trim(file_get_contents(__DIR__."/VERSION")));`;
    onServer(`set -e; rm -rf /tmp/docs /srv/docs.git; mkdir /tmp/docs && cd /tmp/docs && printf %s '${build}' > build.php && echo v1 > VERSION && echo /dist/ > .gitignore
git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm v1 && git clone -q --bare /tmp/docs /srv/docs.git && git config --system --add safe.directory /srv/docs.git && chmod -R a+rX /srv/docs.git
printf 'reviewer:%s\\n' "$(openssl passwd -apr1 secret)" > /etc/nginx/forge-conf/docs.example.com/server/.htpasswd-1
rm -rf /home/docs/docs.example.com && runuser -u docs -- git clone -q /srv/docs.git /home/docs/docs.example.com && cd /home/docs/docs.example.com && runuser -u docs -- php8.4 build.php`);
    const y = join(importFleet, "servers", "box.yaml");
    writeFileSync(y, readFileSync(y, "utf8").replace("repo: acme/docs", "repo: file:///srv/docs.git"));
    // the site sits behind Forge's basic auth, which has to survive the conversion
    const docs = () => onServer("curl -sk -u reviewer:secret --resolve docs.example.com:443:127.0.0.1 https://docs.example.com/");
    expect(onServer("curl -sk -o /dev/null -w %{http_code} --resolve docs.example.com:443:127.0.0.1 https://docs.example.com/")).toBe("401");
    expect(docs()).toBe("docs v1");
    const step = async (areas: string) => {
      const c = await fornax(importFleet, "site", "convert", "docs.example.com", "--only", areas);
      expect(c.code).toBe(0);
      const plan = await fornax(importFleet, "plan", "box");
      const apply = await fornax(importFleet, "apply", plan.json.plan);
      if (apply.code !== 0) console.error(JSON.stringify(apply.json, null, 2));
      expect(apply.code).toBe(0);
      expect(docs()).toBe("docs v1");
      return c.json;
    };
    await step("cron,logrotate,daemons,web");
    expect(onServer("grep -h ' root ' /etc/nginx/sites-available/docs.example.com")).toContain("/home/docs/docs.example.com/dist;");
    await step("tls");
    const conv = await step("deploy,finalize");
    expect(conv.changes.join("\n")).toContain("$FORNAX_PHP build.php");

    onServer(`cd /tmp/docs && echo v2 > VERSION && git -c user.email=t@t -c user.name=t commit -qam v2 && git push -q /srv/docs.git main`);
    const d = await fornax(importFleet, "deploy", "docs.example.com");
    expect(d.json.status).toBe("success");
    expect(docs()).toBe("docs v2");
    expect(onServer("ls /home/docs/docs.example.com")).not.toContain("releases");
    const r = await fornax(importFleet, "releases", "docs.example.com");
    expect(r.json.mode).toBe("in_place");
    expect(d.json.sha.startsWith(r.json.commit)).toBe(true);

    // a hand edit on the server stops the deploy instead of being thrown away
    onServer("echo edited >> /home/docs/docs.example.com/VERSION");
    const dirty = await fornax(importFleet, "deploy", "docs.example.com");
    expect(dirty.json.status).toBe("failed");
    expect(dirty.json.error).toContain("tracked files were changed");
    onServer("runuser -u docs -- git -C /home/docs/docs.example.com checkout -- VERSION");

    const back = await fornax(importFleet, "rollback", "docs.example.com");
    expect(back.code).toBe(0);
    expect(docs()).toBe("docs v1");

    // a broken build puts the previous commit back, built
    onServer(`cd /tmp/docs && printf %s '<?php exit(1);' > build.php && git -c user.email=t@t -c user.name=t commit -qam broken && git push -q /srv/docs.git main`);
    const broken = await fornax(importFleet, "deploy", "docs.example.com");
    expect(broken.json.status).toBe("failed");
    expect(docs()).toBe("docs v1");
    expect(onServer("runuser -u docs -- git -C /home/docs/docs.example.com log -1 --format=%s").trim()).toBe("v1");
  }, 900_000);

  test("detach forge: cuts Forge's access once every site is converted", async () => {
    const ips = join(importFleet, "forge-ips.txt");
    writeFileSync(ips, "159.203.150.232\n45.55.124.124\n");
    process.env.FORNAX_FORGE_IPS_URL = `file://${ips}`;
    expect(onServer("ufw status")).toContain("159.203.150.232");
    const d = await fornax(importFleet, "detach", "forge", "box");
    expect(d.code).toBe(0);
    expect(d.json.ufw_removed).toEqual(["159.203.150.232"]);
    expect(d.json.ufw_unknown).toEqual(["192.0.2.10"]);
    const plan = await fornax(importFleet, "plan", "box");
    const ids = plan.json.changes.map((x: any) => x.id);
    for (const id of ["check:forge:worker-key", "check:forge:ufw", "absent:/root/forge-cleanup.sh", "check:forge:ppa", "file:/etc/crontab"]) expect(ids).toContain(id);
    expect((await fornax(importFleet, "apply", plan.json.plan)).code).toBe(0);
    expect(onServer("cat /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys")).not.toContain("forge.laravel.com");
    // fornax's own key stays — this very login proves it
    expect(onServer("grep -c ssh- /root/.ssh/authorized_keys").trim()).not.toBe("0");
    const ufw = onServer("ufw status");
    expect(ufw).not.toContain("159.203.150.232");
    expect(ufw).toContain("192.0.2.10");
    expect(onServer("grep -c forge-cleanup /etc/crontab || true").trim()).toBe("0");
    expect(onServer("ls /etc/apt/sources.list.d/ /root")).not.toMatch(/laravelphp|forge-cleanup/);
    expect((await fornax(importFleet, "plan", "box")).json.in_sync).toBe(true);
  }, 300_000);

  test("explain shows the adopted site live", async () => {
    const r = await fornax(importFleet, "explain", "shop.example.com");
    expect(r.json.live.user_exists).toBe(true);
    expect(r.json.live.current_release).toMatch(/\/home\/shop-ab12cd34\/shop\.example\.com\/releases\/\d{14}$/);
    expect(r.json.live.fpm_pool).toBe("/etc/php/8.4/fpm/pool.d/fornax-shop-example-com.conf");
  }, 120_000);
});
