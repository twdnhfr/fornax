import { fail } from "../core/errors.ts";
import { isSecretRef, secretOrPlain, sites, type Fleet } from "../core/fleet.ts";
import { fleetAgent } from "../core/ssh-agent.ts";
import { backupEnabled, backupResources } from "./backup.ts";
import { historyResources } from "./history.ts";
import { rootAccessResources } from "./root-access.ts";
import { parseFacts, one, FACT_FN } from "../core/probe.ts";
import { pendingHandlers, type Resource } from "../core/resource.ts";
import { MODULES, type Server } from "../core/schema.ts";
import { runnerFor } from "../core/ssh.ts";
import { remoteBinary } from "../core/binary.ts";
import { DISTROS, SUPPORTED_UBUNTU, type ModuleCtx } from "./common.ts";
import { SERVER_MODULES, serverFiles } from "./server.ts";
import { siteResources, deployResources } from "./site.ts";
import { detachResources } from "../forge/detach.ts";
import { LEGACY_GONE, legacyEarly, legacyLate } from "./legacy.ts";

export interface Scope {
  modules: string[];
  sites: string[];
}

export async function preflight(fleet: Fleet, server: Server): Promise<ModuleCtx["facts"]> {
  const out = await runnerFor(fleet, server).run(`${FACT_FN}
. /etc/os-release; fact id "$ID"; fact codename "$VERSION_CODENAME"; fact version "$VERSION_ID"; fact arch "$(uname -m)"
case "$VERSION_CODENAME" in noble) fact php_ppa yes;; *) curl -fsI --max-time 10 "https://ppa.launchpadcontent.net/ondrej/php/ubuntu/dists/$VERSION_CODENAME/Release" >/dev/null 2>&1 && fact php_ppa yes || fact php_ppa no;; esac
${LEGACY_GONE} || fact legacy yes
id -u anvil >/dev/null 2>&1 && ! id -u fornax >/dev/null 2>&1 && fact legacy_admin yes
true`);
  const f = parseFacts(out.stdout);
  const version = one(f, "version") ?? "?";
  if (one(f, "id") !== "ubuntu" || !SUPPORTED_UBUNTU.includes(version)) {
    fail("unsupported_os", `${server.server} runs ${one(f, "id")} ${version}; fornax supports Ubuntu ${SUPPORTED_UBUNTU.join(" and ")}`, "reinstall the server with a supported Ubuntu LTS");
  }
  const arch = one(f, "arch") === "aarch64" ? "arm64" : "x86_64";
  if (server.arch && server.arch !== arch) fail("config_invalid", `${server.server}: config says arch ${server.arch}, the server is ${arch}`);
  const phpPpa = one(f, "php_ppa") === "yes";
  const systemPhp = DISTROS[version]!.systemPhp;
  if (!phpPpa && server.modules.includes("php") && server.php.some((v) => v !== systemPhp)) {
    fail(
      "config_invalid",
      `${server.server} runs Ubuntu ${version}, where only PHP ${systemPhp} is available (the ondrej/php PPA does not support ${one(f, "codename")} yet)`,
      `set php: ["${systemPhp}"] for this server, or use Ubuntu 24.04 for other versions`,
    );
  }
  // Only servers that deploy or back up need the Linux build of fornax.
  const deploys = Object.values(server.sites).some((s) => s.state === "present" && s.deploy.enabled && s.repo);
  const backups = backupEnabled({ fleet, server, sites: sites(fleet, server) });
  const binary = deploys || backups ? await remoteBinary(arch) : undefined;
  const hb = backups ? fleet.config.backup?.heartbeat : undefined;
  const isRef = isSecretRef;
  const heartbeat = hb ? { value: await secretOrPlain(fleet, hb), ref: isRef(hb) ? hb : undefined } : undefined;
  const nt = deploys || backups ? fleet.config.notify.ntfy?.token : undefined;
  const ntfyToken = nt ? { value: await secretOrPlain(fleet, nt), ref: isRef(nt) ? nt : undefined } : undefined;
  const composerAuth: Record<string, { value: string; ref?: string }> = {};
  for (const [domain, s] of Object.entries(server.sites)) {
    if (s.state === "present" && s.composer_auth) composerAuth[domain] = { value: await secretOrPlain(fleet, s.composer_auth), ref: isRef(s.composer_auth) ? s.composer_auth : undefined };
  }
  // the fleet key's public half (from fornax's agent), so a Tailscale server can be rid of it
  let fleetKey: string | undefined;
  const agent = fleet.config.access === "tailscale" && server.modules.includes("access") ? fleetAgent(fleet) : undefined;
  if (agent) {
    const listed = Bun.spawnSync(["ssh-add", "-L"], { env: { ...process.env, SSH_AUTH_SOCK: await agent }, stdout: "pipe" }).stdout.toString();
    fleetKey = listed.split("\n").find((l) => l.startsWith("ssh-"))?.split(/\s+/).slice(0, 2).join(" ");
  }
  return { arch, codename: one(f, "codename")!, version, phpPpa, binary, heartbeat, ntfyToken, composerAuth, fleetKey, legacy: one(f, "legacy") === "yes", legacyAdmin: one(f, "legacy_admin") === "yes" };
}

/**
 * Desired state of a server: the resources of all managed modules, its sites and files.
 * Order matters — it is the apply order (repos before packages, certs before vhosts …).
 */
export function desired(fleet: Fleet, server: Server, facts: ModuleCtx["facts"], scope?: Partial<Scope>): Resource[] {
  // servers fornax set up under its old name keep their admin user "anvil"
  const admin = server.admin_user ?? fleet.config.admin_user ?? (facts.legacyAdmin ? "anvil" : "fornax");
  const ctx: ModuleCtx = { fleet, server, sites: sites(fleet, server), facts, admin };
  const wantModules = scope?.modules?.length ? scope.modules : MODULES;
  for (const m of scope?.modules ?? []) if (!([...MODULES, "backup"] as readonly string[]).includes(m)) fail("invalid_option", `unknown module "${m}"`, `one of: ${MODULES.join(", ")}, backup`);
  if (facts.legacy && (scope?.modules?.length || scope?.sites?.length)) {
    fail("legacy_layout", `${server.server} was set up under fornax's old name (anvil) and moves over in one full plan`, "a plan limited to sites or modules would remove the old files without writing all new ones", `fornax plan ${server.server}`);
  }
  // /etc in git first: everything after it is part of the server's history (full plans and bootstrap)
  const withHistory = !scope?.sites?.length && (!scope?.modules?.length || scope.modules.includes("base"));
  const r: Resource[] = [pendingHandlers(), ...legacyEarly(ctx), ...(withHistory ? [...historyResources(ctx), ...rootAccessResources(ctx)] : [])];
  for (const m of MODULES) {
    if (server.modules.includes(m) && wantModules.includes(m)) r.push(...SERVER_MODULES[m](ctx));
  }
  const onlyModules = Boolean(scope?.modules?.length) && !scope?.sites?.length;
  if (!onlyModules) {
    const chosen = scope?.sites?.length ? ctx.sites.filter((s) => scope.sites!.includes(s.domain)) : ctx.sites;
    for (const d of scope?.sites ?? []) if (!ctx.sites.some((s) => s.domain === d)) fail("unknown_site", `no site "${d}" on ${server.server}`, undefined, `fornax site list ${server.server}`);
    // certbot and the deploy machinery are server-wide, but sites depend on them: always part of the plan
    if (!scope?.sites?.length) r.push(...detachResources(ctx), ...serverFiles(ctx));
    r.push(...deployResources(ctx));
    if (!scope?.sites?.length) r.push(...backupResources(ctx));
    for (const site of chosen) r.push(...siteResources(ctx, site));
  } else if ((wantModules as readonly string[]).includes("backup")) {
    // the backup on its own (after `server rename`: new repository path and host names)
    r.push(...backupResources(ctx));
  }
  r.push(...legacyLate(ctx));
  // Several sites may need the same shared resource; identical ones are merged, conflicting ones stay and fail in makePlan.
  const seen = new Map<string, Resource>();
  return r.filter((x) => {
    const prev = seen.get(x.id);
    if (prev && prev.desired === x.desired && prev.apply === x.apply) return false;
    seen.set(x.id, x);
    return true;
  });
}
