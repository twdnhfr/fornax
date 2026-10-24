// Sign a release's SHA256SUMS with the release key (CI: secret FORNAX_RELEASE_KEY, a PEM Ed25519 key).
// Refuses a key whose public half is not the one built into fornax — such a release could not be installed.
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { RELEASE_KEY } from "../src/core/release-key.ts";
import { verifySums } from "../src/core/update.ts";

const file = process.argv[2];
const pem = process.env.FORNAX_RELEASE_KEY;
if (!file || !pem) {
  console.error("usage: FORNAX_RELEASE_KEY=<pem> bun scripts/sign.ts dist/SHA256SUMS");
  process.exit(1);
}
const key = createPrivateKey(pem);
const pub = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
if (pub.trim() !== RELEASE_KEY.trim()) {
  console.error("FORNAX_RELEASE_KEY is not the key whose public half is in src/core/release-key.ts");
  process.exit(1);
}
const data = readFileSync(file);
const sig = sign(null, data, key);
if (!verifySums(data, sig)) process.exit(1);
writeFileSync(`${file}.sig`, sig);
console.log(`signed ${file} → ${file}.sig`);
