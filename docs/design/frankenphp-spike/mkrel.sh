#!/bin/bash
# mkrel <user> <ts> [switch] — fornax-like release: copy build, link shared, optimize, optionally switch current
set -euo pipefail
u=$1; ts=$2; root=/home/$u/$u.test; dir=$root/releases/$ts
rsync -a --chown=$u:$u --exclude storage --exclude .env /home/build/app/ $dir/
echo "$ts" > $dir/RELEASE; chown $u:$u $dir/RELEASE
sudo -u $u bash -c "cd $dir && ln -sfn $root/.env .env && ln -sfn $root/storage storage && php artisan optimize >/dev/null"
if [ "${3:-}" = switch ]; then sudo -u $u bash -c "ln -sfn $dir $root/current.tmp && mv -Tf $root/current.tmp $root/current"; fi
echo "release $ts ready${3:+, switched}"
