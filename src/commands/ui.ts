import { defineCommand } from "../core/command.ts";
import { loadFleet } from "../core/fleet.ts";
import { IDLE_MS, startUi } from "../ui/server.ts";

function openBrowser(url: string) {
  try {
    Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    /* no browser opener: the URL is printed anyway */
  }
}

defineCommand({
  name: "ui",
  summary: "local web dashboard for humans (127.0.0.1 only): fleet overview, status, health, logs, new site → plan → apply, deploy — the same commands, tiers and errors as the CLI",
  tier: "read",
  options: {
    port: { type: "number", help: "port on 127.0.0.1 (default: a random free one)" },
    open: { type: "boolean", help: "open the browser (--no-open: only print the URL)", default: true },
  },
  examples: ["fornax ui", "fornax ui --no-open --port 7700"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const ui = startUi({ cwd: ctx.cwd, fleetDir: ctx.fleetDir ?? fleet.dir, port: input.port as number | undefined });
    const minutes = IDLE_MS / 60_000;
    ctx.log(`fornax ui for fleet "${fleet.config.fleet}" (${fleet.dir}):`);
    ctx.log(`  ${ui.url}`);
    ctx.log(`only this machine can connect, and only with the token in that link. Ctrl-C stops it; so do ${minutes} minutes without requests.`);
    if (input.open) openBrowser(ui.url);
    process.once("SIGINT", () => ui.stop());
    const why = await ui.closed;
    return { data: { stopped: why }, human: why === "idle" ? `fornax ui stopped after ${minutes} minutes without requests` : "fornax ui stopped" };
  },
});
