set -eux
VERSION=84
install -d /etc/apt/keyrings
curl -fsSL https://pkg.henderkes.com/api/packages/${VERSION}/debian/repository.key -o /etc/apt/keyrings/static-php${VERSION}.asc
echo "deb [signed-by=/etc/apt/keyrings/static-php${VERSION}.asc] https://pkg.henderkes.com/api/packages/${VERSION}/debian php-zts main" > /etc/apt/sources.list.d/static-php${VERSION}.list
apt-get update -qq 2>&1 | tail -2
apt-cache policy frankenphp | head -8
apt-cache show frankenphp | grep -E "^(Version|Depends|Conflicts|Provides|Replaces)" | head -10
