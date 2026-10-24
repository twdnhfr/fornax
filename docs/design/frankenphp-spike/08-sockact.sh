set -eux
cat > /etc/systemd/system/fornax-php@.socket <<'U'
[Unit]
Description=HTTP socket of site user %i (spike)

[Socket]
ListenStream=/run/fornax-php/%i.sock
SocketUser=%i
SocketGroup=caddy
SocketMode=0660
DirectoryMode=0755
Service=fornax-php@%i.service

[Install]
WantedBy=sockets.target
U
# service: no RuntimeDirectory games any more
sed -i '/^ExecStartPre=+\/usr\/bin\/chgrp/d; /^RuntimeDirectory/d' /etc/systemd/system/fornax-php@.service
sed -i 's|^\[Unit\]|[Unit]\nRequires=fornax-php@%i.socket\nAfter=fornax-php@%i.socket|' /etc/systemd/system/fornax-php@.service
cat /etc/systemd/system/fornax-php@.service
for u in sitea siteb; do sed -i "s#bind unix//run/fornax-php/$u/http.sock|0666#bind fd/3#" /etc/fornax/frankenphp/$u.caddyfile; done
sed -i 's#unix//run/fornax-php/sitea/http.sock#unix//run/fornax-php/sitea.sock#' /etc/caddy/sites/sitea.test.caddy
sed -i 's#unix//run/fornax-php/siteb/http.sock#unix//run/fornax-php/siteb.sock#' /etc/caddy/sites/siteb.test.caddy
systemctl daemon-reload
for u in sitea siteb; do systemctl stop fornax-php@$u; rm -rf /run/fornax-php/$u; systemctl enable --now fornax-php@$u.socket; systemctl start fornax-php@$u; done
systemctl reload caddy
sleep 2
ls -la /run/fornax-php/
for s in sitea siteb; do curl -sk https://$s.test/ip; echo; done
