/**
 * Servers set up before the rename (the project was called anvil) move over in one apply:
 *
 *   early  — before every other resource: state, secrets, keys and deploy history are copied
 *            to the new names (copied, so the old configuration keeps working until it is
 *            replaced in the same apply); files that would clash under both names are renamed;
 *            the old webhook and backup timer stop; the hook user is renamed.
 *   late   — after every other resource: whatever still carries the old name goes, then the
 *            services that read it reload (each one checked first).
 *
 * Secrets are never regenerated: the restic key, webhook secrets and deploy keys stay the same,
 * so GitHub, the Storage Box and existing backups notice nothing.
 */
import { SITE_LOG_ROOT } from "../core/runtime.ts";
import { check, type Resource } from "../core/resource.ts";
import type { ModuleCtx } from "./common.ts";

/** Everything the old name left on a server (also what `preflight` looks for). */
export const LEGACY_GLOBS = [
  "/usr/local/bin/anvil",
  "/usr/local/sbin/anvil-trigger",
  "/etc/anvil",
  "/var/lib/anvil",
  "/var/log/anvil",
  "/var/tmp/anvil-staging",
  "/run/anvil-nginx",
  "/etc/nginx/anvil",
  "/etc/nginx/conf.d/anvil-log.conf",
  "/etc/nginx/sites-available/anvil-hook",
  "/etc/nginx/sites-enabled/anvil-*",
  "/etc/systemd/system/anvil-*",
  "/etc/supervisor/conf.d/anvil-*",
  "/etc/php/*/fpm/pool.d/anvil-*",
  "/etc/php/*/fpm/conf.d/90-anvil.ini",
  "/etc/php/*/cli/conf.d/90-anvil.ini",
  "/etc/cron.d/anvil-*",
  "/etc/logrotate.d/anvil-*",
  "/etc/sudoers.d/anvil-*",
  "/etc/tmpfiles.d/anvil-nginx.conf",
  "/etc/letsencrypt/renewal-hooks/deploy/anvil-reload-nginx",
  "/etc/crowdsec/scenarios/anvil-*",
  "/etc/apt/preferences.d/99anvil-nginx",
  "/etc/apt/apt.conf.d/52anvil-upgrades",
  "/etc/fail2ban/jail.d/anvil.conf",
  "/etc/mysql/mysql.conf.d/zz-anvil.cnf",
  "/etc/ssh/sshd_config.d/00-anvil.conf",
  "/etc/systemd/journald.conf.d/anvil.conf",
  "/etc/redis/anvil.conf",
  "/etc/redis/anvil-auth.conf",
  "/root/.ssh/anvil-storagebox",
  "/root/.ssh/anvil-storagebox.pub",
  "/home/*/.anvil",
  "/home/*/.ssh/anvil-deploy",
  "/home/*/.ssh/anvil-deploy.pub",
];

/** Shell: true when nothing of the old name is left (and no anvil-hook user). */
export const LEGACY_GONE = `[ -z "$(ls -d ${LEGACY_GLOBS.join(" ")} 2>/dev/null)" ] && ! id -u anvil-hook >/dev/null 2>&1`;

const EARLY = `# the old webhook and backup timer stop first: the new units take over their port and schedule
systemctl disable --now anvil-hook.service anvil-backup.timer 2>/dev/null || true
# copied, not moved: the old configuration keeps working until this apply replaces it
copy() {
  [ -e "$1" ] || return 0
  if [ -d "$1" ] && [ -d "$2" ]; then cp -an "$1/." "$2/"; else mkdir -p "$(dirname "$2")"; cp -an "$1" "$2"; fi
}
copy /etc/anvil /etc/fornax
copy /var/lib/anvil /var/lib/fornax
copy /var/log/anvil /var/log/fornax
copy /etc/nginx/anvil /etc/nginx/fornax
copy /root/.ssh/anvil-storagebox /root/.ssh/fornax-storagebox
copy /root/.ssh/anvil-storagebox.pub /root/.ssh/fornax-storagebox.pub
# inside a home as its user (root would follow links planted there); the deploy history goes to
# the root-owned log directory, regular files only
for h in /home/*; do
  u=$(stat -c %U "$h"); g=$(stat -c %G "$h")
  asu() { setpriv --reuid="$u" --regid="$g" --init-groups -- "$@"; }
  if [ -d "$h/.anvil" ]; then
    asu bash -c 'mkdir -p "$1/.fornax" && cd "$1/.anvil" && find . -mindepth 1 -maxdepth 1 ! -name deploys -exec cp -an {} "$1/.fornax/" \\;' _ "$h"
    if [ -d "$h/.anvil/deploys" ]; then
      install -d -m 0750 -o root -g "$g" "${SITE_LOG_ROOT}/$u" "${SITE_LOG_ROOT}/$u/deploys"
      asu bash -c 'cd "$1/.anvil/deploys" && find . -maxdepth 1 -type f \\( -name "*.log" -o -name "*.json" \\) -print0 | tar --null --no-recursion -cf - -T -' _ "$h" | tar -xf - -C "${SITE_LOG_ROOT}/$u/deploys" --no-same-owner
      find "${SITE_LOG_ROOT}/$u/deploys" -mindepth 1 ! -type f -delete
    fi
  fi
  for k in anvil-deploy anvil-deploy.pub; do
    [ -e "$h/.ssh/$k" ] && asu cp -an "$h/.ssh/$k" "$h/.ssh/fornax-\${k#anvil-}"
  done
done
# certbot renews from the copied ACME webroot
[ -d /etc/letsencrypt/renewal ] && sed -i 's#/var/lib/anvil/acme#/var/lib/fornax/acme#g' /etc/letsencrypt/renewal/*.conf 2>/dev/null || true
# files that must not exist twice (a pool or program under both names would clash): renamed
ren() { for f in $1; do [ -e "$f" ] || continue; mv -f "$f" "$(dirname "$f")/$(basename "$f" | sed 's/anvil/fornax/')"; done; }
ren "/etc/php/*/fpm/pool.d/anvil-*.conf"
ren "/etc/supervisor/conf.d/anvil-*.conf"
ren "/etc/cron.d/anvil-*"
ren "/etc/logrotate.d/anvil-*"
ren "/etc/crowdsec/scenarios/anvil-*"
rm -f /etc/sudoers.d/anvil-hook
id -u anvil-hook >/dev/null 2>&1 && ! id -u fornax-hook >/dev/null 2>&1 && { usermod -l fornax-hook anvil-hook; groupmod -n fornax-hook anvil-hook; }
true`;

const LATE = `rm -rf ${LEGACY_GLOBS.filter((g) => !g.startsWith("/etc/redis") && !g.startsWith("/home/")).join(" ")}
# in a home as its user, as in EARLY
for h in /home/*; do
  [ -d "$h" ] && [ ! -L "$h" ] || continue
  setpriv --reuid="$(stat -c %U "$h")" --regid="$(stat -c %G "$h")" --init-groups -- rm -rf "$h/.anvil" "$h/.ssh/anvil-deploy" "$h/.ssh/anvil-deploy.pub" || true
done
if [ -e /etc/redis/anvil.conf ]; then sed -i '\\#^include /etc/redis/anvil.conf$#d' /etc/redis/redis.conf; rm -f /etc/redis/anvil.conf /etc/redis/anvil-auth.conf; fi
id -u anvil-hook >/dev/null 2>&1 && userdel anvil-hook
# the services that read the removed files reload — each config checked first
systemctl daemon-reload
command -v supervisorctl >/dev/null && { supervisorctl reread >/dev/null; supervisorctl update >/dev/null; } || true
for d in /etc/php/*/fpm; do v=$(basename "$(dirname "$d")"); systemctl is-active --quiet "php$v-fpm" || continue; "php-fpm$v" -t >/dev/null 2>&1 || { echo "php-fpm $v rejects its config without the old files" >&2; false; }; systemctl reload "php$v-fpm"; done
if systemctl is-active --quiet nginx; then nginx -t -q || { echo "nginx rejects its config without the old files" >&2; false; }; systemctl reload nginx; fi
if [ -e /etc/ssh/sshd_config.d/00-fornax.conf ]; then sshd -t && systemctl reload ssh; fi
systemctl is-active --quiet fail2ban && systemctl reload fail2ban || true
true`;

/** Before everything else: only on servers that still carry the old name. */
export function legacyEarly(ctx: ModuleCtx): Resource[] {
  if (!ctx.facts.legacy) return [];
  return [check("rename:copy", "move fornax's predecessor (anvil) over: copy state, secrets, keys and history to the new names", LEGACY_GONE, EARLY, { owner: "rename" })];
}

/** After everything else: the old names go. */
export function legacyLate(ctx: ModuleCtx): Resource[] {
  if (!ctx.facts.legacy) return [];
  return [check("rename:cleanup", "remove what is left under the old name (anvil) and reload the services that read it", LEGACY_GONE, LATE, { owner: "rename" })];
}
