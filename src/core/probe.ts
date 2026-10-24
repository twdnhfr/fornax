/**
 * Remote facts come back as tab-separated lines: `key<TAB>value`. Repeated keys collect into
 * lists. Values never contain newlines (scripts use `tr` or base64 where needed).
 */
export type Facts = Map<string, string[]>;

export function parseFacts(out: string): Facts {
  const facts: Facts = new Map();
  for (const line of out.split("\n")) {
    const i = line.indexOf("\t");
    if (i <= 0) continue;
    const k = line.slice(0, i);
    const v = line.slice(i + 1);
    const list = facts.get(k);
    if (list) list.push(v);
    else facts.set(k, [v]);
  }
  return facts;
}

export const one = (f: Facts, k: string): string | undefined => f.get(k)?.[0];
export const all = (f: Facts, k: string): string[] => f.get(k) ?? [];
export const num = (f: Facts, k: string): number | undefined => {
  const v = one(f, k);
  return v === undefined || v === "" ? undefined : Number(v);
};

/** Bash helper prepended to probe scripts: `fact key value...` prints one fact line. */
export const FACT_FN = `fact() { local k="$1"; shift; printf '%s\\t%s\\n' "$k" "$(printf '%s' "$*" | tr '\\n\\t' '  ')"; }`;

/** Strip credentials from git remote URLs (Forge embeds OAuth tokens there). */
export const scrubUrl = (url: string) => url.replace(/^(\w+:\/\/)[^@/]+@/, "$1");
