import { defineCommand } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { FORNAX_PREFIX, OUTSIDE_PREFIX } from "../core/etc-history.ts";
import { getServer, loadFleet } from "../core/fleet.ts";
import { q } from "../core/shell.ts";
import { runnerFor } from "../core/ssh.ts";

type Kind = "fornax" | "packages" | "outside" | "start";

export interface EtcCommit {
  commit: string;
  date: string;
  kind: Kind;
  subject: string;
  by: string | null;
  fleet: string | null;
  files: string[];
}

/**
 * Who made a commit in /etc's history: fornax (its own commits), packages (etckeeper's apt hook)
 * or someone else — by hand, a script, another tool (caught before a fornax run, before an apt
 * run, or by the daily autocommit).
 */
export function kindOf(subject: string): Kind {
  if (subject.startsWith(FORNAX_PREFIX)) return "fornax";
  // etckeeper's first commit, when it was installed
  if (subject === "Initial commit") return "start";
  if (/^committing changes in \/etc (made by|after apt run)/.test(subject)) return "packages";
  return "outside";
}

/** `git log --format='@@%h%x09%aI%x09%s%n%w(0,4,4)%b' --name-only` → commits. */
export function parseEtcLog(out: string): EtcCommit[] {
  const commits: EtcCommit[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) {
      const [commit = "", date = "", ...rest] = line.slice(2).split("\t");
      const subject = rest.join("\t");
      commits.push({ commit, date, kind: kindOf(subject), subject, by: null, fleet: null, files: [] });
      continue;
    }
    const c = commits[commits.length - 1];
    if (!c || !line.trim()) continue;
    if (line.startsWith("    ")) {
      const m = line.trim().match(/^(by|fleet): (.+)$/);
      if (m) c[m[1] as "by" | "fleet"] = m[2]!;
    } else c.files.push(line.trim());
  }
  return commits;
}

/** A path as git in /etc knows it ("/etc/ufw/user.rules" and "ufw/user.rules" alike). */
const etcPath = (p: string) => p.replace(/^\/etc\//, "").replace(/^\/+/, "");

defineCommand({
  name: "history",
  summary: "how a server's configuration got to where it is: /etc's git history (etckeeper) — fornax runs, package updates and changes made outside fornax, by date",
  tier: "read",
  args: [{ name: "server", help: "server name", required: true }],
  options: {
    path: { type: "string", help: "only changes to this file or directory (e.g. ufw/user.rules or /etc/nginx)" },
    lines: { type: "number", help: "how many commits", default: 20 },
    show: { type: "string", help: "one commit in full: what changed, as a diff (password hashes left out)" },
  },
  examples: ["fornax history web-1", "fornax history web-1 --path ufw", "fornax history web-1 --show 3f2a1c9"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    const runner = runnerFor(fleet, server);
    const ready = await runner.run("[ -d /etc/.git ] && command -v git >/dev/null", { allowFail: true });
    if (ready.code !== 0) fail("no_history", `${server.server} keeps no history of /etc yet`, "fornax sets up etckeeper with the next full apply (history: true, the default)", `fornax plan ${server.server}`);
    if (input.show) {
      const id = String(input.show);
      if (!/^[0-9a-f]{4,40}$/.test(id)) fail("invalid_option", "--show takes a commit id from `fornax history`");
      // shadow files hold password hashes: never shown
      const out = await runner.run(`git -C /etc show --stat --patch --format='commit %h  %aI%n%n%B' ${q(id)} -- . ':(exclude)shadow' ':(exclude)gshadow' ':(exclude)shadow-' ':(exclude)gshadow-'`);
      return { data: { commit: id, text: out.stdout }, human: out.stdout.trimEnd() };
    }
    const path = input.path ? ` -- ${q(etcPath(String(input.path)))}` : "";
    const out = await runner.run(`git -C /etc log -n ${Number(input.lines)} --format='@@%h%x09%aI%x09%s%n%w(0,4,4)%b' --name-only${path}
printf '@@@pending\\n'; git -C /etc status --porcelain${path}`);
    const [log = "", pendingRaw = ""] = out.stdout.split("@@@pending\n");
    const commits = parseEtcLog(log);
    // changed since the last commit and not attributed yet — not by fornax (it commits right after itself)
    const pending = pendingRaw.split("\n").filter(Boolean).map((l) => l.slice(3));
    const human = commits
      .map((c) => {
        const files = c.files.length ? `  ${c.files.slice(0, 4).join(", ")}${c.files.length > 4 ? ` +${c.files.length - 4}` : ""}` : "";
        const who = c.kind === "fornax" ? ` (${[c.by, c.fleet && `fleet ${c.fleet}`].filter(Boolean).join(", ")})` : "";
        return `${c.commit}  ${c.date.slice(0, 16).replace("T", " ")}  ${c.kind.padEnd(8)}  ${c.subject.replace(/^(fornax|outside fornax): /, "")}${who}${files}`;
      })
      .join("\n");
    const now = pending.length ? `now     changed since the last commit, not by fornax: ${pending.slice(0, 6).join(", ")}${pending.length > 6 ? ` +${pending.length - 6}` : ""}\n` : "";
    return { data: { server: server.server, path: input.path ?? null, uncommitted: pending, commits }, human: now + (human || "no changes recorded" + (input.path ? ` for ${input.path}` : "")) };
  },
});
