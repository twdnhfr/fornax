import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fail } from "../core/errors.ts";
import type { Fleet, ResolvedSite } from "../core/fleet.ts";
import { check, file, type Resource } from "../core/resource.ts";
import type { FileSpec, Server } from "../core/schema.ts";
import { q } from "../core/shell.ts";

export interface ModuleCtx {
  fleet: Fleet;
  server: Server;
  sites: ResolvedSite[];
  /** Live facts gathered before planning. */
  facts: Facts;
  admin: string;
}

export interface Facts {
  arch: "arm64" | "x86_64";
  codename: string;
  /** Ubuntu version, e.g. "24.04". */
  version: string;
  /** Whether the ondrej/php PPA serves this Ubuntu release (several PHP versions side by side). */
  phpPpa: boolean;
  binary?: { path: string; sha: string; build?: string };
  /** Backup heartbeat URL resolved for this plan (value stays in memory, only its hash is planned). */
  heartbeat?: { value: string; ref?: string };
  /** ntfy access token resolved for this plan (same handling as the heartbeat). */
  ntfyToken?: { value: string; ref?: string };
  /** The server still carries fornax's old name (anvil): `legacy.ts` moves it over. */
  legacy?: boolean;
  /** Its admin user is the old default "anvil" (and no "fornax" exists): keep using it. */
  legacyAdmin?: boolean;
  /** composer auth.json per site, resolved for this plan (only hashes end up in the plan). */
  composerAuth?: Record<string, { value: string; ref?: string }>;
  /** Public half of the fleet's SSH key (ssh.key), for Tailscale fleets: taken off root once Tailscale SSH works. */
  fleetKey?: string;
}

/** What differs between the supported Ubuntu LTS releases. */
export const DISTROS: Record<string, { codename: string; postgres: number; systemPhp: string }> = {
  "24.04": { codename: "noble", postgres: 16, systemPhp: "8.3" },
  "26.04": { codename: "resolute", postgres: 18, systemPhp: "8.5" },
};
export const SUPPORTED_UBUNTU = Object.keys(DISTROS);

export const HEADER = "managed by fornax — edit the fleet repo, not this file";
export const hashHeader = `# ${HEADER}\n`;

export const SECRETS = "/etc/fornax/secrets";

/**
 * Generate a random secret on the server once; never leaves the server unless asked for.
 * The apply checks again: a secret that appeared after the plan (e.g. copied there by
 * legacy.ts in the same apply) is kept, never replaced — a new restic key would lock out every backup.
 */
export function secretFile(path: string, owner: string, o: { group?: string; bytes?: number; prefix?: string } = {}): Resource {
  const grp = o.group ?? "root";
  return check(
    `secret:${path}`,
    `generate secret ${path}`,
    `[ -s ${q(path)} ]`,
    `[ -d ${q(path.replace(/\/[^/]+$/, ""))} ] || install -d -m 0711 ${q(path.replace(/\/[^/]+$/, ""))}
[ -s ${q(path)} ] || { umask 077; printf '%s%s' ${q(o.prefix ?? "")} "$(openssl rand -hex ${o.bytes ?? 24})" > ${q(path)}; }
chgrp ${q(grp)} ${q(path)}; chmod 0640 ${q(path)}`,
    { owner },
  );
}

export interface AptRepo {
  name: string;
  key: string;
  /** Key is already binary (no `gpg --dearmor`). */
  binaryKey?: boolean;
  line: (keyring: string, codename: string) => string;
}

export const REPOS: Record<string, AptRepo> = {
  nginx: {
    name: "nginx",
    key: "https://nginx.org/keys/nginx_signing.key",
    line: (k, c) => `deb [signed-by=${k}] https://nginx.org/packages/mainline/ubuntu ${c} nginx`,
  },
  php: {
    name: "ondrej-php",
    key: "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x14AA40EC0831756756D7F66C4F4EA0AAE5267A6C",
    line: (k, c) => `deb [signed-by=${k}] https://ppa.launchpadcontent.net/ondrej/php/ubuntu ${c} main`,
  },
  node: {
    name: "nodesource",
    key: "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key",
    line: (k) => `deb [signed-by=${k}] https://deb.nodesource.com/node_22.x nodistro main`,
  },
  redis: {
    name: "redis",
    key: "https://packages.redis.io/gpg",
    line: (k, c) => `deb [signed-by=${k}] https://packages.redis.io/deb ${c} main`,
  },
  crowdsec: {
    name: "crowdsec",
    key: "https://packagecloud.io/crowdsec/crowdsec/gpgkey",
    // the distribution-independent channel: works on new Ubuntu releases from day one
    line: (k) => `deb [signed-by=${k}] https://packagecloud.io/crowdsec/crowdsec/any/ any main`,
  },
  tailscale: {
    name: "tailscale",
    key: "https://pkgs.tailscale.com/stable/ubuntu/{codename}.noarmor.gpg",
    binaryKey: true,
    line: (k, c) => `deb [signed-by=${k}] https://pkgs.tailscale.com/stable/ubuntu ${c} main`,
  },
};

export function aptRepo(ctx: ModuleCtx, repo: AptRepo, owner: string): Resource[] {
  const keyring = `/etc/apt/keyrings/${repo.name}.gpg`;
  const keyUrl = repo.key.replace("{codename}", ctx.facts.codename);
  const fetch = repo.binaryKey
    ? `curl -fsSL ${q(keyUrl)} -o ${q(keyring)}`
    : `curl -fsSL ${q(keyUrl)} | gpg --dearmor --yes -o ${q(keyring)}`;
  return [
    check(`apt-key:${repo.name}`, `apt key for ${repo.name}`, `[ -s ${q(keyring)} ]`, `install -d -m 0755 /etc/apt/keyrings; ${fetch}; chmod 0644 ${q(keyring)}`, { owner, handler: "apt" }),
    file(`/etc/apt/sources.list.d/${repo.name}.list`, `# ${HEADER}\n${repo.line(keyring, ctx.facts.codename)}\n`, { owner }),
  ];
}

/**
 * Remove files matching a glob that are not in `keep` (e.g. supervisor programs of a site
 * that were dropped from the config). Probed server-side because the set is unknown locally.
 */
export function prune(id: string, glob: string, keep: string[], o: { owner: string; handler?: string }): Resource {
  const extras = `for f in ${glob}; do [ -e "$f" ] || continue; case " ${keep.join(" ")} " in *" $f "*) ;; *) echo "$f";; esac; done`;
  const base = check(`prune:${id}`, `remove stale ${glob}`, "true", `for f in $(${extras}); do fornax_backup ${q(o.handler ?? "none")} "$f"; rm -f "$f"; echo "removed $f"; done`, {
    owner: o.owner,
    handler: o.handler,
  });
  // The probe lists what would be removed, so the plan shows it.
  return { ...base, probe: `x="$(${extras})"; if [ -z "$x" ]; then echo ok; else echo "$x" | tr '\\n' ' '; fi` };
}

/** Files from the fleet config (server- or site-level), content read from the fleet dir. */
export function configFiles(ctx: ModuleCtx, files: FileSpec[], owner: string): Resource[] {
  return files.map((f) => {
    let content = f.content;
    if (f.source !== undefined) {
      const p = isAbsolute(f.source) ? f.source : join(ctx.fleet.dir, f.source);
      if (!existsSync(p)) fail("config_invalid", `${owner}: file source ${f.source} does not exist`);
      content = readFileSync(p, "utf8");
    }
    return file(f.path, content!, { owner, mode: f.mode, user: f.owner, handler: f.handler === "auto" ? undefined : f.handler });
  });
}
