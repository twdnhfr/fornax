import { defineCommand } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { findSite, loadFleet, type ResolvedSite } from "../core/fleet.ts";
import { asUser, q } from "../core/shell.ts";
import { interactive, runnerFor } from "../core/ssh.ts";

/**
 * Working as a site's user: root logs in (with ssh.security_key: one touch, the connection is
 * reused) and drops to the site user right away — site users have no SSH login of their own.
 * In the site's directory, with `php` meaning the site's PHP version (composer follows it too).
 */
function siteEnv(site: ResolvedSite, then: string): string {
  const php = `/usr/bin/php${site.php}`;
  return `cd ${q(site.current)} 2>/dev/null || cd ${q(site.root)} 2>/dev/null || cd
d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT
[ -x ${php} ] && ln -s ${php} "$d/php" && export PATH="$d:$PATH"
${then}`;
}

defineCommand({
  name: "shell",
  summary: "interactive shell as a site's user, in its directory (php = the site's version)",
  tier: "write",
  args: [{ name: "site", help: "site domain", required: true }],
  examples: ["fornax shell shop.example.com"],
  async run(input, ctx) {
    if (ctx.json) fail("invalid_option", "fornax shell is interactive and has no --json output", "use fornax run <site> -- <command> for one command");
    if (!process.stdin.isTTY) fail("no_terminal", "fornax shell needs a terminal", "use fornax run <site> -- <command> instead");
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    ctx.log(`${site.user}@${server.server} — exit to leave`);
    const code = await interactive(fleet, server, asUser(site.user, siteEnv(site, "bash -l"), ["TERM"]));
    return { data: { site: site.domain, server: server.server, user: site.user, code }, human: "", exitCode: code };
  },
});

defineCommand({
  name: "run",
  summary: "run one command as a site's user, in its directory (php = the site's version); exits with its exit code",
  tier: "write",
  args: [
    { name: "site", help: "site domain", required: true },
    { name: "command", help: "the command, after -- (read by bash, like ssh: quote pipes and redirects as one argument)", required: true, variadic: true },
  ],
  examples: ["fornax run shop.example.com -- php artisan migrate:status", "fornax run shop.example.com -- 'tail -n 20 storage/logs/laravel.log | grep ERROR'"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const { server, site } = findSite(fleet, String(input.site));
    const command = (input.command as string[]).join(" ");
    if (!command.trim()) fail("missing_argument", "missing the command to run", "fornax run <site> -- <command>");
    // no stdin: a question the command asks gets end-of-file, not the rest of this script
    const script = asUser(site.user, siteEnv(site, `${command} </dev/null`));
    const out = (stream: NodeJS.WriteStream) => (ctx.json ? undefined : (l: string) => stream.write(l + "\n"));
    const res = await runnerFor(fleet, server).run(script, { allowFail: true, onStdout: out(process.stdout), onStderr: out(process.stderr) });
    return { data: { site: site.domain, server: server.server, user: site.user, command, code: res.code, stdout: res.stdout, stderr: res.stderr }, human: "", exitCode: res.code };
  },
});
