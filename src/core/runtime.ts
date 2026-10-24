import type { Fleet, ResolvedSite } from "./fleet.ts";

/**
 * What a server needs to deploy a site without the fleet repo: written to
 * /etc/fornax/sites/<domain>.json and read by `fornax release` and `fornax hook serve`.
 */
export interface SiteRuntime {
  version: 1;
  domain: string;
  user: string;
  root: string;
  php: string;
  preset: "laravel" | "php" | "static" | "node";
  repo_url: string;
  /** owner/name when the repo is on GitHub (webhook check, commit status). */
  github_repo: string | null;
  branch: string;
  shared: string[];
  keep_releases: number;
  deploy_script: string;
  /** Build commands from the fleet config, used when the repo has no deploy script. */
  deploy_commands: string | null;
  /** "in_place": the site directory is the checkout (missing in older runtimes = releases). */
  mode?: "releases" | "in_place";
  health_check: { url: string; host: string; https: boolean } | null;
  /** nginx socket serving releases/next (generated vhosts only) — health check before activation. */
  preview_socket: string | null;
  programs: string[];
  /** preset node: the two slots (systemd unit, port) and the nginx upstream file naming the live one. */
  node?: NodeRuntime | null;
  notify: { url: string | null; github_status: boolean; ntfy?: { url: string; email?: string; token_file?: string } | null; on?: "failure" | "always" };
  uses_deploy_key: boolean;
}

export interface NodeRuntime {
  slots: Array<{ name: "a" | "b"; unit: string; port: number; link: string }>;
  upstream: { file: string; name: string };
}

/**
 * A node app runs in two slots, a and b: systemd units of the site user, each on its own port,
 * started from the release `<root>/slot-<x>` points at. Whichever is enabled is the live one; nginx
 * reaches it through an upstream in a file outside /etc that only deploys rewrite.
 */
export function nodeSlots(s: Pick<ResolvedSite, "slug" | "root">, ports: [number, number]): NodeRuntime {
  return {
    slots: (["a", "b"] as const).map((name, i) => ({ name, unit: `fornax-node-${s.slug}-${name}.service`, port: ports[i]!, link: `${s.root}/slot-${name}` })),
    upstream: { file: `${NODE_UPSTREAM_DIR}/${s.slug}.conf`, name: `fornax-node-${s.slug}` },
  };
}

export const NODE_UPSTREAM_DIR = "/var/lib/fornax/nginx";

/** The nginx upstream of a node app, pointing at one slot's port. */
export const nodeUpstreamConf = (name: string, port: number | string) =>
  `# managed by fornax — rewritten by each deploy of a node app: the slot that serves\nupstream ${name} {\n    server 127.0.0.1:${port};\n    keepalive 16;\n}\n`;

export const RUNTIME_DIR = "/etc/fornax/sites";
export const REQUEST_DIR = "/var/lib/fornax/requests";
export const HOOK_SECRET_DIR = "/etc/fornax/hook-secrets";
export const DEPLOY_KEY = (user: string) => `/home/${user}/.ssh/fornax-deploy`;
/**
 * Logs root writes for a site (supervisor daemons, deploys) — root-owned, readable by the site's
 * group. Never under /home/<user>: the site user could point a symlink there at any file of root's.
 */
export const SITE_LOG_ROOT = "/var/log/fornax-sites";
export const SITE_LOG_DIR = (user: string) => `${SITE_LOG_ROOT}/${user}`;
export const DEPLOY_LOG_DIR = (user: string) => `${SITE_LOG_ROOT}/${user}/deploys`;
export const KNOWN_HOSTS = "/etc/fornax/known_hosts";
/** Root-only; read by `fornax release` when it notifies. */
export const NTFY_TOKEN_FILE = "/etc/fornax/secrets/ntfy-token";

/** GitHub's published SSH host key (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints). */
export const GITHUB_HOST_KEY = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

export function repoUrl(repo: string): { url: string; github: string | null; ssh: boolean } {
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return { url: `git@github.com:${repo}.git`, github: repo, ssh: true };
  const gh = repo.match(/^(?:git@github\.com:|(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  const ssh = /^[\w.-]+@[\w.-]+:/.test(repo) || repo.startsWith("ssh://");
  return { url: repo, github: gh ? gh[1]! : null, ssh };
}

export function siteRuntime(fleet: Fleet, s: ResolvedSite, programs: string[]): SiteRuntime {
  const r = repoUrl(s.spec.repo!);
  const https = s.tlsIssuer !== "none";
  // a node release is always checked before it serves: there is no "it is only files" case
  const health = s.spec.health_check ?? (s.node ? "/" : undefined);
  return {
    version: 1,
    domain: s.domain,
    user: s.user,
    root: s.root,
    php: s.php,
    preset: s.spec.preset,
    repo_url: r.url,
    github_repo: r.github,
    branch: s.spec.branch,
    shared: s.shared,
    keep_releases: s.spec.deploy.keep_releases,
    deploy_script: s.spec.deploy.script,
    deploy_commands: s.spec.deploy.commands ?? null,
    mode: s.spec.deploy.mode,
    health_check: health ? { url: `${https ? "https" : "http"}://${s.domain}${health.startsWith("/") ? "" : "/"}${health}`, host: s.domain, https } : null,
    // a node release is checked on its own port instead
    preview_socket: s.spec.generate.vhost && !s.inPlace && !s.node ? `/run/fornax-nginx/${s.slug}.sock` : null,
    programs,
    ...(s.node ? { node: nodeSlots(s, s.node.ports) } : {}),
    notify: {
      url: fleet.config.notify.webhook ?? null,
      github_status: fleet.config.notify.github_status && Boolean(r.github),
      ntfy: siteRuntimeNtfy(fleet),
      on: fleet.config.notify.on,
    },
    uses_deploy_key: r.ssh,
  };
}

/** The fleet's ntfy target as the server sees it (the token only as a root-only file). */
export function siteRuntimeNtfy(fleet: Fleet): { url: string; email?: string; token_file?: string } | null {
  const n = fleet.config.notify.ntfy;
  return n ? { url: n.url, ...(n.email ? { email: n.email } : {}), ...(n.token ? { token_file: NTFY_TOKEN_FILE } : {}) } : null;
}
