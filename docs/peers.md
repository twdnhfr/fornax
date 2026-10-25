# Every server a host — peers

With **peers**, every server carries the fleet repo and fornax, so plan and apply run on any of them: for itself and for the others. Your laptop becomes one host among several. When it is far away, or when one server is down, another server does the work. The design and its reasoning are in [design/peers.md](design/peers.md).

```bash
fornax --on web-1 plan web-2          # runs on web-1, with your key forwarded
fornax --on web-1 apply <plan>
fornax --on web-2 site add shop.example.com --repo acme/shop   # the change is committed on web-2, signed
fornax peers status                   # every server's copy: head, signatures, behind or not
```

## The rule it rests on

**Any server can be a host, but no server has power over another.**

- A host reaches root on another server, and on itself, only through the **SSH agent your machine forwards** for that one run. Servers hold no keys to each other, so breaking into one server gives no way onto the next. `fornax --on` starts an agent of its own with the key fornax logs in with (a security key asks for its PIN and a touch as usual) and closes every connection the host opened when the run ends.
- **No commit is trusted because of where it lies.** Every commit must be signed by one of `peers.signers`, and it is checked against the signers of the commit **before** it. A key that a commit adds cannot sign that same commit, and a removed key stops counting from the commit that removes it. A server is never a signer: commits made on a host are signed with your key through the forwarded agent.
- **Only the login key travels, and every use of it is yours.** `fornax --on` forwards an agent of its own that holds only the key fornax logs in with — never your personal agent. A security key needs its touch for every signature anyway; a key file or `ssh.key` is added with confirmation, so every use on the host asks you first.
- **What a host commits waits for you.** A commit made on a host is signed with your login key through the forwarded agent — and a touch on a security key shows nothing of what it signs. A host that was broken into could have had anything signed, and any change to the fleet becomes root on some server at the next apply. So a commit from a server signed with a key that logs in as root (`ssh.root_keys`; with none named, any key) is never taken over on its own. `fornax --on` shows you the diff in the terminal and asks; without a terminal it says so, and `fornax peers sync --accept` takes it after you looked at it (`git log -p`). Commits you sign on your own machine with a key that never travels (your laptop's signing key) pass.
- **No secrets at rest, and the host knows nobody new.** The 1Password service-account token travels to the host on stdin for the one run and is never written to its disk. Give hosts a service account of their own, limited to what plans and applies need (`peers.service_account`): a host broken into while it runs could read the token. The host checks every server it connects to against the host keys your machine knows (sent along with the run) and refuses any other. Connections the run opened are closed when it ends; nothing stays open on the host.
- **No rollback.** Your machine remembers the last state it trusted (`~/.config/fornax/peers.json`, like `known_hosts`). A server whose history does not descend from that state is refused, so a server cannot slip back an older state, for example one from before a key was removed.

## Setting it up

1. **Sign your commits** to the fleet repo with an SSH key (`git config gpg.format ssh`, `user.signingkey`, `commit.gpgsign true`). Commits that a host makes are signed with the key fornax logs in with, so that key is a signer too.
2. **Name the signers** in `fornax.yaml` and commit it signed:

   ```yaml
   peers:
     enabled: true
     signers:
       - ssh-ed25519 AAAA… laptop
       - sk-ssh-ed25519@openssh.com AAAA… hardware key   # the key that logs in as root
   ```

3. **Pin where trust starts** on your machine, after you have looked at the history: `fornax peers trust`. Do this on every machine you run fornax from.
4. **Plan and apply each server.** The apply installs git, fornax and — when the fleet keeps its secrets in 1Password — the 1Password CLI (from 1Password's signed apt repository; no token or login stays on the server), creates the repo at `/var/lib/fornax/fleet`, and passes the fleet on. `fornax peers sync` does that at any time.
5. **Let the servers reach each other's SSH.** With `access: tailscale`, `fornax tailnet sync` adds a rule for that (servers to servers, the SSH port only). With `access: ssh`, the firewall's `ssh_from` must let the other servers in. Root there still needs the key you forward.

A host applies its own build of fornax to servers of its architecture. For a server of the other one it downloads the signed release of its version from GitHub (checked like `self-update`); if there is none, the server's fornax stays as it is.

**Everything in the repo's history ends up on every server**, unencrypted (root only). The fleet config holds no secrets, only references such as `op://…`. Keep notes, to-do lists and anything else you would not leave on a server out of the fleet repo, including its history.

## Commands

| | |
| --- | --- |
| `fornax --on <server> <command …>` | run any fornax command on that server. The fleet repo there is brought up to date first. Afterwards, what the command changed is committed there (signed through your agent), and that commit comes back to your machine, checked |
| `fornax peers trust [commit]` | pin the commit trust starts from (default `HEAD`) |
| `fornax peers verify [rev]` | check every commit since the trusted state; when they all hold, move the trusted state forward |
| `fornax peers status` | each server's head: `in sync`, `behind`, `empty`, `not set up`, `unreachable`, or `REFUSED` (a commit there is not signed by a signer) |
| `fornax peers sync` | bring your machine and every server to the newest signed state. It only fast-forwards; two histories that went different ways stop it (`fleet_diverged`). Commits from a server signed with a login key wait for `--accept` |
| `fornax --on <server> peers attach <run>` | follow a run after the connection dropped |

## A host and its own network

A run on a host goes on when the connection to it drops: the host starts the command in a session of its own and keeps its output in `/var/lib/fornax/runs/<run>/`. A host reaches itself over `127.0.0.1`, so an apply that changes its own firewall or the tailnet does not cut the line it runs on. `fornax --on <server> peers attach <run>` shows the rest of the output and the exit code.

Your key goes away with the connection: connections the run had already opened go on, but one it would open after the drop fails. An apply opens its connection when it starts, so it finishes.

A run's output stays on the host only until it was delivered: `fornax --on` confirms it got it, and the host removes the run. A run nobody attached to is removed after a week. `env pull` refuses to run on a host — the copy of the `.env` would stay on that server. Commit messages a host writes name the command, not its options.

## On the server

| | |
| --- | --- |
| `/var/lib/fornax/fleet/` | the fleet repo (root, 0700). Fast-forwards only, and its `pre-receive` hook refuses commits that are not signed by a signer |
| `/var/lib/fornax/runs/<run>/` | a run started with `fornax --on`, until its output was delivered: command words, output, exit code, the host keys sent along |
| `/run/fornax/cm/<run>/` | the run's connections to servers, closed when it ends |
