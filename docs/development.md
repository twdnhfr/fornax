# Development

```bash
bun test              # unit tests (fake APIs, fixtures)
bun run typecheck
bun run test:int      # integration on OrbStack — no cloud, no cost
FORNAX_E2E_UBUNTU=26.04 bun test test/integration/e2e.test.ts --timeout 1800000   # same flow on 26.04 (machine fornax-base-2604)
```

Integration tests need an OrbStack machine `fornax-base` (Ubuntu 24.04 with `openssh-server` and `.dev/id_ed25519.pub` in root's `authorized_keys`). The end-to-end test runs a fake Hetzner API that "orders" servers by cloning that machine, a fake Cloudflare API, and Pebble (Let's Encrypt's test CA) for real ACME issuance.
