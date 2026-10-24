/**
 * Leave Forge for good, once every site on a server is converted: Forge loses its SSH access
 * (worker key, its allow rules in ufw) and its leftovers go (cleanup cron, PPA).
 * Only the fleet repo changes here; `fornax plan` + `apply` then do the work on the server.
 *
 * Reported, never touched: the `forge` MySQL user and database (apps may log in with it),
 * Forge's sudoers files and the .forge log directories.
 */
import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { join } from "node:path";
import { fail } from "../core/errors.ts";
import { editServerFile, type Fleet } from "../core/fleet.ts";
import { all, FACT_FN, one, parseFacts } from "../core/probe.ts";
import { absent, check, type Resource } from "../core/resource.ts";
import type { Server } from "../core/schema.ts";
import { runnerFor } from "../core/ssh.ts";
import type { ModuleCtx } from "../modules/common.ts";

const WORKER_KEY = "worker@forge.laravel.com";
const CLEANUP = "/root/forge-cleanup.sh";
const KEY_FILES = "/root/.ssh/authorized_keys /home/*/.ssh/authorized_keys";
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const isCleanupJob = (l: string) => l.includes("forge-cleanup.sh") && !l.trim().startsWith("#");

export interface DetachResult {
  server: string;
  changes: string[];
  warnings: string[];
  ufw_removed: string[];
  ufw_unknown: string[];
}

/** Forge's published SSH source addresses. */
export async function forgeIps(): Promise<string[]> {
  const url = process.env.FORNAX_FORGE_IPS_URL ?? "https://forge.laravel.com/ips-v4.txt";
  let text = "";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    fail("forge_ips", `could not load Forge's IP list from ${url}: ${(e as Error).message}`, "name Forge's addresses yourself with --ufw-ip <ip> (repeatable)");
  }
  return text.split(/\s+/).filter((ip) => IPV4.test(ip));
}

const PROBE = `${FACT_FN}
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw status | awk '$1 ~ /^22(\\/tcp)?$/ && $2 == "ALLOW" { ip = ($3 == "IN") ? $4 : $3; if (ip ~ /^[0-9.]+$/ && ip != "127.0.0.1") print ip }' | while read -r ip; do fact ssh_rule "$ip"; done
fi
grep -lsF ${WORKER_KEY} ${KEY_FILES} | while read -r f; do fact worker_key "$f"; done
command -v mysql >/dev/null && fact mysql_forge "$(mysql -N -e "select count(*) from mysql.user where user = 'forge'" 2>/dev/null || echo ?)"
grep -lsE '^DB_USERNAME="?forge"?$' /home/*/*/.env 2>/dev/null | while read -r f; do fact env_forge_user "$f"; done
ls -d /home/*/.forge 2>/dev/null | while read -r d; do fact forge_dir "$d"; done
for f in /etc/sudoers.d/*; do case "$(basename "$f")" in fornax-*|README|90-cloud-init-users) ;; *) fact sudoers "$f";; esac; done
ls /etc/apt/sources.list.d/ 2>/dev/null | grep '^laravelphp-ubuntu-forge' | while read -r f; do fact ppa "$f"; done
[ -f ${CLEANUP} ] && fact cleanup yes
true`;

export async function detachServer(fleet: Fleet, server: Server, o: { force?: boolean; ufwIps?: string[] }): Promise<DetachResult> {
  const adopted = Object.entries(server.sites).filter(([, s]) => s.adopted && s.state === "present").map(([d]) => d);
  if (adopted.length && !o.force) {
    fail(
      "forge_sites_left",
      `${server.server} still has sites Forge deploys and renews: ${adopted.join(", ")}`,
      "convert them first — without Forge's access their deploys and certificates stop; --force detaches anyway",
      `fornax site convert ${adopted[0]} --only cron,logrotate,daemons`,
    );
  }
  for (const ip of o.ufwIps ?? []) if (!IPV4.test(ip)) fail("invalid_option", `--ufw-ip ${ip} is not an IPv4 address`);
  const f = parseFacts((await runnerFor(fleet, server).run(PROBE)).stdout);
  const known = new Set([...(await forgeIps()), ...(o.ufwIps ?? [])]);
  const rules = [...new Set(all(f, "ssh_rule"))];
  const res: DetachResult = { server: server.server, changes: [], warnings: [], ufw_removed: rules.filter((ip) => known.has(ip)), ufw_unknown: rules.filter((ip) => !known.has(ip)) };

  const keys = all(f, "worker_key");
  res.changes.push(keys.length ? `remove Forge's worker key from ${keys.join(", ")}` : "Forge's worker key is already gone");
  if (res.ufw_removed.length) res.changes.push(`remove ufw rules that let Forge reach port 22: ${res.ufw_removed.join(", ")}`);
  if (res.ufw_unknown.length) {
    res.warnings.push(`port 22 is also open to ${res.ufw_unknown.join(", ")} — not on Forge's list, so kept; if they are old Forge addresses, run again with --ufw-ip <ip>`);
  }
  // the cleanup job leaves /etc/crontab: in the adopted copy if there is one, otherwise on the server
  const crontab = server.files.find((x) => x.path === "/etc/crontab" && x.source);
  if (crontab) {
    const p = join(fleet.dir, crontab.source!);
    const lines = readFileSync(p, "utf8").split("\n");
    const kept = lines.filter((l) => !isCleanupJob(l));
    if (kept.length !== lines.length) {
      writeFileSync(p, kept.join("\n"));
      res.changes.push("remove Forge's cleanup job from /etc/crontab");
    }
  }
  if (one(f, "cleanup")) res.changes.push(`remove ${CLEANUP}`);
  const ppa = all(f, "ppa");
  if (ppa.length) res.changes.push(`remove Forge's apt repository (${ppa.join(", ")}) — refused on the server while a package from it is installed`);

  const mysql = one(f, "mysql_forge");
  if (mysql && mysql !== "0") {
    const users = all(f, "env_forge_user");
    res.warnings.push(
      users.length
        ? `MySQL user "forge" is still used by ${users.join(", ")} — kept; give those apps their own user before removing it`
        : `MySQL user "forge" and its database are left alone — drop them by hand once you are sure nothing uses them`,
    );
  }
  const sudoers = all(f, "sudoers");
  if (sudoers.length) res.warnings.push(`Forge's sudoers files stay (they only grant the forge user service reloads): ${sudoers.join(", ")}`);
  const dirs = all(f, "forge_dir");
  if (dirs.length) res.warnings.push(`Forge's logs stay in ${dirs.join(", ")} — nothing cleans them up any more`);

  // a worker key the fleet itself lists for root would come straight back with the next apply
  const isWorker = (k: unknown) => String(k).includes(WORKER_KEY);
  if (server.ssh?.root_keys?.some(isWorker)) res.changes.push(`drop Forge's worker key from ssh.root_keys in servers/${server.server}.yaml`);
  if ([...(fleet.config.ssh.root_keys ?? []), ...fleet.config.ssh.authorized_keys].some(isWorker)) {
    res.warnings.push("fornax.yaml lists Forge's worker key under ssh.root_keys or ssh.authorized_keys — remove it there, or the next apply puts it back");
  }
  editServerFile(fleet, server.server, (doc) => {
    doc.set("forge_detach", doc.createNode({ ufw_ssh_ips: res.ufw_removed }));
    const keys = doc.getIn(["ssh", "root_keys"]);
    if (keys instanceof YAML.YAMLSeq) {
      keys.items = keys.items.filter((k) => !isWorker(YAML.isScalar(k) ? k.value : k));
      if (!keys.items.length) doc.deleteIn(["ssh", "root_keys"]);
      const ssh = doc.get("ssh");
      if (ssh instanceof YAML.YAMLMap && !ssh.items.length) doc.delete("ssh");
    }
  });
  return res;
}

/** The server side of `detach forge`: keys first, so Forge cannot run anything after this apply. */
export function detachResources(ctx: ModuleCtx): Resource[] {
  const d = ctx.server.forge_detach;
  if (!d) return [];
  const o = { owner: "forge" };
  const r: Resource[] = [
    check(
      "forge:worker-key",
      "remove Forge's worker key from authorized_keys (root and every user)",
      `! grep -qsF ${WORKER_KEY} ${KEY_FILES}`,
      `for f in ${KEY_FILES}; do
  [ -f "$f" ] && grep -qF ${WORKER_KEY} "$f" || continue
  sed -i -e '/[[:space:]]worker@forge\\.laravel\\.com[[:space:]]*$/d' -e '/^# Laravel Forge$/d' "$f"
done`,
      o,
    ),
  ];
  if (d.ufw_ssh_ips.length) {
    const re = d.ufw_ssh_ips.map((ip) => ip.replace(/\./g, "\\.")).join("|");
    r.push(
      check(
        "forge:ufw",
        `remove the ufw rules that let Forge reach port 22 (${d.ufw_ssh_ips.join(", ")})`,
        `! ufw status | grep -qE '^22(/tcp)? +ALLOW( IN)? +(${re})( |$)'`,
        `while n=$(ufw status numbered | grep -E '^\\[ *[0-9]+\\] 22(/tcp)? +ALLOW IN +(${re})( |$)' | head -1 | sed -E 's/^\\[ *([0-9]+)\\].*/\\1/'); [ -n "$n" ]; do
  ufw --force delete "$n" >/dev/null
done`,
        o,
      ),
    );
  }
  if (!ctx.server.files.some((x) => x.path === "/etc/crontab")) {
    r.push(check("forge:cleanup-cron", "remove Forge's cleanup job from /etc/crontab", "! grep -v '^#' /etc/crontab | grep -q forge-cleanup.sh", "sed -i '/^[^#].*forge-cleanup\\.sh/d' /etc/crontab", o));
  }
  r.push(
    absent(CLEANUP, { ...o, summary: `remove ${CLEANUP}` }),
    check(
      "forge:ppa",
      "remove Forge's apt repository (ppa:laravelphp/forge)",
      "! ls /etc/apt/sources.list.d/ 2>/dev/null | grep -q '^laravelphp-ubuntu-forge'",
      `for l in /var/lib/apt/lists/*laravelphp_forge*_Packages; do
  [ -f "$l" ] || continue
  for p in $(awk '$1 == "Package:" { print $2 }' "$l" | sort -u); do
    v=$(dpkg-query -W -f='\${Status} \${Version}' "$p" 2>/dev/null || true)
    case "$v" in "install ok installed "*) ;; *) continue;; esac
    if awk -v p="$p" -v v="\${v##* }" '$1 == "Package:" { cur = $2 } $1 == "Version:" && cur == p && $2 == v { found = 1 } END { exit !found }' "$l"; then
      echo "$p \${v##* } is installed from Forge's PPA — replace it before the PPA can go" >&2; false
    fi
  done
done
rm -f /etc/apt/sources.list.d/laravelphp-ubuntu-forge-*`,
      { ...o, handler: "apt" },
    ),
  );
  return r;
}
