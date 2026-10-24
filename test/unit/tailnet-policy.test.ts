import { describe, expect, test } from "bun:test";
import { desiredPolicy, parseHujson, policyText } from "../../src/core/tailnet-policy.ts";

const machines = new Map([
  ["web-1", "100.64.0.3"],
  ["ai-box", "100.64.0.10"],
  ["dns-pi", "100.64.0.1"],
]);
const current = parseHujson(`{
  // mine
  "acls": [{"action": "accept", "src": ["*"], "dst": ["*:*"]},],
  "ssh": [],
  "nodeAttrs": [{"target": ["autogroup:member"], "attr": ["funnel"]}],
  "tagOwners": {"tag:other": ["autogroup:admin"]},
}`);

describe("tailnet policy", () => {
  const p = desiredPolicy({ current, serverTag: "tag:server", homeTag: "tag:home", home: ["ai-box"], allow: [{ from: "web-1", to: "ai-box", ports: [8000], why: "OCR" }], machines, nameservers: ["100.64.0.1", "1.1.1.1"] });

  test("servers reach only the tailnet's DNS servers and what is allowed; nothing for everyone any more", () => {
    expect(p.acls).toEqual([
      { action: "accept", src: ["autogroup:member"], dst: ["*:*"] },
      { action: "accept", src: ["tag:home"], dst: ["*:*"] },
      { action: "accept", src: ["tag:server"], dst: ["100.64.0.1:53"] },
      { action: "accept", src: ["web-1"], dst: ["ai-box:8000"] },
    ]);
    expect(p.hosts).toEqual({ "web-1": "100.64.0.3", "ai-box": "100.64.0.10" });
  });

  test("SSH: own devices everywhere, home machines to servers, servers nowhere", () => {
    const ssh = p.ssh as Array<{ src: string[]; dst: string[] }>;
    expect(ssh.map((r) => `${r.src[0]} → ${r.dst[0]}`)).toEqual(["autogroup:member → autogroup:self", "autogroup:member → tag:server", "autogroup:member → tag:home", "tag:home → tag:server"]);
    expect(ssh.some((r) => r.src.includes("tag:server"))).toBe(false);
  });

  test("what fornax does not own stays; its tags join the existing owners", () => {
    expect(p.nodeAttrs).toEqual([{ target: ["autogroup:member"], attr: ["funnel"] }]);
    expect(p.tagOwners).toEqual({ "tag:other": ["autogroup:admin"], "tag:server": ["autogroup:admin"], "tag:home": ["autogroup:admin"] });
  });

  test("an allow rule to a machine the tailnet does not have is an error, not a silent rule", () => {
    expect(() => desiredPolicy({ current, serverTag: "tag:server", homeTag: "tag:home", home: [], allow: [{ from: "web-1", to: "gone", ports: [1], why: "x" }], machines, nameservers: [] })).toThrow(/no machine "gone"/);
  });

  test("the written text parses back to the same policy (comments, a URL with // inside a string)", () => {
    const withUrl = { ...p, note: "see https://example.com/x" };
    expect(parseHujson(policyText(withUrl, "t"))).toEqual(withUrl);
  });
});

describe("SSH check", () => {
  test("your devices need a fresh login for servers and home machines; home machines (agents) do not", () => {
    const p = desiredPolicy({ current, serverTag: "tag:server", homeTag: "tag:home", home: ["ai-box"], allow: [], machines, nameservers: [], sshCheck: "12h" });
    const ssh = p.ssh as Array<{ action: string; checkPeriod?: string; src: string[]; dst: string[] }>;
    expect(ssh.map((r) => `${r.src[0]} → ${r.dst[0]}: ${r.action}${r.checkPeriod ? ` ${r.checkPeriod}` : ""}`)).toEqual([
      "autogroup:member → autogroup:self: accept",
      "autogroup:member → tag:server: check 12h",
      "autogroup:member → tag:home: check 12h",
      "tag:home → tag:server: accept",
    ]);
  });
});
