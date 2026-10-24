import { asUser, emit, inHome, q, sha256 } from "./shell.ts";

/**
 * Something on a server that should be in a certain state. Every resource knows how to
 * probe its current state (a bash snippet printing one string), what that string should be,
 * and how to converge. Plan = resources whose probe differs from `desired`.
 */
export interface Resource {
  id: string;
  kind: "file" | "absent" | "symlink" | "dir" | "packages" | "service" | "check";
  summary: string;
  /** Module or site that produced it, for grouping in plans. */
  owner: string;
  probe: string;
  desired: string;
  apply: string;
  /** Name of the handler to run after a change (see HANDLERS). */
  handler?: string;
  /** Run pending handlers before applying this resource (e.g. apt update before installs). */
  flushBefore?: boolean;
  destructive?: boolean;
  /** For file resources: desired content, used for content diffs. */
  content?: string;
  /** Content contains secrets — never show it in diffs. */
  sensitive?: boolean;
  /** For file resources: path on the server. */
  path?: string;
  /**
   * Secrets the apply snippet needs, as ENV_NAME → secret reference. They are resolved only
   * when applying and passed as environment variables — never stored in the plan or on disk.
   */
  env?: Record<string, string>;
  /** A local file that must be on the server (staged at `remote`) before `apply` runs. */
  upload?: { local: string; remote: string; sha: string };
}

export interface Handler {
  validate?: string;
  reload: string;
}

export const HANDLERS: Record<string, Handler> = {
  // after a reload old workers finish their requests with the old config; wait for them, so a file
  // removed next (an old FPM pool, say) is no longer used by anyone
  nginx: {
    validate: "nginx -t -q",
    reload: "systemctl reload nginx 2>/dev/null || systemctl restart nginx; sleep 0.3; for i in $(seq 100); do pgrep -f 'nginx: worker process is shutting down' >/dev/null || break; sleep 0.1; done",
  },
  supervisor: { reload: "supervisorctl reread >/dev/null && supervisorctl update" },
  ssh: { validate: "sshd -t", reload: "systemctl reload ssh" },
  systemd: { reload: "systemctl daemon-reload" },
  // wait for the dpkg lock instead of failing: fresh cloud servers and unattended-upgrades hold it for minutes
  apt: { reload: "apt-get -o DPkg::Lock::Timeout=900 update -qq" },
  mysql: { reload: "systemctl restart mysql" },
  postgres: { reload: "systemctl reload postgresql" },
  redis: { reload: "systemctl restart redis-server" },
  fail2ban: { reload: "systemctl reload-or-restart fail2ban" },
  crowdsec: { validate: "crowdsec -t >/dev/null 2>&1 || true", reload: "systemctl reload-or-restart crowdsec" },
  journald: { reload: "systemctl restart systemd-journald" },
  "fornax-hook": { reload: "systemctl daemon-reload && systemctl reload-or-restart fornax-hook 2>/dev/null || true" },
  // only fornax's own files: other tools leave theirs with modes visudo -c rejects (Forge: 0644)
  sudoers: { validate: 'for f in /etc/sudoers.d/fornax-*; do [ -e "$f" ] || continue; visudo -cqf "$f" || exit 1; done', reload: "true" },
  // a changed OnCalendar only takes effect once the timer is restarted
  "backup-timer": { reload: "systemctl daemon-reload && (systemctl is-active -q fornax-backup.timer && systemctl restart fornax-backup.timer || true)" },
  none: { reload: "true" },
};

export function phpHandler(version: string): Handler {
  return {
    validate: `php-fpm${version} -t 2>&1 | grep -v 'test is successful' >&2 || true; php-fpm${version} -t >/dev/null 2>&1`,
    // reload returns before FPM has created new pool sockets; nginx (reloaded next) must not see them missing
    reload: `systemctl reload php${version}-fpm && for s in $(grep -h '^listen *=' /etc/php/${version}/fpm/pool.d/*.conf | cut -d= -f2 | tr -d ' '); do case "$s" in /*) for i in $(seq 100); do [ -S "$s" ] && break; sleep 0.1; done;; esac; done`,
  };
}

export function handlerFor(name: string): Handler {
  const php = name.match(/^php(\d\.\d)-fpm$/);
  if (php) return phpHandler(php[1]!);
  // a site's own Redis (core/fleet.ts siteRedis): a running one restarts with its new config
  const redis = name.match(/^fornax-redis@([\w-]+)$/);
  if (redis) return { reload: `systemctl daemon-reload; systemctl try-restart ${redis[0]}` };
  // a node app's units (modules/site.ts nodeUnitConf) changed: its release starts with them in the
  // other slot and takes over without downtime — or fails, and the running one keeps serving.
  // Without deploys (no runtime) the running slot simply restarts.
  const node = name.match(/^fornax-node@([a-z0-9.-]+)$/);
  if (node) {
    const units = (["a", "b"] as const).map((x) => `fornax-node-${node[1]!.replace(/[^a-z0-9]+/g, "-")}-${x}.service`);
    const running = units.map((u) => `systemctl is-active -q ${u}`).join(" || ");
    return {
      reload: `systemctl daemon-reload; if ${running}; then if [ -f /etc/fornax/sites/${node[1]}.json ]; then /usr/local/bin/fornax release ${node[1]} --restart >/dev/null; else systemctl try-restart ${units.join(" ")}; fi; fi`,
    };
  }
  return HANDLERS[name] ?? HANDLERS.none!;
}

/** Derive the reload handler from a file path ("auto" in the config). */
export function autoHandler(path: string): string {
  if (path.startsWith("/etc/nginx/")) return "nginx";
  const php = path.match(/^\/etc\/php\/(\d\.\d)\/fpm\//);
  if (php) return `php${php[1]}-fpm`;
  if (path.startsWith("/etc/supervisor/")) return "supervisor";
  if (path.startsWith("/etc/ssh/")) return "ssh";
  if (path.startsWith("/etc/systemd/system/")) return "systemd";
  if (path.startsWith("/etc/apt/sources.list.d/") || path.startsWith("/etc/apt/keyrings/")) return "apt";
  if (path.startsWith("/etc/mysql/")) return "mysql";
  if (path.startsWith("/etc/postgresql/")) return "postgres";
  if (path.startsWith("/etc/redis/")) return "redis";
  if (path.startsWith("/etc/fail2ban/")) return "fail2ban";
  if (path.startsWith("/etc/crowdsec/")) return "crowdsec";
  if (path.startsWith("/etc/systemd/journald.conf.d/")) return "journald";
  if (path.startsWith("/etc/sudoers.d/")) return "sudoers";
  return "none";
}

const normMode = (m: string) => parseInt(m, 8).toString(8);

// ---- constructors ---------------------------------------------------------------

export interface FileOpts {
  owner: string;
  mode?: string;
  user?: string;
  handler?: string;
  sensitive?: boolean;
  summary?: string;
}

export function file(path: string, content: string, o: FileOpts): Resource {
  const mode = o.mode ?? "0644";
  const user = o.user ?? "root:root";
  const [u, g] = user.split(":");
  return {
    id: `file:${path}`,
    kind: "file",
    path,
    summary: o.summary ?? path,
    owner: o.owner,
    probe: `if [ -f ${q(path)} ] && [ ! -L ${q(path)} ]; then echo "$(sha256sum < ${q(path)} | cut -c1-64) $(stat -c '%a %U:%G' ${q(path)})"; else echo missing; fi`,
    desired: `${sha256(content)} ${normMode(mode)} ${u}:${g ?? u}`,
    apply: inHome(u, path)
      ? // written by the user: root would write through a symlink the user put there
        `${asUser(u!, `umask 077; mkdir -p "$(dirname ${q(path)})" && t=$(mktemp ${q(path + ".fornax.XXXXXX")}) && cat > "$t" && chmod ${mode} "$t" && mv -f "$t" ${q(path)}`)} < <(${emit(content)})`
      : `fornax_write ${q(path)} ${q(mode)} ${q(u!)} ${q(g ?? u!)} ${q(o.handler ?? autoHandler(path))} < <(${emit(content)})`,
    handler: o.handler ?? autoHandler(path),
    content,
    sensitive: o.sensitive,
  };
}

export function absent(path: string, o: { owner: string; handler?: string; recursive?: boolean; destructive?: boolean; summary?: string }): Resource {
  return {
    id: `absent:${path}`,
    kind: "absent",
    path,
    summary: o.summary ?? `remove ${path}`,
    owner: o.owner,
    probe: `if [ -e ${q(path)} ] || [ -L ${q(path)} ]; then echo present; else echo absent; fi`,
    desired: "absent",
    apply: `fornax_backup ${q(o.handler ?? autoHandler(path))} ${q(path)}; rm -${o.recursive ? "rf" : "f"} ${q(path)}`,
    handler: o.handler ?? autoHandler(path),
    destructive: o.destructive,
  };
}

export function symlink(path: string, target: string, o: { owner: string; handler?: string; user?: string }): Resource {
  const chown = o.user ? `; chown -h ${q(o.user)} ${q(path)}` : "";
  return {
    id: `symlink:${path}`,
    kind: "symlink",
    path,
    summary: `${path} → ${target}`,
    owner: o.owner,
    probe: `if [ -L ${q(path)} ]; then readlink ${q(path)}; elif [ -e ${q(path)} ]; then echo not-a-link; else echo missing; fi`,
    desired: target,
    apply: `fornax_backup ${q(o.handler ?? autoHandler(path))} ${q(path)}; mkdir -p "$(dirname ${q(path)})"; ln -sfn ${q(target)} ${q(path)}${chown}`,
    handler: o.handler ?? autoHandler(path),
  };
}

export function dir(path: string, o: { owner: string; mode?: string; user?: string }): Resource {
  const mode = o.mode ?? "0755";
  const user = o.user ?? "root:root";
  const [u, g] = user.split(":");
  return {
    id: `dir:${path}`,
    kind: "dir",
    path,
    summary: `directory ${path}`,
    owner: o.owner,
    probe: `if [ -d ${q(path)} ]; then stat -c '%a %U:%G' ${q(path)}; else echo missing; fi`,
    desired: `${normMode(mode)} ${u}:${g ?? u}`,
    // install -o chowns the target of a symlink: inside a user's home the user creates it
    apply: inHome(u, path) ? asUser(u!, `install -d -m ${mode} ${q(path)}`) : `install -d -m ${mode} -o ${q(u!)} -g ${q(g ?? u!)} ${q(path)}`,
  };
}

/** A set of apt packages, probed and installed together. */
export function packages(name: string, pkgs: string[], o: { owner: string }): Resource {
  const list = [...new Set(pkgs)].sort();
  return {
    id: `packages:${name}`,
    kind: "packages",
    summary: `packages (${name}): ${list.join(" ")}`,
    owner: o.owner,
    probe: `dpkg-query -W -f='\${Package} \${db:Status-Status}\\n' ${list.map(q).join(" ")} 2>/dev/null | awk '$2=="installed"{print $1}' | sort -u | tr '\\n' ' ' | sed 's/ $//'`,
    desired: list.join(" "),
    // fresh cloud images ship without package lists: refresh them when missing or older than an hour
    apply: `[ -n "$(find /var/lib/apt/lists -maxdepth 1 -name '*_Packages' -mmin -60 2>/dev/null | head -1)" ] || apt-get -o DPkg::Lock::Timeout=900 update -qq
apt-get install -y -q --no-install-recommends -o DPkg::Lock::Timeout=900 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold ${list.map(q).join(" ")}`,
    flushBefore: true,
  };
}

export function service(unit: string, o: { owner: string; enabled?: boolean }): Resource {
  const on = o.enabled ?? true;
  return {
    id: `service:${unit}`,
    kind: "service",
    summary: `${unit} ${on ? "enabled + running" : "stopped + disabled"}`,
    owner: o.owner,
    probe: `echo "$(systemctl is-enabled ${q(unit)} 2>/dev/null || true) $(systemctl is-active ${q(unit)} 2>/dev/null || true)" | awk '{print ($1=="enabled"||$1=="static"?"enabled":$1)" "$2}'`,
    desired: on ? "enabled active" : "disabled inactive",
    apply: on ? `systemctl enable --now ${q(unit)}` : `systemctl disable --now ${q(unit)}`,
    flushBefore: true,
  };
}

/** Anything else: a test that decides whether `run` is needed. */
export function check(id: string, summary: string, test: string, run: string, o: { owner: string; handler?: string; flushBefore?: boolean; destructive?: boolean }): Resource {
  return {
    id: `check:${id}`,
    kind: "check",
    summary,
    owner: o.owner,
    probe: `if ( ${test} ) >/dev/null 2>&1; then echo ok; else echo missing; fi`,
    desired: "ok",
    apply: run,
    handler: o.handler,
    flushBefore: o.flushBefore,
    destructive: o.destructive,
  };
}

/** Always part of the desired state: no reloads may be left over from an interrupted apply. */
export const pendingHandlers = (): Resource =>
  check("pending-handlers", "run reloads left over from an interrupted apply", "[ ! -s /var/lib/fornax/pending ]", ":", { owner: "fornax" });

/** Bash library prepended to every apply script. */
export const APPLY_LIB = `
BK="/var/lib/fornax/backup/$FORNAX_RUN"; mkdir -p "$BK"
# Reloads an interrupted apply did not get to run are remembered and run this time.
PENDING="$(cat /var/lib/fornax/pending 2>/dev/null || true)"
trap 'printf "%s" "$PENDING" > /var/lib/fornax/pending' EXIT
fornax_pending() { case " $PENDING " in *" $1 "*) ;; *) PENDING="$PENDING $1";; esac; }
fornax_backup() { # handler path
  local h="$1" p="$2" b
  b="$BK/$(printf '%s' "$p" | tr '/' '_')"
  if [ -e "$p" ] || [ -L "$p" ]; then rm -rf "$b"; cp -a "$p" "$b"; echo "$p|$b" >> "$BK/$h.list"; else echo "$p|" >> "$BK/$h.list"; fi
}
fornax_restore() { # handler
  [ -f "$BK/$1.list" ] || return 0
  tac "$BK/$1.list" | while IFS='|' read -r p b; do rm -rf "$p"; [ -n "$b" ] && cp -a "$b" "$p"; done
  echo "@@restored $1" ; rm -f "$BK/$1.list"
}
fornax_write() { # path mode user group handler  (content on stdin)
  local p="$1" m="$2" u="$3" g="$4" h="$5" t
  mkdir -p "$(dirname "$p")"
  fornax_backup "$h" "$p"
  t="$(mktemp "$p.fornax.XXXXXX")"
  cat > "$t"; chmod "$m" "$t"; chown "$u:$g" "$t"; mv -f "$t" "$p"
}
`;
