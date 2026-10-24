import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { defineCommand } from "../core/command.ts";
import { fail } from "../core/errors.ts";
import { getServer, loadFleet } from "../core/fleet.ts";
import { ServerSchema } from "../core/schema.ts";
import { SshRunner } from "../core/ssh.ts";
import { detachServer } from "../forge/detach.ts";
import { refreshServer } from "../forge/refresh.ts";
import { collectLocal, collectRemote, collectSpec, fromForgeApi, fromForgeDump, translate } from "../forge/import.ts";

defineCommand({
  name: "import forge",
  summary: "take over a Laravel Forge server: adopt its sites' files byte for byte (first plan is empty), no site moves",
  tier: "write",
  args: [{ name: "name", help: "name for the server in this fleet", required: true }],
  options: {
    "server-id": { type: "string", help: "Forge server id" },
    org: { type: "string", help: "Forge organisation slug (`forge org:list`)" },
    host: { type: "string", help: "how fornax reaches the server over SSH (default: its public IP from Forge)" },
    dump: { type: "string", help: "read Forge API responses from this directory instead of the API" },
    files: { type: "string", help: "read server files from a local mirror directory instead of SSH" },
    force: { type: "boolean", help: "overwrite an existing servers/<name>.yaml" },
    refresh: { type: "boolean", help: "server already imported: take over what Forge changed since, for sites not converted yet (converted ones stay as they are)" },
  },
  examples: [
    "fornax import forge web-1 --org my-org --server-id 123456",
    "fornax import forge web-1 --server-id 123456 --dump ./forge-dump --host web-1.tailnet",
    "fornax import forge web-1 --org my-org --server-id 123456 --refresh   # later, while Forge still runs other sites",
  ],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const name = String(input.name);
    if (!input.serverId) fail("missing_option", "--server-id is required", "the numeric id in the Forge URL or `forge server:list`");
    const target = join(fleet.dir, "servers", `${name}.yaml`);
    const existing = input.refresh ? getServer(fleet, name) : undefined;
    if (input.refresh && input.force) fail("invalid_option", "--refresh and --force exclude each other", "--force throws away all conversions; --refresh keeps them");
    if (existsSync(target) && !input.force && !input.refresh) fail("exists", `${target} already exists`, "pass --refresh to take over Forge's changes (keeps conversions), or --force to start over");
    if (!input.dump && !input.org) fail("missing_option", "--org is required when reading the Forge API", "`forge org:list` shows the slug");

    ctx.log("reading Forge …");
    const data = input.dump ? await fromForgeDump(resolve(ctx.cwd, String(input.dump)), String(input.serverId)) : await fromForgeApi(String(input.org), String(input.serverId));
    const host = (input.host as string | undefined) ?? existing?.host ?? data.server.ip_address;
    const spec = collectSpec(data);
    ctx.log(`collecting ${spec.paths.length} files and ${spec.dirs.length} directories from ${input.files ? input.files : host} …`);
    const collected = input.files
      ? collectLocal(resolve(ctx.cwd, String(input.files)), spec)
      : await collectRemote(new SshRunner(fleet, ServerSchema.parse({ server: name, host, sites: {} })), spec);

    const plan = translate(data, collected, { name, host, date: new Date().toISOString().slice(0, 10) });
    if (existing) {
      const r = refreshServer(fleet, existing, plan);
      loadFleet(ctx);
      return {
        data: { server: name, ...r, next: `fornax plan ${name}` },
        human: [
          `refreshed ${name} from Forge`,
          r.refreshed.length ? `  refreshed: ${r.refreshed.join(", ")}` : "",
          r.added.length ? `  added (adopted): ${r.added.join(", ")}` : "",
          ...r.skipped.map((x) => `  kept ${x.site}: ${x.reason}`),
          r.files.length ? `  files: ${r.files.join(", ")}` : "  no file changed",
          ...[...r.warnings, ...plan.warnings].map((w) => `  ! ${w}`),
          `next: fornax plan ${name}   (should be in sync again for the refreshed sites)`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    const check = ServerSchema.safeParse(plan.server);
    if (!check.success) fail("internal_error", `import produced an invalid config: ${check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    for (const [rel, content] of plan.files) {
      const p = join(fleet.dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `# imported from Laravel Forge — see notes:\n${YAML.stringify(plan.server, { lineWidth: 0 })}`);
    loadFleet(ctx); // the fleet must still load with the new server
    return {
      data: { server: name, file: target, adopted_files: plan.files.size, sites: plan.sites, warnings: plan.warnings, next: `fornax plan ${name}` },
      human: [
        `imported ${name} → ${target}`,
        ...plan.sites.map((s) => `  ${s.site.padEnd(32)} ${s.preset.padEnd(8)} ${String(s.files).padStart(2)} files adopted — ${s.deploy_note}`),
        plan.warnings.length ? `warnings:\n${plan.warnings.map((w) => `  - ${w}`).join("\n")}` : "",
        `next: fornax plan ${name}   (should be in sync: nothing was regenerated)`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

defineCommand({
  name: "detach forge",
  summary: "cut Forge off a server whose sites are all converted: its worker key, its SSH rules in ufw, its cleanup cron and PPA — edits the fleet repo; plan + apply do the rest",
  tier: "write",
  args: [{ name: "server", help: "server name", required: true }],
  options: {
    "ufw-ip": { type: "list", help: "more addresses whose port-22 rules go too (old Forge IPs that are no longer on Forge's list)" },
    force: { type: "boolean", help: "detach although sites are still adopted (Forge stops deploying and renewing them)" },
  },
  examples: ["fornax detach forge web-1", "fornax plan web-1 && fornax apply <id>", "fornax detach forge web-1 --ufw-ip 203.0.113.7   # an old Forge address"],
  async run(input, ctx) {
    const fleet = loadFleet(ctx);
    const server = getServer(fleet, String(input.server));
    ctx.log(`looking for Forge on ${server.server} …`);
    const res = await detachServer(fleet, server, { force: Boolean(input.force), ufwIps: input.ufwIp as string[] | undefined });
    loadFleet(ctx);
    const next = `fornax plan ${server.server}`;
    const after = "then in Forge: remove the server's provider credential if it has one (or deleting the server deletes the machine), delete the server, and revoke Forge's GitHub authorization once no server needs it";
    return {
      data: { ...res, next, after },
      human: [
        `${server.server}: detaching from Forge in the fleet repo`,
        ...res.changes.map((c) => `  ${c}`),
        ...res.warnings.map((w) => `  ! ${w}`),
        `next: ${next}  →  fornax apply <id>`,
        after,
      ].join("\n"),
    };
  },
});
