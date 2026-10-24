import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../src/commands/index.ts";
import { notice, withNotices } from "../../src/core/notice.ts";
import { prepare, startUi, type RunEvent, type UiServer } from "../../src/ui/server.ts";

const cli = (...args: string[]) => {
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../src/cli.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`fornax ${args.join(" ")}: ${r.stderr.toString()}`);
};

const dir = join(mkdtempSync(join(tmpdir(), "fornax-ui-")), "fleet");
let ui: UiServer;
let base: string;
let cookie: string;

beforeAll(async () => {
  cli("init", dir, "--fleet-name", "t");
  cli("server", "add", "t-1", "--host", "203.0.113.10", "--fleet", dir);
  ui = startUi({ cwd: dir, fleetDir: dir });
  base = `http://127.0.0.1:${ui.port}`;
  const res = await fetch(ui.url, { redirect: "manual" });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});
afterAll(() => ui.stop());

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers: { cookie, ...headers }, redirect: "manual" });
const post = (body: unknown, headers: Record<string, string> = { "x-fornax": "1" }) =>
  fetch(`${base}/api/run`, { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const events = async (res: Response) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as RunEvent);

describe("fornax ui: access", () => {
  test("binds to 127.0.0.1 with a long random token", () => {
    expect(ui.url).toStartWith(`http://127.0.0.1:${ui.port}/?token=`);
    expect(Buffer.from(ui.token, "base64url").length).toBeGreaterThanOrEqual(16);
  });

  test("the token is exchanged for an HttpOnly SameSite=Strict cookie and leaves the URL", async () => {
    const res = await fetch(ui.url, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("set-cookie")).toContain("SameSite=Strict");
  });

  test("no token, no answer", async () => {
    expect((await fetch(`${base}/api/fleet`)).status).toBe(401);
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/app.js`)).status).toBe(401);
    expect((await fetch(`${base}/?token=wrong`, { redirect: "manual" })).status).toBe(401);
    expect((await get("/api/fleet", { cookie: `fornax_ui_${ui.port}=wrong` })).status).toBe(401);
  });

  test("a bearer token works too", async () => {
    expect((await fetch(`${base}/api/fleet`, { headers: { authorization: `Bearer ${ui.token}` } })).status).toBe(200);
  });

  test("another Host is refused, even with the token (DNS rebinding)", async () => {
    const res = await get("/api/fleet", { host: `evil.example.com:${ui.port}` });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("wrong_host");
    expect((await get("/api/fleet", { host: `localhost:${ui.port}` })).status).toBe(200);
  });

  test("POST needs the X-Fornax header and a same origin (CSRF)", async () => {
    const run = { command: "site list" };
    expect((await post(run, {})).status).toBe(403);
    expect((await post(run, { "x-fornax": "1", origin: "https://evil.example.com" })).status).toBe(403);
    expect((await post(run)).status).toBe(200);
  });

  test("the page sends a strict CSP and needs nothing from outside", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const page = await res.text();
    expect(page).not.toMatch(/https?:\/\//);
  });
});

describe("fornax ui: commands", () => {
  test("the overview comes from the fleet config", async () => {
    const res = await get("/api/fleet");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fleet: string; servers: Array<{ server: string; host: string; sites: number }> };
    expect(body.fleet).toBe("t");
    expect(body.servers).toEqual([expect.objectContaining({ server: "t-1", host: "203.0.113.10", sites: 0 })]);
  });

  test("actions carry their tier; destroy-tier commands are not offered", async () => {
    const body = (await (await get("/api/actions")).json()) as { actions: Array<{ name: string; tier: string }> };
    expect(body.actions.find((a) => a.name === "apply")?.tier).toBe("write");
    expect(body.actions.find((a) => a.name === "plan")?.tier).toBe("read");
    expect(body.actions.some((a) => a.tier === "destroy")).toBe(false);
  });

  test("site add runs through the registry and edits the fleet", async () => {
    const ev = await events(await post({ command: "site add", args: ["t-1", "shop.example.com"], options: { repo: "acme/shop", db: "postgres", schedule: true, daemon: ["php artisan horizon"] } }));
    const result = ev.find((e) => e.t === "result") as Extract<RunEvent, { t: "result" }>;
    expect(result.exitCode).toBe(0);
    expect(result.human).toContain("next: fornax plan t-1 --site shop.example.com");
    expect(readFileSync(join(dir, "servers", "t-1.yaml"), "utf8")).toContain("shop.example.com");
    const fleet = (await (await get("/api/fleet")).json()) as { sites: Array<{ site: string }> };
    expect(fleet.sites.map((s) => s.site)).toEqual(["shop.example.com"]);
  });

  test("a failing command streams its FornaxError", async () => {
    const ev = await events(await post({ command: "logs", args: ["nope.example.com"] }));
    const err = ev.find((e) => e.t === "error") as Extract<RunEvent, { t: "error" }>;
    expect(err.error.code).toBe("unknown_site");
    expect(err.error.next).toBe("fornax site list");
  });

  test("CLI validation errors come back as JSON before anything runs", async () => {
    const res = await post({ command: "site add", args: [] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("missing_argument");
  });

  test("only allowed commands and options", () => {
    expect(() => prepare({ command: "site remove", args: ["shop.example.com"] })).toThrow(/cannot be run from fornax ui/);
    expect(() => prepare({ command: "server destroy", args: ["t-1"] })).toThrow(/cannot be run from fornax ui/);
    expect(() => prepare({ command: "apply", args: ["abc"], options: { confirm: "t-1" } })).toThrow(/--confirm/);
    expect(() => prepare({ command: "plan", args: ["t-1"], options: { fleet: "/elsewhere" } })).toThrow(/--fleet/);
    // arguments never turn into options
    expect(prepare({ command: "logs", args: ["--grep=x"] }).input.site).toBe("--grep=x");
  });
});

describe("fornax ui: lifetime", () => {
  test("stops by itself when idle", async () => {
    const short = startUi({ cwd: dir, fleetDir: dir, idleMs: 100 });
    expect(await short.closed).toBe("idle");
  });
});

describe("fornax ui: stylesheet", () => {
  // style.css is generated (Tailwind) and committed, so a checkout runs without a build step
  test("is up to date with index.html and app.js — else: bun run ui:css", () => {
    const root = join(import.meta.dir, "../..");
    const out = join(mkdtempSync(join(tmpdir(), "fornax-ui-css-")), "style.css");
    const r = Bun.spawnSync([process.execPath, "x", "tailwindcss", "-i", "src/ui/input.css", "-o", out, "--minify"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(out, "utf8") === readFileSync(join(root, "src/ui/style.css"), "utf8")).toBe(true);
  });
});

describe("notices", () => {
  test("go to the run that caused them, across awaits and child processes", async () => {
    const lines: string[] = [];
    await withNotices(
      (l) => lines.push(l),
      async () => {
        await Bun.spawn(["true"]).exited;
        notice("touch your security key (SSH to t-1)");
      },
    );
    expect(lines).toEqual(["touch your security key (SSH to t-1)"]);
  });
});
