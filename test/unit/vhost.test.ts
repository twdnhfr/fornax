import { describe, expect, test } from "bun:test";
import { forgeProxy, plainAlias, vhostExtras } from "../../src/forge/vhost.ts";

const siteConf = `add_header X-Frame-Options "SAMEORIGIN";
index index.html index.htm index.php;
charset utf-8;
include forge-conf/42/server/*;
location / {
    try_files $uri $uri/ /index.php?$query_string;
}
location ~ /\\.(?!well-known).* {
    deny all;
}
`;

const forgeVhost = (extraTop = "", extraServer = "") => `# FORGE CONFIG (DO NOT REMOVE!)
include forge-conf/42/before/*;
include forge-conf/42/app.example.com/before/*;
${extraTop}
server {
    http2 on;
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name app.example.com;
    server_tokens off;
    root /home/app/app.example.com/current/public;

    # FORGE SSL (DO NOT REMOVE!)
    ssl_certificate /etc/nginx/ssl/domains/1/2/server.crt;
    ssl_certificate_key /etc/nginx/ssl/domains/1/2/server.key;
${extraServer}
    include forge-conf/42/site.conf;
}

# FORGE CONFIG (DO NOT REMOVE!)
include forge-conf/42/after/*;
include forge-conf/42/app.example.com/after/*;
`;

describe("hand edits in Forge vhosts", () => {
  test("an untouched Forge vhost has nothing extra", () => {
    expect(vhostExtras(forgeVhost(), "app.example.com", siteConf)).toEqual({ http: [], server: [], problems: [] });
  });

  test("an IP allowlist (geo + map + if) comes along with its comments", () => {
    const x = vhostExtras(
      forgeVhost(
        `# only from the office
geo $office {
    default 0;
    203.0.113.0/24 1;
}
map $office $deny {
    default 1;
    1 0;
}`,
        `    # gate
    if ($deny) { return 403; }
    add_header X-Robots-Tag "noindex" always;
    location /admin {
        auth_basic "Admin";
        auth_basic_user_file /etc/nginx/.htpasswd-admin;
    }`,
      ),
      "app.example.com",
      siteConf,
    );
    expect(x.problems).toEqual([]);
    expect(x.http).toHaveLength(2);
    expect(x.http[0]).toStartWith("# only from the office\ngeo $office {");
    expect(x.server).toEqual([
      "# gate\nif ($deny) { return 403; }",
      'add_header X-Robots-Tag "noindex" always;',
      'location /admin {\n    auth_basic "Admin";\n    auth_basic_user_file /etc/nginx/.htpasswd-admin;\n}',
    ]);
  });

  test("an older vhost with Forge's config inline counts that config as Forge's", () => {
    const inline = forgeVhost("", siteConf.replace(/^/gm, "    "));
    expect(vhostExtras(inline, "app.example.com", siteConf).server).toEqual([]);
  });

  test("a second server block that is not a redirect is a problem, whatever its name", () => {
    const x = vhostExtras(forgeVhost("server {\n    listen 8080;\n    server_name app.example.com;\n    location / { proxy_pass http://127.0.0.1:9000; }\n}"), "app.example.com", siteConf);
    expect(x.problems).toHaveLength(1); // a proxy on another port of the same name would be lost too
    const y = vhostExtras(forgeVhost("server {\n    listen 8080;\n    server_name stats.example.com;\n    location / { proxy_pass http://127.0.0.1:9000; }\n}"), "app.example.com", siteConf);
    expect(y.problems[0]).toContain("stats.example.com");
  });

  test("an alias vhost is folded in only when it serves the same root and nothing else", () => {
    const root = "/home/app/app.example.com/current/public";
    const same = forgeVhost().replace("server_name app.example.com", "server_name app.example.net");
    expect(plainAlias(same, "app.example.net", root, siteConf)).toBeNull();
    const ws = `server {
    listen 443 ssl;
    server_name ws.app.example.com;
    ssl_certificate /etc/nginx/ssl/x.crt;
    ssl_certificate_key /etc/nginx/ssl/x.key;
    location / {
        proxy_pass http://0.0.0.0:8080;
    }
}`;
    expect(plainAlias(ws, "ws.app.example.com", root, siteConf)).toContain("proxy");
  });
});

describe("Forge's websocket vhost", () => {
  const ws = `include forge-conf/42/ws.app.example.com/before/*;
server {
    http2 on;
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ws.app.example.com;
    server_tokens off;
    ssl_certificate /etc/nginx/ssl/domains/9/9/server.crt;
    ssl_certificate_key /etc/nginx/ssl/domains/9/9/server.key;
    add_header X-Frame-Options "SAMEORIGIN";
    charset utf-8;
    include forge-conf/42/server/*;
    access_log off;
    error_log  /var/log/nginx/ws.app.example.com-error.log error;
    location / {
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";

        proxy_pass http://0.0.0.0:8080;
    }
    location ~ /\\.(?!well-known).* {
        deny all;
    }
}`;
  test("is recognised as a proxy with its port and certificate", () => {
    expect(forgeProxy(ws, "ws.app.example.com", siteConf)).toEqual({ host: "0.0.0.0", port: 8080, cert: "/etc/nginx/ssl/domains/9/9/server.crt", key: "/etc/nginx/ssl/domains/9/9/server.key" });
  });
  test("anything beyond the proxy keeps it from being converted", () => {
    expect(forgeProxy(ws.replace("    access_log off;", "    access_log off;\n    if ($x) { return 403; }"), "ws.app.example.com", siteConf)).toBeNull();
    expect(forgeProxy(ws.replace("proxy_pass http://0.0.0.0:8080;", "proxy_pass http://10.0.0.5:8080;"), "ws.app.example.com", siteConf)).toBeNull();
  });
});
