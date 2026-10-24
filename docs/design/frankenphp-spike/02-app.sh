set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq nginx wrk >/dev/null
systemctl stop nginx; systemctl disable nginx
cd /tmp
curl -fsSL https://getcomposer.org/installer -o cs.php && php cs.php --quiet --install-dir=/usr/local/bin --filename=composer && rm cs.php
# oha
curl -fsSL -o /usr/local/bin/oha https://github.com/hatoo/oha/releases/latest/download/oha-linux-arm64 && chmod +x /usr/local/bin/oha
oha --version
# base app built once, as user "build"
id build || useradd -m -s /bin/bash build
sudo -u build bash -lc 'cd ~ && COMPOSER_NO_INTERACTION=1 composer create-project --prefer-dist --no-progress laravel/laravel app 2>&1 | tail -3'
sudo -u build bash -lc 'cd ~/app && php artisan --version && cat >> routes/web.php <<PHP

Route::get("/hello", fn () => "hello from ".app()->version());
PHP
sed -i "s/^APP_ENV=.*/APP_ENV=production/; s/^APP_DEBUG=.*/APP_DEBUG=false/; s/^SESSION_DRIVER=.*/SESSION_DRIVER=file/; s/^CACHE_STORE=.*/CACHE_STORE=file/" .env
php artisan optimize'
