/**
 * Proxy keys are short query strings naming one tile or lookup, e.g.
 * `kind=ortho&z=17&x=67193&y=47869`. The page builds them, Postgres and the
 * Edge Function both check them against this pattern, and the cache is
 * keyed by them, so one key must always name the same answer.
 */
export const KEY_PATTERN = /^kind=[a-z]+(&[a-z]+=[-A-Za-z0-9.,_%+]*)*$/;
export const MAX_KEYS = 24;

/** URL-encodes a value so the key stays inside KEY_PATTERN (and SQL quotes). */
export const keyValue = (v: string) =>
  encodeURIComponent(v).replace(
    /[^-A-Za-z0-9.,_%+]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
