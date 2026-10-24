export const VERSION = "1.0.0";

declare const FORNAX_BUILD: string | undefined;

/**
 * When this binary was built (ISO time of its newest source file), set with `bun build --define`.
 * Undefined when fornax runs from source. Decides whether a server's binary is older or newer.
 */
export const BUILD: string | undefined = typeof FORNAX_BUILD === "string" ? FORNAX_BUILD : undefined;

/** Semver order (1.2.10 after 1.2.9; a prerelease such as 1.0.0-rc.1 before 1.0.0): negative, 0 or positive. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2) as [string, string | undefined];
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre, "en", { numeric: true });
}

/**
 * A key that sorts fornax builds as `sort` does on a server: version first (padded, a release after
 * its prereleases), then the build stamp — an unstamped build before any stamped one of its version.
 * The same formula runs in shell for the server's binary (binaryProbe), so both sides compare alike.
 */
export function orderKey(version: string, build?: string): string {
  const v = version.replace(/^v/, "");
  const dash = v.indexOf("-");
  const [core, pre] = dash < 0 ? [v, undefined] : [v.slice(0, dash), v.slice(dash + 1)];
  const n = core.split(".").map((x) => String(Number(x) || 0).padStart(6, "0"));
  // rc.10 after rc.9: numeric parts of a prerelease padded as well
  const p = pre?.split(".").map((x) => (/^\d+$/.test(x) ? x.padStart(6, "0") : x)).join(".");
  return `${n[0]}.${n[1] ?? "000000"}.${n[2] ?? "000000"}.${p ? `0${p}` : "1"}~${build ?? ""}`;
}

/** orderKey in awk, reading "<version> <build>" (build may be empty). */
export const ORDER_KEY_AWK = `awk '{i=index($1,"-"); core=(i?substr($1,1,i-1):$1); pre=(i?substr($1,i+1):""); split(core,n,"."); p=""; if (pre!="") { k=split(pre,q,"."); for (j=1;j<=k;j++) p=p (j>1?".":"") (q[j] ~ /^[0-9]+$/ ? sprintf("%06d",q[j]) : q[j]); p="0" p } else p="1"; printf "%06d.%06d.%06d.%s~%s", n[1],n[2],n[3],p,$2}'`;
