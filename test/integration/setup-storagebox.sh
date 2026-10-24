#!/bin/bash
# Runs ON a test VM: makes it behave like a Hetzner Storage Box for fornax — SSH/SFTP on port 23,
# password login for the box user, and the `install-ssh-key` command.
# Usage: setup-storagebox.sh <user> <password>
set -euo pipefail
u="$1"; pw="$2"
id -u "$u" >/dev/null 2>&1 || useradd -m -s /bin/bash "$u"
echo "$u:$pw" | chpasswd
cat > /usr/local/bin/install-ssh-key <<'SH'
#!/bin/sh
mkdir -p "$HOME/.ssh" && cat >> "$HOME/.ssh/authorized_keys" && chmod 700 "$HOME/.ssh" && chmod 600 "$HOME/.ssh/authorized_keys"
SH
chmod 755 /usr/local/bin/install-ssh-key
cat > /etc/ssh/sshd_config.d/10-storagebox.conf <<CONF
Port 22
Port 23
Match User $u
    PasswordAuthentication yes
    KbdInteractiveAuthentication yes
CONF
systemctl daemon-reload
systemctl restart ssh.socket 2>/dev/null || true
systemctl restart ssh
for i in $(seq 20); do ss -tln | grep -q ':23 ' && break; sleep 0.5; done
ss -tln | grep -q ':23 ' && echo "storage box ready"
