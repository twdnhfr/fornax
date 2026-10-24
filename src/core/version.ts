export const VERSION = "0.1.0";

declare const FORNAX_BUILD: string | undefined;

/**
 * When this binary was built (ISO time of its newest source file), set with `bun build --define`.
 * Undefined when fornax runs from source. Decides whether a server's binary is older or newer.
 */
export const BUILD: string | undefined = typeof FORNAX_BUILD === "string" ? FORNAX_BUILD : undefined;
