import { defineCommand } from "../core/command.ts";
import { compareVersions, installKind, installRelease, latestVersion, RELEASE_REPO } from "../core/update.ts";
import { VERSION } from "../core/version.ts";

defineCommand({
  name: "self-update",
  summary: "update this fornax to the newest release (signed; servers follow on their next deploy or apply)",
  tier: "write",
  options: {
    check: { type: "boolean", help: "only say whether a newer release is out" },
    version: { type: "string", help: "install this release instead of the newest, e.g. 0.2.0 (also an older one)" },
  },
  examples: ["fornax self-update --check", "fornax self-update", "fornax self-update --version 0.2.0"],
  async run(input, ctx) {
    const install = installKind();
    const wanted = input.version ? String(input.version).replace(/^v/, "") : undefined;
    // a checkout updates with git: no release to compare with before it asks for one
    if (install.kind === "source") {
      return {
        data: { current: VERSION, install: install.kind, dir: install.dir, updated: false, next: `git -C ${install.dir} pull` },
        human: `fornax ${VERSION} runs from a source checkout (${install.dir}): update it with git -C ${install.dir} pull`,
      };
    }
    const target = wanted ?? latestVersion();
    const cmp = compareVersions(target, VERSION);
    const base = { current: VERSION, target, install: install.kind, dir: install.dir, repo: RELEASE_REPO };
    if (cmp === 0 || (cmp < 0 && !wanted)) return { data: { ...base, updated: false }, human: `fornax ${VERSION} is current (newest release: ${target})` };
    if (input.check) return { data: { ...base, updated: false, next: install.kind === "homebrew" ? "brew upgrade fornax" : "fornax self-update" }, human: `fornax ${target} is out (this is ${VERSION}) — ${install.kind === "homebrew" ? "brew upgrade fornax" : "fornax self-update"}` };
    if (install.kind === "homebrew") return { data: { ...base, updated: false, next: "brew upgrade fornax" }, human: `fornax was installed with Homebrew: brew upgrade fornax` };
    const files = installRelease(target, install.dir, ctx.log);
    return {
      data: { ...base, updated: true, files },
      human: `updated fornax ${VERSION} → ${target}${cmp < 0 ? " (an older release, as asked)" : ""} in ${install.dir}\nservers get it with their next deploy or apply`,
    };
  },
});
