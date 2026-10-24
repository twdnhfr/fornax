/**
 * `fornax ui`: a dashboard for humans over the very same commands. Every action runs through the
 * command registry in this process (parseInput + run), so the browser gets the CLI's validation,
 * tiers, errors and data — nothing here knows how a plan or a deploy works.
 *
 * Only this machine and only this browser: bound to 127.0.0.1, a random token exchanged for an
 * HttpOnly SameSite=Strict cookie, the Host header checked (DNS rebinding), and a custom header on
 * every POST (a cross-site form or image cannot send one).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { commands, humanOutput, parseInput, type CommandDef, type Context, type Input, type Result } from "../core/command.ts";
import { asFornaxError, FornaxError } from "../core/errors.ts";
import { loadFleet } from "../core/fleet.ts";
import { withNotices } from "../core/notice.ts";
import { PRESETS } from "../core/schema.ts";
import { LOG_KINDS } from "../commands/observe.ts";
import pageHtml from "./index.html" with { type: "text" };
import css from "./style.css" with { type: "text" };
import js from "./app.js" with { type: "text" };

/**
 * What the dashboard may run, and the options it may pass. Destroy-tier commands are never here,
 * nor `apply --confirm` (a plan that deletes things is applied in a terminal).
 */
export const ACTIONS: Record<string, readonly string[]> = {
  "server list": [],
  "site list": [],
  "server status": [],
  health: ["all"],
  "ssl status": ["warn"],
  "backup status": [],
  releases: [],
  logs: ["lines", "grep"],
  explain: ["offline"],
  plan: ["site", "module"],
  "site add": ["preview", "repo", "branch", "preset", "php", "user", "db", "alias", "tls", "www", "daemon", "schedule", "start"],
  apply: [],
  deploy: ["ref"],
};

export const IDLE_MS = 30 * 60_000;

export type OptionValue = string | number | boolean | string[];

export interface RunRequest {
  command: string;
  args?: string[];
  options?: Record<string, OptionValue>;
}

export type RunEvent =
  | { t: "start"; command: string; tier: string }
  | { t: "log"; line: string; notice?: true }
  | { t: "result"; data: unknown; human: string; exitCode: number }
  | { t: "error"; error: ReturnType<FornaxError["toJSON"]> }
  | { t: "ping" };

/** The argv the CLI would get: options first, then `--` so no argument is ever read as an option. */
export function prepare(req: RunRequest): { def: CommandDef; input: Input } {
  const allowed = typeof req.command === "string" && Object.hasOwn(ACTIONS, req.command) ? ACTIONS[req.command]! : undefined;
  const def = allowed && commands().find((c) => c.name === req.command);
  if (!allowed || !def || def.tier === "destroy") {
    throw new FornaxError("not_in_ui", `"${String(req.command)}" cannot be run from fornax ui`, "the dashboard offers read commands, site add, plan, apply and deploy — use the CLI for the rest");
  }
  const argv: string[] = [];
  for (const [key, value] of Object.entries(req.options ?? {})) {
    if (!allowed.includes(key)) throw new FornaxError("not_in_ui", `option --${key} of "${def.name}" cannot be passed from fornax ui`, "use the CLI for it");
    if (value === false || value === "" || value === undefined || value === null) continue;
    if (value === true) argv.push(`--${key}`);
    else if (Array.isArray(value)) for (const v of value) argv.push(`--${key}=${String(v)}`);
    else argv.push(`--${key}=${String(value)}`);
  }
  const args = req.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new FornaxError("invalid_argument", "args must be a list of strings");
  argv.push("--", ...args);
  return { def, input: parseInput(def, argv) };
}

/** One command, exactly as the CLI runs it; its progress and notices go to `log`. */
export function execute(def: CommandDef, input: Input, base: { cwd: string; fleetDir?: string }, log: (line: string, notice: boolean) => void): Promise<Result> {
  const ctx: Context = { json: false, verbose: false, cwd: base.cwd, fleetDir: base.fleetDir, log: (line) => log(line, false) };
  return withNotices((line) => log(line, true), () => def.run(input, ctx));
}

export interface UiOptions {
  cwd: string;
  fleetDir?: string;
  /** 0 or undefined: a random free port. */
  port?: number;
  idleMs?: number;
}

export interface UiServer {
  url: string;
  port: number;
  token: string;
  /** Resolves when the server stopped: after `idleMs` without requests, or stop(). */
  closed: Promise<"idle" | "stopped">;
  stop(): void;
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const respond = (body: string | ReadableStream<Uint8Array> | null, status: number, type: string, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...SECURITY_HEADERS, "Content-Type": type, ...extra } });
const json = (body: unknown, status = 200) => respond(JSON.stringify(body), status, "application/json");
const deny = (status: number, code: string, message: string, hint?: string) => json(new FornaxError(code, message, hint).toJSON(), status);

const sameSecret = (a: string | null | undefined, b: string) => {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function startUi(o: UiOptions): UiServer {
  const token = randomBytes(32).toString("base64url");
  const base = { cwd: o.cwd, fleetDir: o.fleetDir };
  const idleMs = o.idleMs ?? IDLE_MS;
  let last = Date.now();
  let running = 0;
  let port = 0;
  // two dashboards on different ports share the host's cookies: one cookie name per port
  const cookieName = () => `fornax_ui_${port}`;

  const authed = (req: Request) => {
    const cookie = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${cookieName()}=`));
    const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "");
    return sameSecret(cookie?.slice(cookieName().length + 1), token) || sameSecret(bearer, token);
  };

  async function handle(req: Request): Promise<Response> {
    const host = req.headers.get("host");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return deny(403, "wrong_host", `requests for "${host}" are not answered here`, "open the URL fornax ui printed");
    last = Date.now();
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
      if (!sameSecret(url.searchParams.get("token"), token)) return respond("wrong or outdated link — open the URL fornax ui printed", 401, "text/plain; charset=utf-8");
      // the token leaves the address bar (and the history) right away; the cookie carries it from here
      return respond(null, 303, "text/plain", { Location: "/", "Set-Cookie": `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (!authed(req)) {
      return url.pathname.startsWith("/api/") ? deny(401, "unauthorized", "missing or wrong token", "open the URL fornax ui printed") : respond("open the URL fornax ui printed in the terminal (it carries the token)", 401, "text/plain; charset=utf-8");
    }
    if (req.method === "POST") {
      if (req.headers.get("x-fornax") !== "1") return deny(403, "csrf", "POST requests need the header X-Fornax: 1");
      const origin = req.headers.get("origin");
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return deny(403, "csrf", `requests from ${origin} are not accepted`);
    }

    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /":
        return respond(pageHtml as unknown as string, 200, "text/html; charset=utf-8");
      case "GET /app.js":
        return respond(js, 200, "text/javascript; charset=utf-8");
      case "GET /style.css":
        return respond(css, 200, "text/css; charset=utf-8");
      case "GET /api/fleet":
        return fleetOverview();
      case "GET /api/actions":
        return json({
          actions: Object.keys(ACTIONS).map((name) => {
            const def = commands().find((c) => c.name === name)!;
            const options = Object.entries(def.options ?? {}).filter(([k]) => ACTIONS[name]!.includes(k));
            return { name, tier: def.tier, summary: def.summary, args: def.args ?? [], options: Object.fromEntries(options) };
          }),
          presets: PRESETS,
          log_kinds: LOG_KINDS,
          idle_minutes: Math.round(idleMs / 60_000),
        });
      case "POST /api/run":
        return runStream(req);
    }
    return deny(404, "not_found", `${route} does not exist`);
  }

  /** Servers and sites from the fleet config — instant, no SSH. */
  async function fleetOverview(): Promise<Response> {
    try {
      const run = (command: string) => {
        const { def, input } = prepare({ command });
        return execute(def, input, base, () => {});
      };
      const [servers, sites] = await Promise.all([run("server list"), run("site list")]);
      const fleet = loadFleet(base);
      return json({ fleet: fleet.config.fleet, dir: fleet.dir, access: fleet.config.access, servers: servers.data, sites: sites.data });
    } catch (e) {
      return json(asFornaxError(e).toJSON(), 422);
    }
  }

  async function runStream(req: Request): Promise<Response> {
    let prepared: ReturnType<typeof prepare>;
    try {
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) throw new FornaxError("invalid_request", "send JSON");
      prepared = prepare((await req.json()) as RunRequest);
    } catch (e) {
      return json(asFornaxError(e).toJSON(), 400);
    }
    const { def, input } = prepared;
    let open = true;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (ev: RunEvent) => {
          if (!open) return;
          try {
            controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
          } catch {
            open = false;
          }
        };
        // ssh can be silent for minutes (a build, a PIN dialog): keep the connection visibly alive
        const ping = setInterval(() => send({ t: "ping" }), 15_000);
        running++;
        send({ t: "start", command: def.name, tier: def.tier });
        try {
          const r = await execute(def, input, base, (line, notice) => send({ t: "log", line, ...(notice ? { notice: true as const } : {}) }));
          send({ t: "result", data: r.data ?? null, human: humanOutput(r), exitCode: r.exitCode ?? 0 });
        } catch (e) {
          send({ t: "error", error: asFornaxError(e).toJSON() });
        } finally {
          clearInterval(ping);
          running--;
          last = Date.now();
          if (open) controller.close();
        }
      },
      // the browser went away: the command runs on (an apply must not stop halfway), unseen
      cancel() {
        open = false;
      },
    });
    return respond(body, 200, "application/x-ndjson; charset=utf-8");
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: o.port ?? 0, idleTimeout: 255, fetch: handle });
  } catch (e) {
    throw new FornaxError("port_in_use", `cannot listen on 127.0.0.1:${o.port}: ${(e as Error).message}`, "leave out --port for a free one");
  }
  port = server.port!;

  let finish!: (why: "idle" | "stopped") => void;
  const closed = new Promise<"idle" | "stopped">((resolve) => {
    finish = (why) => {
      clearInterval(timer);
      server.stop(true);
      resolve(why);
    };
  });
  const timer = setInterval(() => {
    if (!running && Date.now() - last > idleMs) finish("idle");
  }, Math.min(60_000, Math.max(50, idleMs / 4)));

  return { url: `http://127.0.0.1:${port}/?token=${token}`, port, token, closed, stop: () => finish("stopped") };
}
