import { describe, expect, test } from "bun:test";
import { sshArgs } from "../../src/core/ssh.ts";
import { rootKeys } from "../../src/modules/root-access.ts";
import type { Fleet } from "../../src/core/fleet.ts";
import type { Server } from "../../src/core/schema.ts";

const fleet = (ssh: Record<string, unknown>) => ({ dir: "/fleet", config: { ssh: { user: "root", port: 22, options: {}, authorized_keys: [], ...ssh } } }) as unknown as Fleet;
const server = { server: "web-1", host: "web-1.example" } as Server;

describe("ssh arguments", () => {
  test("~/ means the home directory, other relative paths the fleet repo", () => {
    const a = sshArgs(fleet({ security_key: "~/.ssh/id_sk", known_hosts_file: "known_hosts" }), server);
    expect(a[a.indexOf("-i") + 1]).toBe(`${process.env.HOME}/.ssh/id_sk`);
    expect(a).toContain("UserKnownHostsFile=/fleet/known_hosts");
  });
  test("a security key: one reusable connection per server, no batch mode but never a password prompt", () => {
    const a = sshArgs(fleet({ security_key: "/k" }), server).join(" ");
    expect(a).toContain("ControlMaster=auto");
    expect(a).toContain("ControlPersist=10m");
    expect(sshArgs(fleet({ security_key: "/k", keep_open: "1h" }), server).join(" ")).toContain("ControlPersist=1h");
    expect(a).toContain("BatchMode=no");
    expect(a).toContain("PasswordAuthentication=no");
    expect(sshArgs(fleet({}), server).join(" ")).toContain("BatchMode=yes");
  });
});

describe("root keys", () => {
  const k = (c: string) => `ssh-ed25519 AAAA ${c}`;
  test("the server's own come on top of the fleet's; none set means only adding", () => {
    expect(rootKeys(fleet({ root_keys: [k("a")] }), { ...server, ssh: { root_keys: [k("b")] } } as Server)).toEqual([k("a"), k("b")]);
    expect(rootKeys(fleet({ root_keys: [k("a")] }), server)).toEqual([k("a")]);
    expect(rootKeys(fleet({}), server)).toBeUndefined();
  });
});
