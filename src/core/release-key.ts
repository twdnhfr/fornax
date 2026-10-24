/**
 * The public half of the key the release workflow signs SHA256SUMS with (Ed25519). `self-update`
 * installs nothing whose checksums it does not sign. The same key is in release-key.pem, so anyone
 * can check a download by hand:
 *   openssl pkeyutl -verify -pubin -inkey release-key.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
 */
export const RELEASE_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA6F+woo25Tgj+lxzBukPzqxDxa6rK0gu7Mw+N23hvjGQ=
-----END PUBLIC KEY-----
`;
