# Every server a host — the fleet repo on every server, signed

Status: **planned (phase 1 of 2), 2026-10-25.** Not built yet. Phase 1 is fornax itself and works from any machine with `ssh -A`. Phase 2 is a phone app that holds the key and talks to an agent, and builds on phase 1. It is outlined at the end and is not part of fornax.

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
- **A forwarded agent signs only what the run announced.** While a run is going on, a broken-into host could ask the forwarded agent for an extra signature, such as a commit adding its own key, or a login it was not meant to make. A hardware key's touch shows nothing about what is being signed. So a run announces up front what it will need (e.g. "1 commit, logins to web-1 and web-2"). A client that can enforce this (the phone app, a `fornax --on` wrapper agent) refuses everything else and reports it. The phone shows the commit message and its parent before it signs.
- **Trust changes get their own approval.** A commit that changes `peers.signers` or `ssh.root_keys` is never signed as part of an ordinary run. It needs a separate approval that names the change, and the plan shows it at the top.
- An unsigned or wrongly signed commit is an error (`unsigned_fleet`), never a warning. The output names the commit, the peer it came from and the signature that is missing.
- Plans make changes to `ssh.root_keys`, `peers.signers` and the firewall stand out (a "trust" section at the top of the plan).

## 5. Running on a peer

```bash
ssh -A root@web-1 fornax plan            # or: fornax --on web-1 plan (does the ssh -A for you)
ssh -A root@web-1 fornax apply
```

1. **Sync first.** The host fetches the repo from every peer it can reach, verifies the signatures (§4), and moves to the newest head that is a fast-forward of all of them. If two peers have diverged, it stops (`fleet_diverged`) and names them. It never merges.
2. **Secrets for this run only.** The 1Password service-account token comes from the client on stdin (`--secrets-from-stdin`; `fornax --on` sends it from the client's keychain). It lives in the run's memory and in `op`'s environment, and is never written to disk.
3. **Root over the forwarded agent**, to other peers and to itself (as `root@<own tailnet or public address>`). One run is one connection per server. The connection is closed when the run ends (`ssh -O exit`), so no approval outlives its run. The `ssh.keep_open` default stays for laptop runs.
4. **Commit, sign, push.** Changes the run makes (a new site, a converted value) are committed on the host, signed through the agent and pushed to every peer. A peer that is down gets them on the next sync.
5. **The existing apply lock** (`/run/lock/fornax-apply.lock` on each target) keeps two hosts from applying to the same server at once.

## 6. A host does not cut its own line

An apply that changes the host's own sshd, firewall, Tailscale or network config could drop the session that runs it, halfway through.

- If such a change is planned for the host itself, fornax prefers **another peer as the host** for that server and says so (`fornax --on` picks it). The plan prints which peer will run it.
- If there is no other peer, the apply runs **detached** (`systemd-run --unit fornax-apply-<id>`, output to `/var/log/fornax/`). The client reattaches with `fornax attach <id>`. The forwarded agent is only needed up to the moment the target script has started.

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
- `fornax peers` shows each peer's head, whether its signatures verify, whether it is reachable, and its version.
- `fornax attach <id>` reattaches to a detached run.

Error codes: `unsigned_fleet`, `fleet_diverged`, `peer_unreachable` (a warning on sync, an error only if no peer is left), `not_a_signer`.

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

- Should a client be able to require that a host verifies the **client's** pinned trust anchor too? This matters when a host's local state is the thing that was tampered with. Leaning: yes. The client sends the anchor and the host verifies against it, not against its own state.
- Detached apply and the agent: the agent is gone once the client is. Every connection a detached run needs must be opened before the client detaches. That is fine for one target; check it for a run that spans several servers.
- An existing fleet whose history contains notes: offer `fornax fleet rebase-history` (a fresh signed root commit) before turning `peers` on, or leave that to git.
