import { afterAll, describe, expect, test } from "bun:test";
import type { SiteRuntime } from "../../src/core/runtime.ts";
import { notify, type ReleaseResult } from "../../src/remote/release.ts";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const got: Array<{ headers: Record<string, string>; body: string }> = [];
let refuseMail = false;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    got.push({ headers: Object.fromEntries(req.headers), body: await req.text() });
    // like ntfy.sh without an account
    if (refuseMail && req.headers.get("email")) return Response.json({ code: 40053, error: "invalid request: anonymous email sending is not allowed" }, { status: 400 });
    return new Response("{}");
  },
});
afterAll(() => server.stop());

const rt = (on: "failure" | "always") =>
  ({ domain: "shop.example.com", notify: { url: null, github_status: false, ntfy: { url: `http://127.0.0.1:${server.port}/deploys`, email: "ops@example.com" }, on } }) as unknown as SiteRuntime;
const result = (status: ReleaseResult["status"], error?: string): ReleaseResult => ({
  site: "shop.example.com", status, release: "20261023120000", previous: null, sha: "3f2a9c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c",
  started: "", finished: "", seconds: 12.3, log: "/home/shop/.fornax/deploys/x.log", source: "webhook", ...(error ? { error } : {}),
});

describe("deploy notifications via ntfy", () => {
  test("a failed deploy is pushed with high priority and forwarded as mail", async () => {
    got.length = 0;
    await notify(rt("failure"), result("failed", "command failed (exit 1): bun run build"), () => {});
    expect(got).toHaveLength(1);
    expect(got[0]!.headers.title).toBe("shop.example.com: deploy FAILED");
    expect(got[0]!.headers.priority).toBe("high");
    expect(got[0]!.headers.email).toBe("ops@example.com");
    expect(got[0]!.body).toContain("bun run build");
    expect(got[0]!.body).toContain("3f2a9c1d4e5b");
  });

  test("successful deploys stay quiet unless notify.on is always", async () => {
    got.length = 0;
    await notify(rt("failure"), result("success"), () => {});
    expect(got).toHaveLength(0);
    await notify(rt("always"), result("success"), () => {});
    expect(got[0]!.headers.title).toBe("shop.example.com: deployed");
  });

  test("when ntfy refuses the mail, the push still goes out", async () => {
    got.length = 0;
    refuseMail = true;
    const lines: string[] = [];
    await notify(rt("failure"), result("failed", "boom"), (l) => lines.push(l));
    refuseMail = false;
    expect(got).toHaveLength(2);
    expect(got[1]!.headers.email).toBeUndefined();
    expect(lines.join("\n")).toContain("anonymous email sending is not allowed");
    expect(lines.at(-1)).toBe("=> ntfy: HTTP 200");
  });

  test("an access token from the root-only file is sent as bearer token", async () => {
    got.length = 0;
    const f = join(mkdtempSync(join(tmpdir(), "fornax-ntfy-")), "token");
    writeFileSync(f, "tk_example\n");
    const r = rt("failure");
    r.notify.ntfy!.token_file = f;
    await notify(r, result("failed"), () => {});
    expect(got[0]!.headers.authorization).toBe("Bearer tk_example");
  });

  test("an automatic rollback after a failed health check is reported", async () => {
    got.length = 0;
    await notify(rt("failure"), result("rolled_back", "health check failed"), () => {});
    expect(got[0]!.headers.title).toBe("shop.example.com: deploy failed, rolled back");
  });
});
