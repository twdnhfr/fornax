import { fail } from "./errors.ts";

/**
 * Server names like Forge's: an adjective and a noun ("silent-comet", "roaming-glacier"). Easy to
 * say, easy to tell apart, nothing about what runs on the server (that changes; the name stays).
 */
const ADJECTIVES = (
  "amber ancient arctic autumn blazing bold brave bright calm celestial cobalt colossal cosmic crimson crystal " +
  "dark dawning distant dusky electric emerald endless fearless fiery frosty gentle gilded glacial golden " +
  "hidden hollow icy indigo iron jade lively lone lucky lunar majestic mellow misty molten nimble noble " +
  "northern obsidian patient polar proud quiet radiant rapid red restless rising roaming royal ruby rusty " +
  "sacred scarlet secret serene shining silent silver solar spinning stellar stormy sunny swift tidal " +
  "twilight velvet vivid wandering wild winter wise young"
).split(" ");

const NOUNS = (
  "anchor aurora avalanche badger beacon blizzard breeze canyon cascade comet condor coral cosmos crater " +
  "cyclone delta dune eclipse ember falcon fjord forest galaxy geyser glacier harbor hawk horizon iceberg " +
  "island jaguar lagoon lantern lighthouse lynx meadow meteor mesa mountain nebula oasis ocean orbit otter " +
  "panther peak phoenix pine planet prairie quasar raven reef ridge river rocket sequoia shore sierra " +
  "sparrow star summit sun thunder tide tiger tornado tundra valley vortex wave willow wolf"
).split(" ");

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;

/** A fresh name that is not in `taken` (names in the fleet and at the provider). */
export function serverName(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let i = 0; i < 1000; i++) {
    const name = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!used.has(name)) return name;
  }
  // thousands of combinations: only a fleet far bigger than any sane one gets here
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${Math.floor(Math.random() * 1000)}`;
}

export const NAME_WORDS = { adjectives: ADJECTIVES.length, nouns: NOUNS.length };

/**
 * A fresh name under the fleet's preview_domain, e.g. quiet-harbor.example.com: two words like a
 * server's, never one a site of the fleet already answers to.
 */
export function previewName(previewDomain: string, takenNames: Iterable<string>): string {
  const suffix = `.${previewDomain}`;
  const labels = [...takenNames].filter((n) => n.endsWith(suffix)).map((n) => n.slice(0, -suffix.length));
  return `${serverName(labels)}${suffix}`;
}

/** A server name given on the command line: it becomes the file name, the hostname and the tailnet name. */
export function assertServerName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) fail("invalid_argument", `"${name}" is not a server name`, "lower-case letters, digits and -, at most 63, like silent-comet");
}

/** An IPv4 address (a server's host may be one; a site's name may not). */
export function isIPv4(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split(".").every((x) => Number(x) <= 255);
}

/** Private, loopback, link-local and CGNAT (tailnet) ranges: no CA can reach a name that points there. */
export function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** A name for an IP address that needs no DNS of one's own: sslip.io answers 192-0-2-10.sslip.io (and any name under it) with 192.0.2.10. */
export function sslipDomain(ip: string): string {
  return `${ip.replaceAll(".", "-")}.sslip.io`;
}

/** Names only a local resolver knows (or that point at a private address): no public CA can issue for them. */
const LOCAL_SUFFIXES = ["test", "local", "localhost", "internal", "lan", "home.arpa", "example", "invalid"];

export function hasPublicDns(name: string): boolean {
  if (isIPv4(name)) return false;
  if (LOCAL_SUFFIXES.some((s) => name === s || name.endsWith(`.${s}`))) return false;
  const ip = name.match(/(?:^|\.)(\d{1,3}[-.]\d{1,3}[-.]\d{1,3}[-.]\d{1,3})\.(?:sslip|nip)\.io$/)?.[1]?.replace(/-/g, ".");
  return !(ip && isIPv4(ip) && isPrivateIPv4(ip));
}
