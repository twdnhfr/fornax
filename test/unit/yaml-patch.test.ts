import { describe, expect, test } from "bun:test";
import YAML from "yaml";
import { patchYaml } from "../../src/core/yaml-patch.ts";

const text = `# a fleet server
server: web-1
host: 203.0.113.10       # aligned comment
php: [8.4, 8.5]
hook_domain: hook.example.com
hook_port: 9300
sites:
  shop.example.com:
    repo: acme/shop      # the shop
    keep_releases: 3
    notes: "a long quoted
      note over two lines"
    deploy: { enabled: true }
`;

describe("patchYaml", () => {
  test("only the changed lines change; comments, alignment and flow style stay", () => {
    const out = patchYaml(text, (doc) => {
      doc.set("webhook", doc.createNode({ domain: doc.get("hook_domain"), port: doc.get("hook_port") }));
      doc.delete("hook_domain");
      doc.delete("hook_port");
    });
    expect(YAML.parse(out).webhook).toEqual({ domain: "hook.example.com", port: 9300 });
    expect(out).toContain("host: 203.0.113.10       # aligned comment");
    expect(out).toContain("php: [8.4, 8.5]");
    expect(out).toContain('    notes: "a long quoted\n      note over two lines"');
    expect(out).not.toContain("hook_domain");
  });

  test("a key moved into a nested map", () => {
    const out = patchYaml(text, (doc) => {
      const site = doc.getIn(["sites", "shop.example.com"]) as YAML.YAMLMap;
      (site.get("deploy") as YAML.YAMLMap).set("keep_releases", site.get("keep_releases"));
      site.delete("keep_releases");
    });
    expect(YAML.parse(out).sites["shop.example.com"].deploy).toEqual({ enabled: true, keep_releases: 3 });
    expect(out).toContain("    repo: acme/shop      # the shop");
    expect(out).toContain("host: 203.0.113.10       # aligned comment");
    // the changed line comes normalized (and so does an unusually formatted neighbour in the same block)
    expect(out).toContain("    deploy: {enabled: true, keep_releases: 3}");
  });

  test("no change, no difference", () => {
    expect(patchYaml(text, () => {})).toBe(text);
  });
});
