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
