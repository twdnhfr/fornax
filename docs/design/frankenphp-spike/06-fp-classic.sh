set -eux
mkdir -p /etc/fornax/frankenphp
cat > /etc/systemd/system/fornax-php@.service <<'U'
[Unit]
Description=FrankenPHP of site user %i (spike)
After=network.target

[Service]
Type=notify
User=%i
Group=%i
Environment=XDG_DATA_HOME=/var/lib/fornax-php/%i XDG_CONFIG_HOME=/var/lib/fornax-php/%i GODEBUG=cgocheck=0
ExecStartPre=+/usr/bin/chgrp caddy /run/fornax-php/%i
ExecStartPre=/usr/bin/frankenphp validate --config /etc/fornax/frankenphp/%i.caddyfile
ExecStart=/usr/bin/frankenphp run --config /etc/fornax/frankenphp/%i.caddyfile
ExecReload=/usr/bin/frankenphp reload --config /etc/fornax/frankenphp/%i.caddyfile --address unix//run/fornax-php/%i/admin.sock
RuntimeDirectory=fornax-php/%i
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=restart
StateDirectory=fornax-php/%i
StateDirectoryMode=0700
WorkingDirectory=/home/%i
Restart=on-failure
RestartSec=2
TimeoutStopSec=30
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
U
cat > /etc/fornax/frankenphp/sitea.caddyfile <<'C'
{
	admin unix//run/fornax-php/sitea/admin.sock
	auto_https off
	persist_config off
	frankenphp {
		num_threads 10
		php_ini memory_limit 512M
		php_ini opcache.memory_consumption 256
		php_ini opcache.max_accelerated_files 20000
	}
	log default {
		output stderr
		level WARN
	}
}
http://:8082 {
	root /home/sitea/sitea.test/current/public
	encode zstd gzip
	php_server
}
C
systemctl daemon-reload
systemctl restart fornax-php@sitea
sleep 1
systemctl is-active fornax-php@sitea
ps -o user,pid,rss,nlwp,cmd -C frankenphp
curl -s http://sitea.test:8082/hello; echo
curl -s -o /dev/null -w "%{http_code}\n" http://sitea.test:8082/up
