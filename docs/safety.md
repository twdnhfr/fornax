# Safety model

| Tier | Commands | |
| --- | --- | --- |
| `read` | `server status`, `logs`, `explain`, `plan`, `diff`, `ssl status`, `releases`, `env pull` … | never change a server |
| `write` | `apply`, `deploy`, `rollback`, `env push`, `server create`, `dns sync` … | change servers or remote APIs |
| `destroy` | `site remove`, `server destroy`, `server reinstall` | also need `--confirm=<exact name>` |

A command keeps its tier within a major version, so an allowlist of read commands stays safe across updates ([compatibility](compatibility.md)).

Plans that delete something need `--confirm=<server>` on apply. Only one apply runs per server at a time, and the check that the server has not changed since the plan happens under that lock. Firewall changes add missing rules before removing extra ones, so SSH is never cut off. fornax prunes its own traces on the server (backups after 14 days, logs after 90, the last 50 deploy logs per site). nginx, PHP-FPM, sshd and sudoers changes are validated before reload; a rejected config is rolled back automatically. Every script fornax runs is kept with its output in `/var/log/fornax/` on the server.

## For Claude Code

```bash
ln -s "$PWD/skills/fornax" ~/.claude/skills/fornax
```

Suggested allowlist (`~/.claude/settings.json`), read-tier only:

```json
{ "permissions": { "allow": [
  "Bash(fornax agent-context:*)", "Bash(fornax explain:*)", "Bash(fornax server status:*)", "Bash(fornax server list:*)",
  "Bash(fornax site list:*)", "Bash(fornax logs:*)", "Bash(fornax ssl status:*)", "Bash(fornax plan:*)", "Bash(fornax diff:*)",
  "Bash(fornax releases:*)", "Bash(fornax dns status:*)", "Bash(fornax provider list:*)", "Bash(fornax provider catalog:*)"
] } }
```
