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
  /** keep: the server's own binary, left as it is (a peer host without a build for its architecture). */
  binary?: { path: string; sha: string; build?: string; keep?: boolean };
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
  /** fornax set the server's web stack up (a full plan was applied): single-site plans may follow. */
  provisioned?: boolean;
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
  /** Fingerprints of the key's primary keys: a downloaded key is installed only if it has exactly these. */
  fingerprints: string[];
  /** Key is already binary (no `gpg --dearmor`). */
  binaryKey?: boolean;
  line: (keyring: string, codename: string, arch: "amd64" | "arm64") => string;
}

export const REPOS: Record<string, AptRepo> = {
  nginx: {
    name: "nginx",
    fingerprints: ["573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62", "8540A6F18833A80E9C1653A42FD21310B49F6B46", "9E9BE90EACBCDE69FE9B204CBCDCD8A38D88A2B3"],
    key: "https://nginx.org/keys/nginx_signing.key",
    line: (k, c) => `deb [signed-by=${k}] https://nginx.org/packages/mainline/ubuntu ${c} nginx`,
  },
  php: {
    name: "ondrej-php",
    fingerprints: ["14AA40EC0831756756D7F66C4F4EA0AAE5267A6C"],
    key: "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x14AA40EC0831756756D7F66C4F4EA0AAE5267A6C",
    line: (k, c) => `deb [signed-by=${k}] https://ppa.launchpadcontent.net/ondrej/php/ubuntu ${c} main`,
  },
  node: {
    name: "nodesource",
    fingerprints: ["6F71F525282841EEDAF851B42F59B5F99B1BE0B4"],
    key: "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key",
    line: (k) => `deb [signed-by=${k}] https://deb.nodesource.com/node_22.x nodistro main`,
  },
  redis: {
    name: "redis",
    fingerprints: ["54318FA4052D1E61A6B6F7BB5F4349D6BF53AA0C"],
    key: "https://packages.redis.io/gpg",
    line: (k, c) => `deb [signed-by=${k}] https://packages.redis.io/deb ${c} main`,
  },
  crowdsec: {
    name: "crowdsec",
    fingerprints: ["6A89E3C2303A901A889971D3376ED5326E93CD0C"],
    key: "https://packagecloud.io/crowdsec/crowdsec/gpgkey",
    // the distribution-independent channel: works on new Ubuntu releases from day one
    line: (k) => `deb [signed-by=${k}] https://packagecloud.io/crowdsec/crowdsec/any/ any main`,
  },
  // the 1Password CLI, for peers: a host reads the fleet's secrets with the token its client hands it per run
  onepassword: {
    name: "1password",
    fingerprints: ["3FEF9748469ADBE15DA7CA80AC2D62742012EA22"],
    key: "https://downloads.1password.com/linux/keys/1password.asc",
    line: (k, _c, a) => `deb [arch=${a} signed-by=${k}] https://downloads.1password.com/linux/debian/${a} stable main`,
  },
  tailscale: {
    name: "tailscale",
    fingerprints: ["2596A99EAAB33821893C0A79458CA832957F5868"],
    key: "https://pkgs.tailscale.com/stable/ubuntu/{codename}.noarmor.gpg",
    binaryKey: true,
    line: (k, c) => `deb [signed-by=${k}] https://pkgs.tailscale.com/stable/ubuntu ${c} main`,
  },
};

/** Shell expression: the primary-key fingerprints in a key file (armored or binary), sorted, space-separated. */
const keyFingerprints = (path: string) =>
  `$(h="$(mktemp -d)"; gpg --homedir "$h" --batch --with-colons --show-keys ${path} 2>/dev/null | awk -F: '$1=="pub"{p=1;next} $1=="fpr"&&p{print $10;p=0}' | sort -u | paste -sd ' ' -; rm -rf "$h")`;

export function aptRepo(ctx: ModuleCtx, repo: AptRepo, owner: string): Resource[] {
  const keyring = `/etc/apt/keyrings/${repo.name}.gpg`;
  const keyUrl = repo.key.replace("{codename}", ctx.facts.codename);
  const expected = [...repo.fingerprints].sort().join(" ");
  // a key from the web counts only with the fingerprints fornax knows: TLS alone does not vouch for what is served
  const fetch = `( d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
curl -fsSL ${q(keyUrl)} -o "$d/key"
got="${keyFingerprints('"$d/key"')}"
[ "$got" = ${q(expected)} ] || { echo ${q(`apt key for ${repo.name}: expected ${expected}, got`)} "\${got:-no key}" >&2; exit 1; }
${repo.binaryKey ? `install -m 0644 "$d/key" ${q(keyring)}` : `gpg --dearmor --yes -o "$d/key.gpg" "$d/key" && install -m 0644 "$d/key.gpg" ${q(keyring)}`} )`;
  return [
    check(`apt-key:${repo.name}`, `apt key for ${repo.name}`, `[ "${keyFingerprints(q(keyring))}" = ${q(expected)} ]`, `install -d -m 0755 /etc/apt/keyrings\n${fetch}`, { owner, handler: "apt" }),
    file(`/etc/apt/sources.list.d/${repo.name}.list`, `# ${HEADER}\n${repo.line(keyring, ctx.facts.codename, ctx.facts.arch === "arm64" ? "arm64" : "amd64")}\n`, { owner }),
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
