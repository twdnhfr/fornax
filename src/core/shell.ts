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

export const sha256 =(s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** Indent every line (for readable generated scripts). */
export const indent = (s: string, n = 2) =>
  s
    .split("\n")
    .map((l) => (l ? " ".repeat(n) + l : l))
    .join("\n");
