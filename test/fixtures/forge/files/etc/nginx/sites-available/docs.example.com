# FORGE CONFIG (DO NOT REMOVE!)
include forge-conf/docs.example.com/before/*;

server {
    http2 on;
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name docs.example.com;
    server_tokens off;
    root /home/docs/docs.example.com/dist;

    # FORGE SSL (DO NOT REMOVE!)
    ssl_certificate /etc/nginx/ssl/domains/602/701/server.crt;
    ssl_certificate_key /etc/nginx/ssl/domains/602/701/server.key;

    include forge-conf/docs.example.com/site.conf;
}
