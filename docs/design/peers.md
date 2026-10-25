# Every server a host — the fleet repo on every server, signed

Status: **phase 1 built (2026-10-25)** — user docs in [../peers.md](../peers.md). Phase 2 (the phone) is not. Phase 1 is fornax itself and works from any machine with `ssh -A`. Phase 2 is a phone app that holds the key and talks to an agent, and builds on phase 1. It is outlined at the end and is not part of fornax.

## 1. Goal

Today one machine changes the fleet: the one with the fleet repo, the 1Password access and the SSH key. Lose it, or be away from it, and nothing can be changed. The servers keep running, and `fleet_copy` keeps an encrypted copy for a restore.

With **peers**, every server carries the fleet repo and the fornax binary, so **any of them can run `fornax plan` and `fornax apply`**: for itself and for the others. The laptop is one host among several. A phone with a key is enough to manage the fleet. When one server is down, another fixes it.

## 2. The rule everything rests on

**Any server can be a host, but no server has power over another.**

- **No server-to-server keys.** A host reaches root on another server, and on itself, only through the SSH agent forwarded from the person running it: a hardware key, a phone's secure enclave, or a laptop's agent. Breaking into one server gives no way onto the next.
- **No commit is trusted because of where it lies.** A host accepts the fleet repo only if every commit is signed by one of the fleet's signers (§4). A broken-into server can write to its own copy. Every other host and every later run refuses that copy.
- **No secrets at rest on the servers.** Secrets are fetched per run with a token the client hands over for that run (§5). Nothing a peer stores lets it read the vault.

## 3. The repo on every server

- After each apply (and with `fornax fleet push`), every peer gets the fleet repo as a plain git repository: `/var/lib/fornax/fleet/` (root, 0700), history included, `.fornax/` left out as today.
- It is **not encrypted**. Anyone with root on a peer can read the whole fleet description: sites, firewall rules, gated paths, the other servers' config. It contains no secrets (only `op://…` references), and root on that server already sees its own part. **Everything in the repo's history ends up on every server.** Notes, to-do lists and post-mortems belong elsewhere, and the docs will say so.
- `fleet_copy` (the encrypted copy) keeps working. With `peers` on it becomes optional: a restore is `git clone root@any-peer:/var/lib/fornax/fleet` plus the signature check of §4.

## 4. Signatures (required)

```yaml
peers:
  signers:            # the only keys whose commits a host accepts (OpenSSH public key lines)
    - ssh-ed25519 AAAA… laptop (1Password)
    - ecdsa-sha2-nistp256 AAAA… phone (secure enclave)
    - sk-ssh-ed25519@openssh.com AAAA… hardware key
```

- **Signers are keys a person holds** (a laptop's agent, a phone's secure enclave, a hardware key). **A server is never a signer** and holds no signing key. Commits are signed with git's SSH signing (`gpg.format=ssh`), using the key in the agent the client forwarded, so a commit made on a host carries *your* signature. `ssh-keygen -Y sign` uses the agent when it is given only the public key. Breaking into a server later gives nothing to sign new commits with.
- **Every commit is checked, each against its parent's signer list.** Every host checks before it uses the repo. It walks every commit from the last trusted state up to the head. Each commit must verify (`git verify-commit`) against the allowed-signers file built from `peers.signers` **as it stands in that commit's parent**, never in the commit itself. A commit that adds a key cannot be signed by that key: the new key counts from the next commit on. Merge commits are refused (history is linear, fast-forward only).
- **Removing a signer** (a lost phone) is a commit signed by another signer. From then on, signatures by the removed key are refused. Older commits stay valid, because they were signed correctly at their time.
- **No rollback.** Each client remembers the last head it trusted (`~/.config/fornax/peers.json`, like `known_hosts`). A peer whose head is not a descendant of it is refused. A peer therefore cannot slip back an older state, for example one from before a key was removed. The first trusted commit (the trust anchor) is pinned the same way. A phone app pins it when it is paired, and the client sends it along, so the host verifies against the client's anchor and not against its own, possibly tampered, state.
- **A forwarded agent signs only what the run announced.** *(Phase 2, in the phone app; not in phase 1, where fornax's own forwarded agent signs whatever it is asked to sign, and with a hardware key every signature needs a touch.)* While a run is going on, a broken-into host could ask the forwarded agent for an extra signature, such as a commit adding its own key, or a login it was not meant to make. A hardware key's touch shows nothing about what is being signed. So a run announces up front what it will need (e.g. "1 commit, logins to web-1 and web-2"). A client that can enforce this (the phone app, a `fornax --on` wrapper agent) refuses everything else and reports it. The phone shows the commit message and its parent before it signs.
- **Trust changes get their own approval.** *(Phase 2, like the bullet above.)* A commit that changes `peers.signers` or `ssh.root_keys` is never signed as part of an ordinary run. It needs a separate approval that names the change, and the plan shows it at the top.
- An unsigned or wrongly signed commit is an error (`unsigned_fleet`), never a warning. The output names the commit, the peer it came from and the signature that is missing.
- Plans make changes to `ssh.root_keys`, `peers.signers` and the firewall stand out (a "trust" section at the top of the plan). *(Not built yet. `peers verify` and `peers sync` already mark commits that change signers or root keys.)*

## 5. Running on a peer

```bash
fornax --on web-1 plan web-2      # forwards your agent on a connection of its own
fornax --on web-1 apply <plan>
```

1. **Sync first.** The client brings the host's repo to the newest signed head (fetch, check, fast-forward, push), and the host checks it once more against the client's trusted state before it runs anything. Sync takes the newest head that is a fast-forward of all the others. If two peers have diverged, it stops (`fleet_diverged`) and names them. It never merges.
2. **Secrets for this run only.** The 1Password service-account token comes from the client on stdin (`fornax --on` reads it where the fleet config says, e.g. the client's keychain). It lives in the run's memory and in `op`'s environment, and is never written to disk.
3. **Root over the forwarded agent**, to other peers and to itself (over `127.0.0.1`). One run is one connection per server. The connection is closed when the run ends (`ssh -O exit`), so no approval outlives its run. The `ssh.keep_open` default stays for laptop runs.
4. **Commit, sign, push.** Changes the run makes (a new site, a converted value) are committed on the host, signed through the agent (git's `gpg.ssh.defaultKeyCommand` picks the forwarded key that is a signer). The client takes the commit back, checks it, and pushes it to every peer. A peer that is down gets them on the next sync.
5. **The existing apply lock** (`/run/lock/fornax-apply.lock` on each target) keeps two hosts from applying to the same server at once.

## 6. A host does not cut its own line

An apply that changes the host's own sshd, firewall, Tailscale or network config could drop the session that runs it, halfway through.

Built in phase 1:

- **Every run on a host is detached.** It runs in a session of its own (`setsid`) with its output in `/var/lib/fornax/runs/<run>/`. A dropped connection neither hangs it up nor breaks its pipes. `fornax --on <server> peers attach <run>` shows the rest of the output and the exit code.
- **A host reaches itself over `127.0.0.1`**, so a change to its firewall or to the tailnet does not cut the line to itself.
- **The limit, on purpose:** the forwarded agent ends with the connection. Connections the run had already opened go on (they are multiplexed and authenticated). One it tries to open after the drop fails. An apply opens its connection when it starts (the stale check), so it finishes. A run that goes on to further servers after the drop does not reach them.

Not built: picking another peer as host for changes to the host's own network. The loopback connection made that unnecessary for the cases tested.

## 7. Versions

A host runs the fornax binary installed on it. `requires:` in the fleet already refuses a binary that is too old. A peer host also refuses a fleet written by a newer fornax major version. Server binaries keep updating themselves before deploy and backup as they do today.

## 8. Config and commands (sketch)

```yaml
peers:
  enabled: true        # default false; 1.x keeps today's behaviour without it
  signers: [...]
  hosts: [web-1, web-2] # optional: which servers may act as host (default: all)
```

New commands:

- `fornax --on <server> …` runs any command on a peer.
- `fornax peers status` shows each peer's head: in sync, behind, empty, not set up, unreachable, or refused.
- `fornax peers sync`, `peers trust`, `peers verify`.
- `fornax --on <server> peers attach <run>` reattaches to a run.

Error codes: `unsigned_fleet`, `not_a_signer`, `fleet_rollback`, `fleet_diverged`, `no_trust_anchor`, `peer_push_failed`, `peer_push_refused`, `peer_dirty`, `no_peers`, `not_a_host`, `no_forwarded_agent`, `unknown_run`. An unreachable peer is a state in `peers status`, not an error.

## 9. Phase 1 — work and order

| # | Work | Estimate |
|---|---|---|
| 1 | Signature check: allowed-signers from the config, verify-commit over a range, trust anchor, `not_a_signer` for signer changes. Unit tests with throwaway keys | ½ day |
| 2 | Signed commits through the agent (git config per run, `ssh-keygen -Y sign` via `SSH_AUTH_SOCK`) | ¼ day |
| 3 | Repo on peers: push after apply / `fleet push`, sync (fetch all, fast-forward only, `fleet_diverged`) | ½ day |
| 4 | Running on a peer: `--on`, token on stdin, root over the forwarded agent, per-run connections | ½ day |
| 5 | Self-change rule: pick another host, detached apply + `attach` | ½ day |
| 6 | `fornax peers`, docs (`docs/peers.md`, config reference), CHANGELOG | ¼ day |
| 7 | OrbStack integration test: three peers; plan/apply from each; a forged unsigned commit on one peer is refused by the other two; diverged heads stop; a host applies a firewall change to itself (detached) | ½ day |

About **3 days**. Order: 1 → 2 → 3 → 4 → 7 (the core path tested) → 5 → 6.

## 10. Phase 2 — the phone (outline, not part of fornax)

A phone app with a key in the secure enclave (Face ID), an SSH client that forwards its agent, and an agent conversation (Claude API) whose only tool is "run `fornax …` on a peer". Every signature request shows up as a sheet with the server, the command and, for an apply, the plan summary and its hash. **One approval covers one fornax run**, never a period of time. About 4–5 days on top of phase 1. Push notifications are optional (the app open is enough).

## 11. Open questions

- *(Decided in phase 1: the client sends its trusted state, and the host checks against that, never against its own.)*
- *(Answered in phase 1, see §6: connections opened before the drop go on, later ones fail.)*
- An existing fleet whose history contains notes: offer `fornax fleet rebase-history` (a fresh signed root commit) before turning `peers` on, or leave that to git.
