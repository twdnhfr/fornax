import { fail } from "../core/errors.ts";

/** JSON over HTTPS with a bearer token; errors become FornaxErrors with the API's message. */
export async function api<T>(base: string, token: string, method: string, path: string, body?: unknown, name = "API"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", "user-agent": "fornax" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return fail("provider_unreachable", `${name} not reachable: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string }; message?: string; errors?: Array<{ message: string }> };
      msg = j.error?.message ?? j.message ?? j.errors?.map((e) => e.message).join("; ") ?? msg;
    } catch {
      /* keep raw text */
    }
    fail(res.status === 401 || res.status === 403 ? "provider_auth" : "provider_error", `${name} ${method} ${path}: HTTP ${res.status} — ${msg}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}
