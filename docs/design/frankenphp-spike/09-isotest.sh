t(){ printf '%-72s ' "$1"; shift; out=$("$@" 2>&1 | head -c 160 | tr '\n' ' '); echo "=> ${out:-<empty>}"; }
t "siteb reads sitea .env"                         sudo -u siteb cat /home/sitea/sitea.test/.env
t "siteb lists /home/sitea"                        sudo -u siteb ls /home/sitea
t "siteb connects to sitea's HTTP socket"          sudo -u siteb curl -s --unix-socket /run/fornax-php/sitea.sock http://x/ip
t "siteb reaches sitea's admin API"                sudo -u siteb curl -s --unix-socket /var/lib/fornax-php/sitea/admin.sock http://localhost/config/
t "siteb reads sitea's preview socket dir"         sudo -u siteb ls /var/lib/fornax-php/sitea
t "caddy (front) reads sitea .env"                 sudo -u caddy cat /home/sitea/sitea.test/.env
t "root reaches sitea admin API (fornax)"          curl -s -o /dev/null -w "%{http_code}" --unix-socket /var/lib/fornax-php/sitea/admin.sock http://localhost/config/
# symlink plant: siteb links its public file to sitea's .env and a world-readable file of sitea
sudo -u siteb ln -sfn /home/sitea/sitea.test/.env /home/siteb/siteb.test/current/public/steal-env.txt
sudo -u siteb ln -sfn /home/sitea/sitea.test/current/composer.json /home/siteb/siteb.test/current/public/steal-composer.json
t "HTTPS siteb.test/steal-env.txt (symlink to sitea/.env)"  curl -sk -o /dev/null -w "%{http_code}" https://siteb.test/steal-env.txt
t "HTTPS siteb.test/steal-composer.json (sitea code file)"  curl -sk -o /dev/null -w "%{http_code}" https://siteb.test/steal-composer.json
# /tmp: PrivateTmp per site process
sudo -u sitea bash -c 'echo secret > /tmp/sitea-cli-file; chmod 644 /tmp/sitea-cli-file'
t "sitea's PHP /tmp is private (PrivateTmp): ls /tmp of sitea process"  bash -c 'ls /proc/$(systemctl show -p MainPID --value fornax-php@sitea)/root/tmp | head -3'
