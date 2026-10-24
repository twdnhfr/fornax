set -eux
# debug route in both sites' current release + build app
for f in /home/build/app/routes/web.php /home/sitea/sitea.test/current/routes/web.php /home/siteb/siteb.test/current/routes/web.php; do
  grep -q '"/ip"' $f || cat >> $f <<'PHP'
Route::get("/ip", fn (\Illuminate\Http\Request $r) => response()->json(["ip" => $r->ip(), "secure" => $r->isSecure(), "host" => $r->getHost(), "url" => $r->fullUrl(), "remote_addr" => $_SERVER["REMOTE_ADDR"] ?? null, "xff" => $_SERVER["HTTP_X_FORWARDED_FOR"] ?? null, "xfp" => $_SERVER["HTTP_X_FORWARDED_PROTO"] ?? null, "user" => posix_getpwuid(posix_geteuid())["name"], "sapi" => PHP_SAPI]));
PHP
done
for u in sitea siteb; do sudo -u $u bash -c "cd /home/$u/$u.test/current && php artisan route:cache >/dev/null"; done
# worker shim for sitea exists; unit: admin socket in StateDirectory (0700), public sockets in RuntimeDirectory (0750, group caddy)
sed -i 's|^ExecReload=.*|ExecReload=/usr/bin/frankenphp reload --config /etc/fornax/frankenphp/%i.caddyfile --address unix//var/lib/fornax-php/%i/admin.sock|' /etc/systemd/system/fornax-php@.service
systemctl daemon-reload
cat > /etc/fornax/frankenphp/sitea.caddyfile <<'C'
{
	admin unix//var/lib/fornax-php/sitea/admin.sock
	auto_https off
	persist_config off
	servers {
		trusted_proxies_unix
	}
	frankenphp {
		php_ini memory_limit 512M
	}
	log default {
		output stderr
		level WARN
	}
}
# live site: Octane worker mode
http:// {
	bind unix//run/fornax-php/sitea/http.sock|0666
	root /home/sitea/sitea.test/current/public
	encode zstd gzip
	php_server {
		env APP_BASE_PATH /home/sitea/sitea.test/current
		env APP_PUBLIC_PATH /home/sitea/sitea.test/current/public
		env LARAVEL_OCTANE 1
		env MAX_REQUESTS 500
		worker {
			file /home/sitea/sitea.test/frankenphp-worker.php
			num 4
			match *
		}
	}
}
# preview of releases/next for the pre-activation health check: classic mode, root only
http://preview {
	bind unix//var/lib/fornax-php/sitea/preview.sock
	root /home/sitea/sitea.test/next/public
	php_server
}
C
cat > /etc/fornax/frankenphp/siteb.caddyfile <<'C'
{
	admin unix//var/lib/fornax-php/siteb/admin.sock
	auto_https off
	persist_config off
	servers {
		trusted_proxies_unix
	}
	frankenphp {
		num_threads 4
		php_ini memory_limit 512M
	}
	log default {
		output stderr
		level WARN
	}
}
# live site: classic mode
http:// {
	bind unix//run/fornax-php/siteb/http.sock|0666
	root /home/siteb/siteb.test/current/public
	encode zstd gzip
	php_server
}
C
for u in sitea siteb; do frankenphp validate --config /etc/fornax/frankenphp/$u.caddyfile 2>&1 | tail -1; systemctl restart fornax-php@$u; done
sleep 2
ls -la /run/fornax-php/ /run/fornax-php/sitea /var/lib/fornax-php/ /var/lib/fornax-php/sitea
# front caddy: TLS (internal issuer), reverse_proxy to the sockets, retries while a backend restarts
rm -f /etc/caddy/sites/sitea-fpm.caddy
cat > /etc/caddy/sites/sitea.test.caddy <<'C'
sitea.test {
	tls internal
	reverse_proxy unix//run/fornax-php/sitea/http.sock {
		lb_try_duration 10s
		lb_try_interval 100ms
	}
}
C
cat > /etc/caddy/sites/siteb.test.caddy <<'C'
siteb.test {
	tls internal
	reverse_proxy unix//run/fornax-php/siteb/http.sock {
		lb_try_duration 10s
		lb_try_interval 100ms
	}
}
C
caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -1
systemctl reload caddy
sleep 2
for s in sitea siteb; do curl -sk https://$s.test/ip; echo; done
