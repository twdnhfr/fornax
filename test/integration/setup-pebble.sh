#!/bin/bash
# Runs ON the test VM: Pebble (Let's Encrypt's ACME test server) on :14000, so the
# letsencrypt issuer can be tested end to end without touching real Let's Encrypt.
# Usage: setup-pebble.sh <arch> <hostname>...   (hostnames are mapped to 127.0.0.1)
set -euo pipefail
arch="$1"; shift
v=v2.10.1
d=/opt/pebble
if [ ! -x $d/pebble ]; then
  mkdir -p $d && cd $d
  curl -fsSL "https://github.com/letsencrypt/pebble/releases/download/$v/pebble-linux-$arch.tar.gz" | tar -xz
  find . -type f -name pebble -exec mv {} $d/pebble \; ; chmod +x $d/pebble
  for f in test/certs/localhost/cert.pem test/certs/localhost/key.pem test/certs/pebble.minica.pem; do
    curl -fsSL "https://raw.githubusercontent.com/letsencrypt/pebble/$v/$f" -o "$d/$(basename $f)"
  done
fi
cat > $d/config.json <<JSON
{"pebble":{"listenAddress":"0.0.0.0:14000","managementListenAddress":"127.0.0.1:15000","certificate":"$d/cert.pem","privateKey":"$d/key.pem","httpPort":80,"tlsPort":443,"ocspResponderURL":"","externalAccountBindingRequired":false}}
JSON
for h in "$@"; do grep -qE "^127\.0\.0\.1 $h\$" /etc/hosts || echo "127.0.0.1 $h" >> /etc/hosts; done
cat > /etc/systemd/system/pebble.service <<UNIT
[Unit]
Description=Pebble ACME test server
[Service]
Environment=PEBBLE_VA_NOSLEEP=1 PEBBLE_WFE_NONCEREJECT=0
ExecStart=$d/pebble -config $d/config.json
UNIT
# Pebble keeps no state across restarts: drop accounts certbot registered with an earlier instance.
rm -rf /etc/letsencrypt/accounts/localhost:14000
systemctl daemon-reload; systemctl restart pebble
for i in $(seq 20); do curl -s --cacert $d/pebble.minica.pem https://localhost:14000/dir >/dev/null && break; sleep 0.5; done
echo "pebble ready: https://localhost:14000/dir"
