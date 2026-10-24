import { describe, expect, test } from "bun:test";
import { handleHook, type HookDeps } from "../../src/remote/hook.ts";
import { signature } from "../../src/remote/release.ts";
import { repoUrl, type SiteRuntime } from "../../src/core/runtime.ts";
import { GitHub, sameKey } from "../../src/githost/github.ts";

const rt = { domain: "shop.example.com", branch: "main", github_repo: "acme/shop" } as SiteRuntime;

function deps(started: Array<[string, string | undefined]>): HookDeps {
  return {
    secretFor: (d) => (d === "shop.example.com" ? "s3cret" : null),
    runtimeFor: (d) => (d === "shop.example.com" ? rt : null),
    start: (d, sha) => {
      started.push([d, sha]);
      return true;
    },
  };
}

const push = (body: object, secret = "s3cret", event = "push") => {
  const text = JSON.stringify(body);
  return new Request("http://127.0.0.1/fornax/hook/shop.example.com", {
    method: "POST",
    body: text,
    headers: { "x-github-event": event, "x-hub-signature-256": signature(secret, text) },
  });
};

const sha = "a".repeat(40);

describe("webhook", () => {
  test("valid push on the branch starts a deploy of that commit", async () => {
    const started: Array<[string, string | undefined]> = [];
    const res = await handleHook(push({ ref: "refs/heads/main", after: sha, repository: { full_name: "acme/shop" } }), deps(started));
    expect(res.status).toBe(202);
    expect(started).toEqual([["shop.example.com", sha]]);
  });
  test("wrong signature is rejected", async () => {
    const started: Array<[string, string | undefined]> = [];
    const res = await handleHook(push({ ref: "refs/heads/main", after: sha }, "wrong"), deps(started));
    expect(res.status).toBe(401);
    expect(started).toEqual([]);
  });
  test("other branches and events are ignored", async () => {
    const started: Array<[string, string | undefined]> = [];
    expect((await handleHook(push({ ref: "refs/heads/feature", after: sha }), deps(started))).status).toBe(202);
    expect((await handleHook(push({ zen: "x" }, "s3cret", "ping"), deps(started))).status).toBe(200);
    expect(started).toEqual([]);
  });
  test("a push from another repo is refused", async () => {
    const started: Array<[string, string | undefined]> = [];
    const res = await handleHook(push({ ref: "refs/heads/main", after: sha, repository: { full_name: "evil/shop" } }), deps(started));
    expect(res.status).toBe(403);
    expect(started).toEqual([]);
  });
  test("unknown sites are 404", async () => {
    const res = await handleHook(new Request("http://127.0.0.1/fornax/hook/other.example.com", { method: "POST", body: "{}" }), deps([]));
    expect(res.status).toBe(404);
  });
});

describe("repo urls", () => {
  test("GitHub shorthand becomes ssh with deploy key", () => {
    expect(repoUrl("acme/shop")).toEqual({ url: "git@github.com:acme/shop.git", github: "acme/shop", ssh: true });
    expect(repoUrl("https://github.com/acme/shop.git").github).toBe("acme/shop");
    expect(repoUrl("file:///srv/git/shop.git")).toEqual({ url: "file:///srv/git/shop.git", github: null, ssh: false });
    expect(repoUrl("git@gitlab.com:acme/shop.git").ssh).toBe(true);
  });
});

describe("GitHub client (fake API)", () => {
  test("adds key and hook once, updates the hook afterwards", async () => {
    const keys: Array<{ id: number; key: string; title: string; read_only: boolean }> = [];
    const hooks: Array<{ id: number; config: { url: string; secret: string } }> = [];
    const calls: string[] = [];
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        calls.push(`${req.method} ${u.pathname}`);
        if (req.headers.get("authorization") !== "Bearer t0ken") return new Response("no", { status: 401 });
        const body = (req.method === "GET" ? null : await req.json()) as any;
        if (u.pathname === "/repos/acme/shop/keys" && req.method === "GET") return Response.json(keys);
        if (u.pathname === "/repos/acme/shop/keys") {
          keys.push({ id: keys.length + 1, ...body });
          return Response.json({ id: keys.length }, { status: 201 });
        }
        if (u.pathname === "/repos/acme/shop/hooks" && req.method === "GET") return Response.json(hooks);
        if (u.pathname === "/repos/acme/shop/hooks") {
          hooks.push({ id: hooks.length + 1, config: body.config });
          return Response.json({ id: hooks.length }, { status: 201 });
        }
        if (u.pathname.startsWith("/repos/acme/shop/hooks/") && req.method === "PATCH") return Response.json({ id: 1 });
        return new Response("nope", { status: 404 });
      },
    });
    const gh = new GitHub("t0ken", `http://127.0.0.1:${srv.port}`);
    const pub = "ssh-ed25519 AAAAC3Nza fornax deploy shop.example.com";
    await gh.addKey("acme/shop", "fornax", pub);
    expect(keys[0]!.read_only).toBe(true);
    expect((await gh.listKeys("acme/shop")).some((k) => sameKey(k.key, "ssh-ed25519 AAAAC3Nza other-comment"))).toBe(true);
    await gh.addHook("acme/shop", "https://hook.example.com/fornax/hook/shop.example.com", "s");
    const hook = (await gh.listHooks("acme/shop")).find((h) => h.config.url?.endsWith("/shop.example.com"));
    expect(hook).toBeDefined();
    await gh.updateHook("acme/shop", hook!.id, hook!.config.url!, "s2");
    expect(calls).toContain("PATCH /repos/acme/shop/hooks/1");
    await expect(new GitHub("bad", `http://127.0.0.1:${srv.port}`).listKeys("acme/shop")).rejects.toThrow(/HTTP 401/);
    srv.stop();
  });
});

describe("fornax on the server", async () => {
  const { binaryProbe } = await import("../../src/modules/deploy.ts");
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /** A stand-in for the server's binary that reports `build`; the probe's output for this build. */
  const probe = (serverBuild: string | null, ours: string | undefined) => {
    const bin = join(mkdtempSync(join(tmpdir(), "fornax-bin-")), "fornax");
    writeFileSync(bin, `#!/bin/sh\necho '${JSON.stringify({ version: "1.0.0", build: serverBuild })}'\n`);
    chmodSync(bin, 0o755);
    return Bun.spawnSync(["sh", "-c", binaryProbe("ours-sha", ours, bin)]).stdout.toString().trim();
  };
  test("apply never downgrades: a newer build on the server counts as in sync", () => {
    expect(probe("2026-11-02T10:00:00Z", "2026-11-01T10:00:00Z")).toBe("ours-sha");
  });
  test("an older, equal or unstamped build on the server is replaced", () => {
    expect(probe("2026-10-01T10:00:00Z", "2026-11-01T10:00:00Z")).toMatch(/^[0-9a-f]{64}$/);
    expect(probe("2026-11-01T10:00:00Z", "2026-11-01T10:00:00Z")).toMatch(/^[0-9a-f]{64}$/);
    expect(probe(null, "2026-11-01T10:00:00Z")).toMatch(/^[0-9a-f]{64}$/);
  });
  test("an unstamped build of ours compares by checksum only", () => {
    expect(probe("2026-11-02T10:00:00Z", undefined)).toMatch(/^[0-9a-f]{64}$/);
  });
});
