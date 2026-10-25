import { describe, expect, test } from "bun:test";
import { allowedBy, dockerPublished, parseListeners, unusualListeners } from "../../src/commands/health.ts";

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
    "udp 0.0.0.0:123 chronyd",
    "tcp 0.0.0.0:13715 node",
    "tcp [::]:13715 node",
    "tcp 0.0.0.0:8080 php8.4",
    "tcp 0.0.0.0:25565 java",
    "udp [fe80::1]%if4:53 pihole-FTL",
    "tcp 100.101.2.3:8053 pihole-FTL",
  ];
  const where = (ls: ReturnType<typeof unusualListeners>) => ls.map((l) => `${l.proc}:${l.port}`);

  test("ss lines become listeners", () => {
    expect(parseListeners(["tcp [::]:443 nginx", "udp 0.0.0.0:2456 docker-proxy", "tcp *:3306 ", "bad"])).toEqual([
      { proto: "tcp", address: "[::]", port: 443, proc: "nginx", docker: false },
      { proto: "udp", address: "0.0.0.0", port: 2456, proc: "docker-proxy", docker: true },
      { proto: "tcp", address: "*", port: 3306, proc: "?", docker: false },
    ]);
  });

  test("the web server, SSH, Tailscale, DHCP, NTP, loopback and the tailnet are expected; anything else is reported once", () => {
    expect(where(unusualListeners(lines))).toEqual(["node:13715", "php8.4:8080", "java:25565"]);
  });

  test("SSH is expected on the server's own port", () => {
    expect(where(unusualListeners(["tcp 0.0.0.0:2222 sshd", "tcp 0.0.0.0:22 sshd"], { sshPort: 2222 }))).toEqual(["sshd:22"]);
  });

  test("ports opened on purpose in firewall.allow are not unusual — same protocol, ranges included", () => {
    expect(where(unusualListeners(lines, { allow: [{ port: 25565 }, { port: "8000:8090", proto: "tcp" }] }))).toEqual(["node:13715"]);
    // a udp rule does not cover a tcp listener
    expect(where(unusualListeners(lines, { allow: [{ port: 25565, proto: "udp" }] }))).toContain("java:25565");
    // a whole interface (on: tailscale0) does not make a service listening on every address intended
    expect(where(unusualListeners(lines, { allow: [{ on: "tailscale0" }] }))).toEqual(["node:13715", "php8.4:8080", "java:25565"]);
    // a port opened on one interface is
    expect(where(unusualListeners(lines, { allow: [{ on: "tailscale0", port: 13715 }] }))).toEqual(["php8.4:8080", "java:25565"]);
  });

  test("allowedBy matches ports and ranges of the same protocol", () => {
    expect(allowedBy({ proto: "udp", port: 2456, last: 2457 }, [{ port: "2456:2458", proto: "udp" }])).toBe(true);
    expect(allowedBy({ proto: "udp", port: 2456, last: 2459 }, [{ port: "2456:2458", proto: "udp" }])).toBe(false);
    expect(allowedBy({ proto: "tcp", port: 9000 }, [{ port: 9000 }])).toBe(true);
    expect(allowedBy({ proto: "tcp", port: 9000 }, [{ on: "eth1" }])).toBe(false);
  });
});

describe("ports Docker publishes", () => {
  const rules = [
    "4 -A DOCKER ! -i br-1a2b3c -p udp -m udp --dport 2456:2457 -j DNAT --to-destination 172.18.0.2:2456-2457",
    "4 -A DOCKER -d 127.0.0.1/32 ! -i docker0 -p tcp -m tcp --dport 8081 -j DNAT --to-destination 172.17.0.3:80",
    "4 -A DOCKER -d 100.101.2.3/32 ! -i docker0 -p tcp -m tcp --dport 9090 -j DNAT --to-destination 172.17.0.4:9090",
    "4 -A DOCKER ! -i docker0 -p tcp -m tcp --dport 15636 -j DNAT --to-destination 172.17.0.5:15636",
    "6 -A DOCKER ! -i docker0 -p tcp -m tcp --dport 15636 -j DNAT --to-destination [fd00::5]:15636",
    "4 -A DOCKER -i docker0 -j RETURN",
  ];

  test("DNAT rules of the DOCKER chain become listeners, with their address and range", () => {
    expect(dockerPublished(rules).map((l) => `${l.proto} ${l.address}:${l.port}${l.last ? `-${l.last}` : ""}`)).toEqual([
      "udp 0.0.0.0:2456-2457",
      "tcp 127.0.0.1:8081",
      "tcp 100.101.2.3:9090",
      "tcp 0.0.0.0:15636",
      "tcp [::]:15636",
    ]);
  });

  test("docker-proxy and published ports are marked; localhost and tailnet bindings stay quiet", () => {
    const lines = ["udp 0.0.0.0:2456 docker-proxy", "udp 0.0.0.0:2457 docker-proxy", "tcp 127.0.0.1:8081 docker-proxy", "tcp 0.0.0.0:3000 node"];
    const found = unusualListeners(lines, { dockerRules: rules });
    expect(found.map((l) => `${l.proc}:${l.port}/${l.proto}:${l.docker}`)).toEqual([
      "docker-proxy:2456/udp:true",
      "docker-proxy:2457/udp:true",
      "node:3000/tcp:false",
      // without the userland proxy nothing listens in ss — the rule alone tells
      "docker:15636/tcp:true",
    ]);
  });

  test("a port published on purpose (firewall.allow) is not reported", () => {
    const found = unusualListeners(["udp 0.0.0.0:2456 docker-proxy"], { dockerRules: rules, allow: [{ port: "2456:2457", proto: "udp" }] });
    expect(found.map((l) => l.port)).toEqual([15636]);
  });

  test("a docker-proxy on a usual port is still Docker's, not the web server's", () => {
    expect(unusualListeners(["tcp 0.0.0.0:80 docker-proxy", "udp 0.0.0.0:123 docker-proxy"]).map((l) => l.port)).toEqual([80, 123]);
  });
});
