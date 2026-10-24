#!/bin/bash
# preview <user> <release-ts> <path>  — what `fornax release` would do: boot the NEW release in worker mode, privately, check, stop
u=$1; ts=$2; path=$3; R=/home/$u/$u.test; rel=$R/releases/$ts
cfg=/run/fornax-preview-$u.caddyfile; sock=/var/lib/fornax-php/$u/preview.sock
cat > $cfg <<C
{
	admin off
	auto_https off
	persist_config off
	frankenphp {
		num_threads 1
	}
	log default {
		output discard
	}
}
http:// {
	bind unix/$sock
	root $rel/public
	php_server {
		env APP_BASE_PATH $rel
		env APP_PUBLIC_PATH $rel/public
		env LARAVEL_OCTANE 1
		env HTTPS on
		worker {
			file $rel/public/frankenphp-worker.php
			num 1
			match *
		}
	}
}
C
chmod 644 $cfg
t0=$(date +%s%N)
setpriv --reuid=$(id -u $u) --regid=$(id -g $u) --init-groups -- env -i HOME=/home/$u XDG_DATA_HOME=/var/lib/fornax-php/$u XDG_CONFIG_HOME=/var/lib/fornax-php/$u /usr/bin/frankenphp run --config $cfg >/tmp/preview-$u.log 2>&1 &
pid=$!
for i in $(seq 100); do [ -S $sock ] && break; sleep 0.05; done
code=000; for i in 1 2 3; do code=$(curl -s -o /tmp/preview-body -w "%{http_code}" --max-time 10 --unix-socket $sock http://$u.test$path); [ "$code" = 200 ] && break; sleep 1; done
t1=$(date +%s%N)
kill $pid; wait $pid 2>/dev/null; rm -f $cfg $sock
echo "preview $u release $ts $path: HTTP $code in $(( (t1-t0)/1000000 )) ms, body: $(head -c 80 /tmp/preview-body)"
