/**
 * Lines fornax has to tell the person at the keyboard while a command runs, outside its ctx.log:
 * "touch your security key", a Tailscale login link, a config note. On the CLI they go to stderr.
 * `fornax ui` runs several commands in one process at once, so it hands each run its own sink —
 * through AsyncLocalStorage, which follows the run into every await and ssh child it starts.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const sink = new AsyncLocalStorage<(line: string) => void>();

export function notice(line: string): void {
  const to = sink.getStore();
  if (to) to(line);
  else process.stderr.write(line + "\n");
}

/** Run `fn` with its notices going to `to` instead of stderr. */
export const withNotices = <T>(to: (line: string) => void, fn: () => Promise<T>): Promise<T> => sink.run(to, fn);
