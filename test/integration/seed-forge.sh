#!/bin/bash
# Runs ON a provisioned test VM: turns it into a "Forge server" from the fixture tree
# (piped in as a tar on stdin), with users, releases and certificates where Forge puts them.
set -euo pipefail
tar -xz -C / --no-same-owner
# like Forge: an admin user "forge" that nginx runs as
id -u forge >/dev/null 2>&1 || useradd -m -s /bin/bash forge
sed -i 's/^user .*;/user forge;/' /etc/nginx/nginx.conf
for u in shop-ab12cd34 docs; do id -u $u >/dev/null 2>&1 || useradd -m -s /bin/bash $u; done
r=/home/shop-ab12cd34/shop.example.com
mkdir -p $r/releases/1/public $r/storage
echo '<?php echo "forge-shop";' > $r/releases/1/public/index.php
ln -sfn $r/releases/1 $r/current
mkdir -p /home/docs/docs.example.com/dist && echo 'forge docs' > /home/docs/docs.example.com/dist/index.html
chown -R shop-ab12cd34: /home/shop-ab12cd34; chown -R docs: /home/docs
# like Forge: homes readable for nginx, closed to the other site users
getent group isolated >/dev/null || groupadd isolated
for u in shop-ab12cd34 docs; do usermod -aG isolated $u; chmod 755 /home/$u; setfacl -m g:isolated:000 /home/$u; done
mkdir -p /home/shop-ab12cd34/.forge && chown shop-ab12cd34: /home/shop-ab12cd34/.forge
for c in 600/700:shop.example.com 602/701:docs.example.com; do
  d=/etc/nginx/ssl/domains/${c%%:*}; n=${c##*:}; mkdir -p $d
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj "/CN=$n" -keyout $d/server.key -out $d/server.crt 2>/dev/null
done
ln -sfn /etc/nginx/sites-available/shop.example.com /etc/nginx/sites-enabled/shop.example.com
ln -sfn /etc/nginx/sites-available/docs.example.com /etc/nginx/sites-enabled/docs.example.com
chmod 0644 /etc/crontab
# like Forge: its worker key next to everyone's own keys, its SSH rules, its cleanup job and PPA
for h in /root /home/forge /home/shop-ab12cd34 /home/docs; do
  mkdir -p $h/.ssh && printf '# Laravel Forge\nssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCfixture worker@forge.laravel.com\n' >> $h/.ssh/authorized_keys
  [ $h = /root ] || chown -R "$(basename $h):" $h/.ssh
done
if ufw status | grep -q 'Status: active'; then ufw allow from 159.203.150.232 to any port 22 >/dev/null; ufw allow from 192.0.2.10 to any port 22 >/dev/null; fi
printf '#!/usr/bin/env bash\n# Laravel Forge Provisioning Cleanup Script\n' > /root/forge-cleanup.sh
printf 'Types: deb\nURIs: https://ppa.launchpadcontent.net/laravelphp/forge/ubuntu/\nSuites: noble\nComponents: main\nEnabled: no\n' > /etc/apt/sources.list.d/laravelphp-ubuntu-forge-noble.sources
nginx -t -q && systemctl reload nginx
systemctl reload php8.4-fpm
supervisorctl reread >/dev/null && supervisorctl update >/dev/null || true
echo seeded
