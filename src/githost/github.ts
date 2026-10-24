import { fail } from "../core/errors.ts";

/** Minimal GitHub REST client for deploy keys and webhooks. Base URL overridable for tests. */
export class GitHub {
  constructor(
    private readonly token: string,
    private readonly api = process.env.FORNAX_GITHUB_API ?? "https://api.github.com",
  ) {}

  static fromEnvironment(): GitHub {
    let token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!token) {
      const p = Bun.spawnSync(["gh", "auth", "token"], { stderr: "pipe" });
      if (p.exitCode === 0) token = p.stdout.toString().trim();
    }
    if (!token) fail("no_github_token", "no GitHub token", "set GITHUB_TOKEN or log in with `gh auth login`");
    return new GitHub(token!);
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: "application/vnd.github+json", "user-agent": "fornax", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) fail("github_error", `GitHub ${method} ${path}: HTTP ${res.status}`, text.slice(0, 300));
    return (text ? JSON.parse(text) : null) as T;
  }

  listKeys = (repo: string) => this.req<Array<{ id: number; key: string; title: string; read_only: boolean }>>("GET", `/repos/${repo}/keys`);
  addKey = (repo: string, title: string, key: string) => this.req<{ id: number }>("POST", `/repos/${repo}/keys`, { title, key, read_only: true });
  listHooks = (repo: string) => this.req<Array<{ id: number; config: { url?: string } }>>("GET", `/repos/${repo}/hooks`);
  addHook = (repo: string, url: string, secret: string) =>
    this.req<{ id: number }>("POST", `/repos/${repo}/hooks`, { name: "web", active: true, events: ["push"], config: { url, secret, content_type: "json", insecure_ssl: "0" } });
  deleteHook = (repo: string, id: number) => this.req<null>("DELETE", `/repos/${repo}/hooks/${id}`);
  updateHook = (repo: string, id: number, url: string, secret: string) =>
    this.req<{ id: number }>("PATCH", `/repos/${repo}/hooks/${id}`, { active: true, events: ["push"], config: { url, secret, content_type: "json", insecure_ssl: "0" } });
}

/** Keys are compared by type + material, without the comment. */
export const sameKey = (a: string, b: string) => a.trim().split(/\s+/).slice(0, 2).join(" ") === b.trim().split(/\s+/).slice(0, 2).join(" ");
