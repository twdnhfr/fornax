/**
 * Versions of the fleet config. `fornax.yaml` carries `version: <n>`; a fleet without it is from
 * before 1.0 (version 0). Older configs load (upgraded in memory, with a note) and
 * `fornax fleet upgrade` writes the upgrade; a config newer than this fornax is refused.
 *
 * A breaking change to the config adds one step here — never an in-place change of meaning.
 */
import YAML from "yaml";

export const CONFIG_VERSION = 2;

/** Rename a key in place (same position, comments kept). */
function renameKey(map: YAML.YAMLMap, from: string, to: string): YAML.Pair | undefined {
  const pair = map.items.find((p) => YAML.isScalar(p.key) && p.key.value === from);
  if (pair) (pair.key as YAML.Scalar).value = to;
  return pair;
}

const asMap = (v: unknown) => (YAML.isMap(v) ? v : undefined);

export interface Upgrade {
  /** The version this step produces. */
  to: number;
  /** One line for `fornax fleet upgrade`. */
  summary: string;
  fleet?: (doc: YAML.Document) => void;
  server?: (doc: YAML.Document) => void;
}

export const UPGRADES: Upgrade[] = [
  {
    to: 1,
    summary: "version 1: the first stable config (fornax.yaml gets `version: 1`)",
  },
  {
    to: 2,
    summary: "version 2: webhook: {domain, port} (was hook_domain, hook_port), deploy.keep_releases (was keep_releases), notify.webhook (was notify.url)",
    fleet(doc) {
      const notify = asMap(doc.get("notify"));
      if (notify) renameKey(notify, "url", "webhook");
    },
    server(doc) {
      const root = asMap(doc.contents);
      if (!root) return;
      const domain = root.get("hook_domain");
      const port = root.get("hook_port");
      if (domain !== undefined || port !== undefined) {
        const webhook = doc.createNode({ ...(domain !== undefined ? { domain } : {}), ...(port !== undefined ? { port } : {}) });
        const pair = renameKey(root, domain !== undefined ? "hook_domain" : "hook_port", "webhook");
        pair!.value = webhook;
        if (domain !== undefined) root.delete("hook_port");
      }
      for (const site of asMap(root.get("sites"))?.items ?? []) {
        const s = asMap(site.value);
        const keep = s?.get("keep_releases");
        if (!s || keep === undefined) continue;
        const deploy = asMap(s.get("deploy"));
        if (deploy) {
          deploy.set("keep_releases", keep);
          s.delete("keep_releases");
        } else {
          renameKey(s, "keep_releases", "deploy")!.value = doc.createNode({ keep_releases: keep });
        }
      }
    },
  },
];

/** The upgrade steps from `from` to the current version, in order. */
export const upgradesFrom = (from: number) => UPGRADES.filter((u) => u.to > from && u.to <= CONFIG_VERSION).sort((a, b) => a.to - b.to);
