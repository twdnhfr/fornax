# Development

```bash
bun run test          # unit tests (fake APIs, fixtures)
bun run typecheck
bun run docs          # regenerate docs/config.md from src/core/schema.ts
bun run test:int      # integration on OrbStack — no cloud, no cost
FORNAX_E2E_UBUNTU=26.04 bun test test/integration/e2e.test.ts --timeout 1800000   # same flow on 26.04 (machine fornax-base-2604)
```

Integration tests need an OrbStack machine `fornax-base` (Ubuntu 24.04 with `openssh-server` and `.dev/id_ed25519.pub` in root's `authorized_keys`). The end-to-end test runs a fake Hetzner API that "orders" servers by cloning that machine, a fake Cloudflare API, and Pebble (Let's Encrypt's test CA) for real ACME issuance.

[docs/config.md](config.md) is generated from the zod schema in `src/core/schema.ts`: types and defaults from the schema, descriptions from the `/** … */` comment above each key. Run `bun run docs` after changing the schema and commit the result; a unit test fails while the reference is out of date, or when a doc comment matches no key. The command also lists the keys that still have no comment.

How to set up the OrbStack machines, the design rules a change has to follow and how to document it: [CONTRIBUTING.md](../CONTRIBUTING.md).
