/**
 * docs/config.md, generated from the schema so it cannot drift: structure, types and defaults
 * from z.toJSONSchema, descriptions from the doc comments in src/core/schema.ts (read from the
 * source — JSON Schema does not carry them). `bun run docs` writes it; a unit test fails when the
 * committed file is out of date.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { CONFIG_VERSION } from "../src/core/config-version.ts";
import { CronSchema, DaemonSchema, FileSchema, FleetSchema, ServerSchema, SiteSchema } from "../src/core/schema.ts";

const ROOT = join(import.meta.dir, "..");
export const SCHEMA_FILE = join(ROOT, "src/core/schema.ts");
export const REFERENCE_FILE = join(ROOT, "docs/config.md");

// Schemas used in more than one place: their keys' comments are found under the schema's own name.
const NAMED = new Map<z.ZodType, string>([
  [FleetSchema, "FleetSchema"],
  [ServerSchema, "ServerSchema"],
  [SiteSchema, "SiteSchema"],
  [DaemonSchema, "DaemonSchema"],
  [CronSchema, "CronSchema"],
  [FileSchema, "FileSchema"],
]);

/** What the keys of a map stand for, by the map's path. */
const MAP_KEYS: Record<string, string> = { sites: "<domain>", "ssh.options": "<option>", provider_credentials: "<provider>" };

export interface DocComments {
  /** Comments above object keys, by "<SchemaName>.<key>.<key>…" (array and map levels left out). */
  keys: Map<string, string>;
  /** Comments above `const` declarations, by name. */
  consts: Map<string, string>;
  /** Doc comments above neither a key nor a declaration ("line N: …"). */
  orphans: string[];
}

const cleanComment = (c: string) =>
  c
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*?\s?/, "").trim())
    .filter(Boolean)
    .join(" ");

/**
 * The doc comments of a schema source, each tied to the key below it. A small scanner, enough for
 * schema.ts: it skips strings, regex literals and comments, and keeps a stack of brackets in which
 * every `{` remembers the key path it is the value of.
 */
export function docComments(source: string): DocComments {
  const out: DocComments = { keys: new Map(), consts: new Map(), orphans: [] };
  type Frame = { ch: "{" | "(" | "["; path?: string[]; key?: string };
  const stack: Frame[] = [];
  let constName = "";
  let prev = ""; // last significant character, for telling keys and regex literals apart
  const objectTop = () => {
    const top = stack.at(-1);
    return top?.ch === "{" && (prev === "{" || prev === ",") ? top : undefined;
  };
  const lineOf = (at: number) => source.slice(0, at).split("\n").length;

  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const rest = () => source.slice(i);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (source.startsWith("//", i)) {
      i = source.indexOf("\n", i) === -1 ? source.length : source.indexOf("\n", i);
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.includes("*/", i + 2) ? source.indexOf("*/", i + 2) + 2 : source.length;
      const text = source.slice(i, end);
      i = end;
      if (!text.startsWith("/**")) continue;
      const doc = cleanComment(text);
      const key = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(source.slice(i));
      const decl = /^\s*(?:export\s+)?const\s+([\w$]+)/.exec(source.slice(i));
      const top = objectTop();
      if (key && top) out.keys.set([...top.path!, key[1]!].join("."), doc);
      else if (decl && stack.length === 0) out.consts.set(decl[1]!, doc);
      else out.orphans.push(`line ${lineOf(i - text.length)}: ${doc.slice(0, 60)}`);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};".includes(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") j++;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j++;
      }
      i = j + 1;
      while (/[a-z]/.test(source[i] ?? "")) i++;
      prev = "/";
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest());
    if (word) {
      const top = objectTop();
      if (top && /^\s*:/.test(source.slice(i + word[0].length))) top.key = word[0];
      if (word[0] === "const" && stack.length === 0) constName = /^const\s+([\w$]+)/.exec(rest())?.[1] ?? "";
      i += word[0].length;
      prev = "a";
      continue;
    }
    if (c === "{") {
      const outer = stack.findLast((f) => f.ch === "{");
      stack.push({ ch: "{", path: outer ? [...outer.path!, ...(outer.key ? [outer.key] : [])] : [constName] });
    } else if (c === "(" || c === "[") stack.push({ ch: c });
    else if (c === "}" || c === ")" || c === "]") stack.pop();
    prev = c;
    i++;
  }
  return out;
}

type Json = Record<string, any>;

/** The JSON Schema of a config schema, plus x-root (named schemas) and x-format (what a value must look like). */
function jsonSchema(schema: z.ZodType): Json {
  return z.toJSONSchema(schema, {
    io: "input",
    override(ctx) {
      const name = NAMED.get(ctx.zodSchema as unknown as z.ZodType);
      if (name) ctx.jsonSchema["x-root"] = name;
      const notes: string[] = [];
      for (const check of ((ctx.zodSchema as any)._zod.def.checks ?? []) as any[]) {
        const def = check._zod.def;
        const message = typeof def.error === "function" ? def.error({}) : undefined;
        const note = typeof message === "string" ? message : def.format === "starts_with" ? `starting with \`${def.prefix}\`` : undefined;
        if (note && !notes.includes(note)) notes.push(note);
      }
      if (notes.length) ctx.jsonSchema["x-format"] = notes.join("; ");
    },
  }) as Json;
}

const SAFE = Number.MAX_SAFE_INTEGER;
const code = (v: unknown) => `\`${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : JSON.stringify(v)}\``;
const isObject = (n: Json) => n.type === "object" && n.properties !== undefined;
const isMap = (n: Json) => n.type === "object" && n.properties === undefined && typeof n.additionalProperties === "object";

/** "string (…)" → "strings (…)", for the items of a list. */
const plural = (t: string) => t.replace(/^(string|whole number|number|boolean|URL)\b/, "$1s");

/** A value's type in words; `mapKey` names the keys of a map. */
function typeOf(n: Json, mapKey = "<name>"): string {
  if (n.anyOf) return (n.anyOf as Json[]).map((o) => typeOf(o)).join(" or ");
  if (n.enum) return `one of ${(n.enum as unknown[]).map(code).join(", ")}`;
  if ("const" in n) return code(n.const);
  if (Array.isArray(n.type)) return n.type.join(" or ");
  switch (n.type) {
    case "string": {
      if (n.format === "uri") return "URL";
      if (n["x-format"]) return `string (${n["x-format"]})`;
      return n.pattern ? `string matching \`${n.pattern}\`` : "string";
    }
    case "integer":
    case "number": {
      const min = typeof n.minimum === "number" && n.minimum > -SAFE ? n.minimum : undefined;
      const max = typeof n.maximum === "number" && n.maximum < SAFE ? n.maximum : undefined;
      const base = n.type === "integer" ? "whole number" : "number";
      if (min !== undefined && max !== undefined) return `${base} from ${min} to ${max}`;
      if (min !== undefined) return `${base}, at least ${min}`;
      return max !== undefined ? `${base}, at most ${max}` : base;
    }
    case "array": {
      const items = n.items as Json;
      const of = isObject(items) ? "list of objects" : typeOf(items).startsWith("one of") ? `list, each ${typeOf(items)}` : `list of ${plural(typeOf(items))}`;
      return n.minItems ? `${of}, at least ${n.minItems} ${n.minItems === 1 ? "entry" : "entries"}` : of;
    }
    case "object": {
      if (!isMap(n)) return "object";
      const value = n.additionalProperties as Json;
      return `map of \`${mapKey}\` to ${value["x-root"] === "SiteSchema" ? "site entries" : isObject(value) ? "objects" : plural(typeOf(value))}`;
    }
    default:
      return String(n.type ?? "any");
  }
}

interface Entry {
  path: string;
  type: string;
  presence: string;
  doc?: string;
}

interface Walk {
  comments: DocComments;
  used: Set<string>;
  entries: Entry[];
  /** Named schemas not to descend into (documented in a section of their own), with a pointer there. */
  stop: Map<string, string>;
}

function walk(node: Json, path: string, docPath: string[], w: Walk): void {
  const required = new Set<string>(node.required ?? []);
  for (const [key, child] of Object.entries(node.properties as Record<string, Json>)) {
    const at = path ? `${path}.${key}` : key;
    const docKey = [...docPath, key].join(".");
    let doc = w.comments.keys.get(docKey);
    if (doc !== undefined) w.used.add(docKey);
    // what the key holds: an object itself, or the objects of a list or a map
    const [inner, innerPath] =
      child.type === "array" && isObject(child.items) ? [child.items as Json, `${at}[]`] : isMap(child) && isObject(child.additionalProperties) ? [child.additionalProperties as Json, `${at}.${MAP_KEYS[at] ?? "<name>"}`] : [child, at];
    const root = inner["x-root"] as string | undefined;
    doc ??= root ? (w.comments.consts.get(root) ?? w.stop.get(root)) : undefined;
    // an object-level rule (e.g. "exactly one of source or content") would otherwise show nowhere
    const rule = isObject(inner) ? (inner["x-format"] as string | undefined) : undefined;
    if (rule) doc = [doc, `${rule[0]!.toUpperCase()}${rule.slice(1)}.`].filter(Boolean).join(" ");
    const presence = "default" in child && !isObject(child) ? `default ${code(child.default)}` : required.has(key) ? "required" : "optional";
    w.entries.push({ path: at, type: typeOf(child, MAP_KEYS[at]), presence, doc });
    if (isObject(inner) && !(root && w.stop.has(root))) walk(inner, innerPath, root ? [root] : [...docPath, key], w);
  }
}

/** `<` starts an HTML tag in Markdown: escape it outside code spans. */
const escape = (s: string) =>
  s
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replaceAll("<", "&lt;")))
    .join("");

function section(entries: Entry[]): string {
  return entries.map((e) => `### \`${e.path}\`\n\n${escape(e.type)} · ${e.presence}\n${e.doc ? `\n${escape(e.doc)}\n` : ""}`).join("\n");
}

const INTRO = `# Configuration reference

<!-- Generated from src/core/schema.ts by \`bun run docs\`. Do not edit by hand. -->

A fleet is a git repo: \`fornax.yaml\` at its top, one \`servers/<name>.yaml\` per server, and in each server file the server's sites under \`sites:\`. Every key of all three is listed here, in the order the schema defines them.

Unknown keys are errors, not ignored: a typo fails \`fornax plan\` instead of silently doing nothing. "required" means required whenever the object around the key is there; "optional" without a default means the key may be left out. \`[]\` in a path stands for each entry of a list, \`<domain>\` and the like for each key of a map.

## Secret references

Fields that take a secret (tokens, passwords, the fleet's SSH key) hold a reference to it, never the secret itself. fornax resolves it only when it needs the value:

| Reference | Resolves to |
| --- | --- |
| \`op://Vault/Item/field\` | a 1Password field, through the 1Password CLI or the fleet's service account |
| \`env:NAME\` | the environment variable \`NAME\` |
| \`file:path\` | the contents of a file; a relative path is relative to the fleet dir |
| \`keychain:service\` | a macOS Keychain generic password (\`keychain:service/account\` names the account too) |

See [Secrets](secrets.md) for the fleet's own 1Password vault.

## Config version

\`fornax.yaml\` carries \`version:\`, the version of the config format; \`fornax init\` writes the current one, ${CONFIG_VERSION}. Server files have no version of their own: they follow \`fornax.yaml\`. A fleet with an older version still loads — upgraded in memory, with a note on stderr — and \`fornax fleet upgrade\` writes the upgrade into the fleet repo (comments and layout kept; review it with \`git diff\`). A version newer than the running fornax is refused.
`;

export interface Reference {
  markdown: string;
  /** Keys without a description of their own. */
  undocumented: string[];
  /** Doc comments in schema.ts that belong to no key of the reference. */
  unmatched: string[];
}

export function renderReference(source = readFileSync(SCHEMA_FILE, "utf8")): Reference {
  const comments = docComments(source);
  const used = new Set<string>();
  const part = (schema: z.ZodType, path: string, stop: Record<string, string> = {}) => {
    const w: Walk = { comments, used, entries: [], stop: new Map(Object.entries(stop)) };
    walk(jsonSchema(schema), path, [NAMED.get(schema)!], w);
    return w.entries;
  };
  const fleet = part(FleetSchema, "");
  const server = part(ServerSchema, "", { SiteSchema: "The server's sites, by domain: see [Site entries](#site-entries)." });
  const site = part(SiteSchema, "sites.<domain>");
  const all = [...fleet, ...server, ...site];

  const markdown = [
    INTRO,
    "## `fornax.yaml`\n\nThe fleet: settings for all of its servers.\n",
    section(fleet),
    "## `servers/<name>.yaml`\n\nOne server; the file name is the server's name.\n",
    section(server),
    "## Site entries\n\nEach key under `sites:` in a server file is a site's domain; its value is the site.\n",
    section(site),
  ].join("\n");
  return {
    markdown,
    undocumented: all.filter((e) => !e.doc).map((e) => e.path),
    unmatched: [...[...comments.keys.keys()].filter((k) => !used.has(k)), ...comments.orphans],
  };
}

if (import.meta.main) {
  const ref = renderReference();
  if (ref.unmatched.length) {
    console.error(`doc comments that match no key of the schema:\n  ${ref.unmatched.join("\n  ")}`);
    process.exit(1);
  }
  writeFileSync(REFERENCE_FILE, ref.markdown);
  console.log(`wrote ${relative(ROOT, REFERENCE_FILE)}`);
  if (ref.undocumented.length) console.log(`${ref.undocumented.length} keys without a description (add a /** */ comment in src/core/schema.ts):\n  ${ref.undocumented.join("\n  ")}`);
}
