<!-- What changes for the people or agents using fornax, and why. Link the issue if there is one. -->

## Checklist

- [ ] `bun run typecheck` and `bun run test` pass
- [ ] Integration tests pass (`bun run test:int`), or this change does not touch what happens on a server
- [ ] New behaviour is covered by tests
- [ ] CHANGELOG.md has a bullet under the unreleased version
- [ ] Docs updated: `docs/` (and `bun run docs` after schema changes), `docs/compatibility.md` for new commands or error codes, `skills/fornax/SKILL.md` for what agents should do differently
- [ ] Follows the design rules in CONTRIBUTING.md (plan → apply, idempotent, no root in a site's home, `q()` and schema checks, secrets as references)
- [ ] No personal data: no real host names, domains, IP addresses, user names, vault names or tokens in code, tests, docs or commit messages
