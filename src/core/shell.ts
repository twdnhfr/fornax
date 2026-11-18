import { posix } from "node:path";

/** Quote a value for bash: always single quotes, embedded quotes escaped. */
export const q = (s: string | number): string => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** Shell snippet that writes `content` to stdout without any quoting concerns. */
export const emit = (content: string): string => `printf %s ${q(b64(content))} | base64 -d`;

/**
 * Run a snippet as a (site) user — for anything inside that user's home, where root would follow
 * symlinks the user planted. The environment is cleared (no apply secrets reach the user) except
 * for the variables named in `keep`.
 */
export const asUser = (user: string, script: string, keep: string[] = []): string =>
  `( cd / && env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/${user} LANG=C.UTF-8${keep.map((k) => ` ${k}="$${k}"`).join("")} setpriv --reuid=${q(user)} --regid="$(id -g ${q(user)})" --init-groups -- bash -c ${q(script)} )`;

/** Is `path` inside the home of `user` (and so controlled by that user)? */
export const inHome = (user: string | undefined, path: string): boolean => !!user && user !== "root" && path.startsWith(`/home/${user}/`);

/** The user whose home holds `path` (/home/<user>/…) — whoever else acts there could be led astray by that user's symlinks. */
export const homeOf = (path: string): string | undefined => posix.normalize(path).match(/^\/home\/([^/]+)\/./)?.[1];

export const sha256 =(s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** Indent every line (for readable generated scripts). */
export const indent = (s: string, n = 2) =>
  s
    .split("\n")
    .map((l) => (l ? " ".repeat(n) + l : l))
    .join("\n");

/**
 * Shell: `body` once per home in /home, run as the owner of that home with the home as $1 — root only looks
 * at /home/<name> itself. A home owned by root, or by a uid without an account, is not entered (`orphan`
 * runs with $h instead): links left there could lead anywhere.
 */
export function asEachHomeOwner(body: string, orphan = ":"): string {
  return `for h in /home/*; do
  [ -d "$h" ] && [ ! -L "$h" ] || continue
  uid=$(stat -c %u -- "$h") && gid=$(stat -c %g -- "$h") || continue
  [ "$uid" -ne 0 ] || continue
  u=$(getent passwd "$uid" | cut -d: -f1) || u=""
  if [ -z "$u" ]; then ${orphan}; continue; fi
  ( cd / && env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME="$h" LANG=C.UTF-8 setpriv --reuid="$uid" --regid="$gid" --init-groups -- bash -c ${q(body)} _ "$h" )
done`;
}
