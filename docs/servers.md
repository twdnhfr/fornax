# Ordering servers, Tailscale

`server create` orders the machine with the fleet's SSH key (one key per fleet, kept in its 1Password vault and in an agent of fornax's own — never a key file), turns on the provider's delete protection, waits for SSH and provisions it. With `access: tailscale` it first joins the server to the tailnet — with `tailscale.api_token` through a single-use key made for it (key expiry turned off afterwards), else with `tailscale.auth_key` (a reusable key that tags it); either way the server joins as `tag:server` (`tailscale.tag`); the key goes over SSH, never through cloud metadata —, switches `host` to the tailnet name and checks Tailscale SSH works before the firewall closes the public SSH port; then the fleet key comes off the server again — Tailscale SSH has taken over, and the key stays in the vault for the next server (and for the provider's rescue system). `server destroy` removes the machine from the tailnet and lifts the delete protection. `fornax server rename <server> [new-name]` renames it everywhere (hostname, provider, tailnet, fleet, 1Password item, backup repository); backups made under the old name stay listed and restorable.

With Tailscale, give servers a tag rather than your own identity: a server that counts as one of *your* devices gets the rights of your devices — with a policy like "my devices may SSH as root to my devices", a compromised app on any server becomes root on all of them. Tagged, it is no `autogroup:member` and gets nothing unless a rule names the tag:

```jsonc
"tagOwners": { "tag:server": ["autogroup:admin"] },
"ssh": [
  { "action": "accept", "src": ["autogroup:member"], "dst": ["autogroup:self"], "users": ["autogroup:nonroot", "root"] },
  { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:server"],     "users": ["autogroup:nonroot", "root"] }
]
```
