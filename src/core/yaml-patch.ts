/**
 * Change a YAML file through the document API without reformatting the rest of it.
 *
 * The yaml library re-serializes a whole document (comment alignment, flow spacing, folding).
 * So the change is made on a parsed copy, both copies are serialized the same way, and only the
 * lines that differ between them are carried into the original text — a three-way merge with the
 * normalized original as the base. Where the change touches a line whose formatting differs, the
 * new lines come normalized. If the merged text does not parse to exactly the changed data, the
 * whole document is serialized instead: correct beats pretty.
 */
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

const OPTS = { lineWidth: 0, flowCollectionPadding: false } as const;

interface Hunk {
  /** Range in the base. */
  aStart: number;
  aEnd: number;
  /** Range in the other side. */
  bStart: number;
  bEnd: number;
}

/** Changed regions between two line lists (LCS). */
function hunks(a: string[], b: string[]): Hunk[] {
  const n = a.length,
    m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: Hunk[] = [];
  let i = 0,
    j = 0,
    open: Hunk | null = null;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      if (open) out.push(open), (open = null);
      i++, j++;
      continue;
    }
    open ??= { aStart: i, aEnd: i, bStart: j, bEnd: j };
    if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) open.bEnd = ++j;
    else open.aEnd = ++i;
  }
  if (open) out.push(open);
  return out;
}

/** Position in the other side for base position p, counting the hunks that end at or before p. */
const shift = (hs: Hunk[], p: number) => p + hs.filter((h) => h.aEnd <= p).reduce((s, h) => s + (h.bEnd - h.bStart) - (h.aEnd - h.aStart), 0);

export function patchYaml(text: string, change: (doc: YAML.Document) => void): string {
  const base = YAML.parseDocument(text).toString(OPTS).split("\n");
  const doc = YAML.parseDocument(text);
  change(doc);
  const changed = doc.toString(OPTS);
  const orig = text.split("\n");
  const next = changed.split("\n");
  const fmt = hunks(base, orig); // base → the file as written
  const sem = hunks(base, next); // base → the changed document
  const all = [...fmt.map((h) => ({ ...h, side: "fmt" })), ...sem.map((h) => ({ ...h, side: "sem" }))].sort((x, y) => x.aStart - y.aStart || x.aEnd - y.aEnd);
  const out: string[] = [];
  let pos = 0;
  for (let k = 0; k < all.length; ) {
    // a cluster: hunks of either side that overlap (or insert at the same point)
    const start = all[k]!.aStart;
    let end = all[k]!.aEnd;
    let semantic = false;
    while (k < all.length && (all[k]!.aStart < end || all[k]!.aStart === start)) {
      end = Math.max(end, all[k]!.aEnd);
      semantic ||= all[k]!.side === "sem";
      k++;
    }
    out.push(...orig.slice(shift(fmt, pos), shift(fmt, pos) + (start - pos)));
    // formatting only: the lines as written; anything changed: the changed lines
    const [lines, hs] = semantic ? [next, sem] : [orig, fmt];
    const before = hs.filter((h) => h.aEnd <= start && !(h.aStart === start && h.aEnd === start));
    const from = start + before.reduce((s, h) => s + (h.bEnd - h.bStart) - (h.aEnd - h.aStart), 0);
    out.push(...lines.slice(from, shift(hs, end)));
    pos = end;
  }
  out.push(...orig.slice(shift(fmt, pos)));
  const merged = out.join("\n");
  try {
    if (isDeepStrictEqual(YAML.parse(merged), YAML.parse(changed))) return merged;
  } catch {}
  return changed;
}
