import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fail } from "./errors.ts";
import { OnePassword } from "./onepassword.ts";

/**
 * Secrets are referenced, never stored in the fleet repo:
 *   op://Vault/Item/field   1Password CLI
 *   env:NAME                environment variable
 *   file:path               file (relative to the fleet dir)
 *   keychain:service        macOS Keychain generic password (keychain:service/account)
 */
export async function resolveSecret(ref: string, fleetDir: string, account?: string): Promise<string> {
  if (ref.startsWith("op://")) return new OnePassword(account).read(ref);
  if (ref.startsWith("env:")) {
    const v = process.env[ref.slice(4)];
    if (!v) fail("secret_unavailable", `environment variable ${ref.slice(4)} is not set`);
    return v!;
  }
  if (ref.startsWith("keychain:")) {
    const [service, account] = ref.slice(9).split("/");
    if (process.platform !== "darwin") fail("secret_unavailable", `${ref.split("/")[0]}: the Keychain is macOS only`, "on this machine use file:<path> (0600) or env:NAME for this secret");
    const p = Bun.spawnSync(["security", "find-generic-password", "-s", service!, ...(account ? ["-a", account] : []), "-w"], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) fail("secret_unavailable", `no Keychain item "${service}"${account ? ` for ${account}` : ""}`, "add it with: security add-generic-password -s <service> -a <account> -w");
    return p.stdout.toString().replace(/\n$/, "");
  }
  if (ref.startsWith("file:")) {
    const p = isAbsolute(ref.slice(5)) ? ref.slice(5) : join(fleetDir, ref.slice(5));
    if (!existsSync(p)) fail("secret_unavailable", `secret file ${p} does not exist`);
    return readFileSync(p, "utf8").trim();
  }
  return fail("invalid_secret_ref", `"${ref.slice(0, 12)}…" is not a secret reference`, "use op://…, env:NAME, file:path or keychain:service — never the secret itself");
}
