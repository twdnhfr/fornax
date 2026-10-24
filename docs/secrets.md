# Secrets and 1Password

Secrets are references, resolved only when needed: `op://Vault/Item/field`, `env:NAME`, `file:path`, `keychain:service`. Every credential fornax itself creates — database passwords, the Redis password, the restic password, webhook secrets, deploy keys, the Storage Box key — is generated on the server and copied into one 1Password item per server (`fornax <fleet> <server>`) after every apply.

Set this up once per fleet, right after `fornax init`:

```bash
fornax secrets setup          # needs the 1Password app once (Touch ID); afterwards never again
```

It creates a vault of the fleet's own (`fornax-<fleet>`), a 1Password service account that may read and write only that vault, keeps the account's token in the macOS Keychain (elsewhere: a 0600 file under `~/.config/fornax/`) and writes the result to `fornax.yaml`:

```yaml
onepassword:
  vault: fornax-acme
  service_account: keychain:fornax-1password-acme
  auto_sync: true             # the default: credentials go to 1Password after every apply
```

With the service account, fornax talks to 1Password directly — no desktop app, no Touch ID prompts in the middle of a plan. Service accounts cannot open the built-in Private vault, so keep the items your fleet references (Storage Box password, ntfy token, provider tokens) in the fleet's vault too; `secrets setup` lists references that still point elsewhere.

`server destroy` moves the server's item to the 1Password archive (`--keep-secrets` leaves it). `fornax secrets list <server>` compares server and 1Password without showing values; `fornax secrets sync <server>` copies by hand. Values never appear in command lines or saved plans: `op` gets JSON on stdin or a temporary 0600 template, and secrets an apply needs (like the Storage Box password) are passed as environment variables at apply time only.

Credentials that expire (API tokens, Tailscale auth keys) keep their date on the item — 1Password fills "valid until" for API credentials. Whenever fornax uses one that expires within 14 days (`onepassword.warn_expiry_days`), it warns on stderr; `fornax health` lists them fleet-wide (warning when due, critical once expired).
