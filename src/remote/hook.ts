/**
 * `fornax hook serve` — runs ON the server as the unprivileged user fornax-hook, behind nginx.
 * Verifies a push webhook (GitHub HMAC or the same header from any other sender),
 * records the requested commit and starts fornax-deploy@<site>. Nothing else.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { HOOK_SECRET_DIR, REQUEST_DIR, RUNTIME_DIR, type SiteRuntime } from "../core/runtime.ts";
import { signature } from "./release.ts";

export interface HookDeps {
  secretFor(domain: string): string | null;
  runtimeFor(domain: string): SiteRuntime | null;
  /** Starts the deploy; returns false if it could not be started. */
  start(domain: string, sha: string | undefined): boolean;
}

export const serverDeps: HookDeps = {
  secretFor: (d) => {
    const p = join(HOOK_SECRET_DIR, d);
    return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
  },
  runtimeFor: (d) => {
    const p = join(RUNTIME_DIR, `${d}.json`);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as SiteRuntime) : null;
  },
  start: (d, sha) => {
    writeFileSync(join(REQUEST_DIR, `${d}.json`), JSON.stringify({ sha, source: "webhook", at: new Date().toISOString() }));
    // fornax-trigger (root, via sudoers) validates the name and starts only fornax-deploy@<site>
    const p = Bun.spawnSync(["sudo", "-n", "/usr/local/sbin/fornax-trigger", d]);
    return p.exitCode === 0;
  },
};

/** GitHub sends at most 25 MB (nginx lets as much through). */
export const MAX_BODY = 25 * 1024 * 1024;
/** Bodies read at once: what unsigned junk can make the webhook hold in memory. */
export const MAX_READS = 4;
let reading = 0;

/** The body, or null once it grows past `max` — read as it arrives, so a huge one is never held whole. */
async function readBody(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const c of req.body ?? []) {
    size += c.length;
    if (size > max) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body) + "\n", { status, headers: { "content-type": "application/json" } });

export async function handleHook(req: Request, deps: HookDeps): Promise<Response> {
  const url = new URL(req.url);
  // /anvil/…: webhooks registered at GitHub before the rename keep working
  const m = url.pathname.match(/^\/(?:fornax|anvil)\/hook\/([a-z0-9.-]+)$/);
  if (req.method === "GET" && /^\/(fornax|anvil)\/health$/.test(url.pathname)) return json(200, { ok: true });
  if (!m || req.method !== "POST") return json(404, { error: "not found" });
  const domain = m[1]!;
  const secret = deps.secretFor(domain);
  const rt = deps.runtimeFor(domain);
  if (!secret || !rt) return json(404, { error: "unknown site" });

  // what cannot be signed is turned away before its body is read
  const given = req.headers.get("x-hub-signature-256") ?? "";
  if (!/^sha256=[0-9a-f]{64}$/.test(given)) return json(401, { error: "bad signature" });
  if (reading >= MAX_READS) return json(503, { error: "busy" });
  reading++;
  let body: Uint8Array | null;
  try {
    body = await readBody(req, MAX_BODY);
  } finally {
    reading--;
  }
  if (!body) return json(413, { error: "body too large" });
  const expected = signature(secret, body);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json(401, { error: "bad signature" });

  const event = req.headers.get("x-github-event") ?? "push";
  if (event === "ping") return json(200, { ok: true, pong: true });
  if (event !== "push") return json(202, { ignored: `event ${event}` });

  let payload: { ref?: string; after?: string; deleted?: boolean; repository?: { full_name?: string } };
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json(400, { error: "body is not JSON" });
  }
  if (payload.ref !== `refs/heads/${rt.branch}`) return json(202, { ignored: `ref ${payload.ref}, deploying ${rt.branch} only` });
  if (payload.deleted) return json(202, { ignored: "branch deleted" });
  if (rt.github_repo && payload.repository?.full_name && payload.repository.full_name.toLowerCase() !== rt.github_repo.toLowerCase()) {
    return json(403, { error: `push from ${payload.repository.full_name}, site deploys ${rt.github_repo}` });
  }
  const sha = payload.after && /^[0-9a-f]{40}$/.test(payload.after) ? payload.after : undefined;
  if (!deps.start(domain, sha)) return json(500, { error: "could not start deploy" });
  return json(202, { deploying: domain, sha: sha ?? null });
}

export function serve(port: number, deps: HookDeps = serverDeps) {
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => handleHook(req, deps) });
  process.stdout.write(`fornax hook listening on 127.0.0.1:${server.port}\n`);
  return server;
}
