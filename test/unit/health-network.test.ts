import { describe, expect, test } from "bun:test";
import { unusualListeners } from "../../src/commands/health.ts";

describe("listening sockets", () => {
  const lines = [
    "tcp 0.0.0.0:80 nginx",
    "tcp [::]:443 nginx",
    "tcp 0.0.0.0:22 systemd",
    "tcp 127.0.0.1:5432 postgres",
    "tcp [::1]:6379 redis-server",
    "tcp 127.0.0.53%lo:53 systemd-resolve",
    "tcp 100.103.84.10%tailscale0:62969 tailscaled",
    "udp 0.0.0.0:41641 tailscaled",
    "udp 203.0.113.47%eth0:68 systemd-network",
    "tcp 0.0.0.0:13715 node",
    "tcp [::]:13715 node",
    "tcp 0.0.0.0:8080 php8.4",
    "tcp 0.0.0.0:25565 java",
    "udp [fe80::1]%if4:53 pihole-FTL",
  ];
  test("the web server, SSH, Tailscale, DHCP and loopback are expected; anything else is reported once", () => {
    expect(unusualListeners(lines, []).map((l) => `${l.proc}:${l.port}`)).toEqual(["node:13715", "php8.4:8080", "java:25565"]);
  });
  test("ports opened on purpose in firewall.allow are not unusual", () => {
    expect(unusualListeners(lines, [25565, "8080"]).map((l) => l.port)).toEqual([13715]);
  });
});
