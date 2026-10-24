# Root only with a hardware key

By default, whoever sits at your unlocked laptop (or runs code there) is root on every server — the SSH key or the tailnet trusts the machine. A FIDO2 key (YubiKey and the like) moves that trust to a thing you plug in, unlock with a PIN and touch:

```bash
ssh-keygen -t ed25519-sk -O resident -O verify-required -f ~/.ssh/id_ed25519_sk_fornax   # macOS: brew install openssh first
```

```yaml
ssh:
  security_key: ~/.ssh/id_ed25519_sk_fornax   # the handle ssh-keygen wrote (no secret in it)
  root_keys:                                  # root's authorized_keys, exactly — add a backup key here
    - verify-required sk-ssh-ed25519@openssh.com AAAA… me yubikey   # verify-required: sshd insists on the PIN
tailscale:
  ssh_server: false   # root through sshd with root_keys, not Tailscale SSH (needs root_keys)
```

fornax asks for the PIN — in a dialog on macOS, on the terminal elsewhere — and says when to touch the key; one connection per server is kept open for `ssh.keep_open` (default `10m`), so a run needs one touch per server — longer means fewer touches, and longer that anything running as you can use the open connection. On another machine, `ssh-keygen -K` loads the handle from the key itself. Lose the key without a second one in `root_keys` and the way back in is the provider's rescue system. A server's own `ssh.root_keys` (in `servers/<name>.yaml`) come on top of the fleet's — say, the key of a panel that still manages that one server.

## Working as a site's user

Every site runs as a Linux user of its own (group `isolated`, its home closed to other sites). Site users have no SSH login: you come in as root — with the security key — and fornax drops to the site's user, in the site's directory, with `php` meaning the site's PHP version (composer follows it):

```bash
fornax shell shop.example.com                                  # interactive
fornax run shop.example.com -- php artisan migrate:status      # one command; exits with its exit code
fornax run shop.example.com -- 'grep ERROR storage/logs/laravel.log | tail -n 5'   # bash reads it, like ssh
```

`run` gives the command no stdin (a question it asks gets end-of-file); use `shell` for anything interactive.
