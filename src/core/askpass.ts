/**
 * ssh asks for a security key's PIN (and announces "touch your key") through SSH_ASKPASS when it
 * has no terminal — and fornax runs ssh without one. This writes a small askpass program that
 * does both: on macOS with dialogs (a hidden-input dialog for the PIN, a notification for the
 * touch), elsewhere on the terminal fornax was started in.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCRIPT = `#!/bin/sh
# fornax: PIN and touch prompts for a hardware SSH key (ssh runs without a terminal here)
if [ "$(uname)" = Darwin ]; then
  case "$SSH_ASKPASS_PROMPT" in
    none) exec osascript -e "display notification \\"$1\\" with title \\"fornax — touch your security key\\"" >/dev/null 2>&1 ;;
    confirm) [ "$(osascript -e "button returned of (display dialog \\"$1\\" buttons {\\"No\\", \\"Yes\\"} default button \\"No\\" with title \\"fornax\\")" 2>/dev/null)" = Yes ] && exit 0 || exit 1 ;;
  esac
  exec osascript -e "text returned of (display dialog \\"$1\\" default answer \\"\\" with hidden answer with title \\"fornax — security key PIN\\" with icon caution)"
fi
# elsewhere: the terminal fornax was started in (also over SSH, e.g. on a box at home)
( : < /dev/tty ) 2>/dev/null || { echo "fornax: no terminal to ask for the security key's PIN" >&2; exit 1; }
case "$SSH_ASKPASS_PROMPT" in
  none) printf '%s\\n' "$1" > /dev/tty; exit 0 ;;
  confirm) printf '%s [y/N] ' "$1" > /dev/tty; read -r a < /dev/tty; case "$a" in y|Y|yes) exit 0 ;; esac; exit 1 ;;
esac
printf '%s ' "$1" > /dev/tty
stty -echo < /dev/tty; read -r pin < /dev/tty; stty echo < /dev/tty
printf '\\n' > /dev/tty
printf '%s\\n' "$pin"
`;

/** Path of the askpass program (written on first use, 0700). */
export function askpassPath(): string {
  const dir = join(process.env.HOME || homedir(), ".config", "fornax");
  const path = join(dir, "askpass");
  if (!existsSync(path) || readFileSync(path, "utf8") !== SCRIPT) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, SCRIPT, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  return path;
}

/** Where ssh keeps the one connection per server it reuses (ControlMaster), 0700. */
export function controlDir(): string {
  const dir = join(process.env.HOME || homedir(), ".ssh", "fornax-cm");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
