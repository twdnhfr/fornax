set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq software-properties-common curl gnupg debian-keyring debian-archive-keyring apt-transport-https unzip git acl jq
add-apt-repository -y ppa:ondrej/php
# caddy official repo (cloudsmith)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq php8.4-fpm php8.4-cli php8.4-mbstring php8.4-xml php8.4-curl php8.4-zip php8.4-bcmath php8.4-intl php8.4-sqlite3 php8.4-opcache caddy
caddy version
php -v
