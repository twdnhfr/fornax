# FORGE CONFIG (DO NOT REMOVE!)
include forge-conf/200/before/*;
include forge-conf/200/shop.example.com/before/*;

# hand edit on the server: a kill switch for testers
map $http_x_kill $shop_kill {
    default 0;
    "yes"   1;
}

server {
    http2 on;
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name shop.example.com shop.example.net;
    server_tokens off;
    root /home/shop-ab12cd34/shop.example.com/current/public;

    # FORGE SSL (DO NOT REMOVE!)
    ssl_certificate /etc/nginx/ssl/domains/600/700/server.crt;
    ssl_certificate_key /etc/nginx/ssl/domains/600/700/server.key;

    # hand edit
    if ($shop_kill) { return 418; }

    include forge-conf/200/site.conf;
}

# FORGE CONFIG (DO NOT REMOVE!)
include forge-conf/200/after/*;
include forge-conf/200/shop.example.com/after/*;
