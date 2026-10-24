set -euxo pipefail
mkdir -p /etc/caddy/sites
cat > /etc/caddy/Caddyfile <<'C'
{
	admin unix//run/caddy/admin.sock
	# local spike: no public ACME
	local_certs
	log default {
		output stderr
		level WARN
	}
}
import /etc/caddy/sites/*.caddy
C
cat > /etc/caddy/sites/sitea-fpm.caddy <<'C'
http://sitea.test:8081 {
	root * /home/sitea/sitea.test/current/public
	encode zstd gzip
	php_fastcgi unix//run/php/php8.4-fpm-sitea.sock {
		resolve_root_symlink
	}
	file_server
}
C
mkdir -p /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/admin.conf <<'U'
[Service]
RuntimeDirectory=caddy
RuntimeDirectoryMode=0750
U
systemctl daemon-reload
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -2
systemctl restart caddy
sleep 1
systemctl is-active caddy
grep -q sitea.test /etc/hosts || echo "127.0.0.1 sitea.test siteb.test" >> /etc/hosts
curl -s -o /dev/null -w "%{http_code}\n" http://sitea.test:8081/hello
curl -s http://sitea.test:8081/hello; echo
# nginx baseline like fornax's vhost (same pool; nginx user must reach the socket -> www-data in caddy group)
usermod -aG caddy www-data
cat > /etc/nginx/sites-enabled/default <<'N'
server {
    listen 8080;
    server_name sitea.test;
    root /home/sitea/sitea.test/current/public;
    index index.php;
    disable_symlinks if_not_owner;
    access_log off;
    location / { try_files $uri $uri/ /index.php?$query_string; }
    location ~ \.php$ {
        fastcgi_pass unix:/run/php/php8.4-fpm-sitea.sock;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        fastcgi_param DOCUMENT_ROOT $realpath_root;
        fastcgi_buffers 32 32k;
        fastcgi_buffer_size 64k;
    }
}
N
nginx -t -q && systemctl enable --now nginx && systemctl restart nginx
curl -s http://sitea.test:8080/hello; echo
