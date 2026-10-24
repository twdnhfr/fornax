set -euxo pipefail
groupadd -f isolated
mk_site() {  # user
  u=$1; root=/home/$u/$u.test
  id $u || useradd -m -s /bin/bash $u
  usermod -aG isolated $u
  chmod 755 /home/$u; setfacl -m g:isolated:000 /home/$u
  ts=20261024000001
  sudo -u $u mkdir -p $root/releases $root/storage
  rsync -a --chown=$u:$u --exclude storage --exclude .env /home/build/app/ $root/releases/$ts/
  rsync -a --chown=$u:$u /home/build/app/storage/ $root/storage/
  install -o $u -g $u -m 0640 /home/build/app/.env $root/.env
  sudo -u $u bash -c "cd $root/releases/$ts && ln -sfn $root/.env .env && ln -sfn $root/storage storage && ln -sfn $root/releases/$ts $root/current && php artisan optimize >/dev/null"
}
mk_site sitea
mk_site siteb
# FPM pool for sitea, like fornax's poolConf (listen owner = web server user)
cat > /etc/php/8.4/fpm/pool.d/sitea.conf <<P
[sitea]
user = sitea
group = sitea
listen = /run/php/php8.4-fpm-sitea.sock
listen.owner = caddy
listen.group = caddy
listen.mode = 0660
pm = dynamic
pm.max_children = 10
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
pm.max_requests = 1000
P
rm -f /etc/php/8.4/fpm/pool.d/www.conf
cat > /etc/php/8.4/fpm/conf.d/90-fornax.ini <<I
memory_limit = 512M
opcache.enable = 1
opcache.memory_consumption = 256
opcache.max_accelerated_files = 20000
opcache.validate_timestamps = 1
opcache.revalidate_freq = 2
I
systemctl restart php8.4-fpm
ls -la /run/php/
ls -la /home/sitea/sitea.test /home/sitea/sitea.test/current/
