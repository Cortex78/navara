import { afterEach, describe, expect, it, vi } from "vitest";

import { keyValue, KEY_PATTERN, MAX_KEYS } from "./keys";
import { handleProxy, toBase64 } from "./proxy";

const decode = (b64: string) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

afterEach(() => vi.unstubAllGlobals());

describe("toBase64", () => {
  it("encodes bytes past the chunk size", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i & 0xff);
    expect(decode(toBase64(bytes))).toEqual(bytes);
  });
});

describe("KEY_PATTERN", () => {
  it.each([
    "kind=ortho&z=17&x=67193&y=47869",
    "kind=geocode&q=Saintes-Maries%20de%20la%20mer",
    "kind=rpg&w=4.55&s=43.58&e=4.56&n=43.59",
  ])("accepts %s", (k) => expect(KEY_PATTERN.test(k)).toBe(true));
  it.each([
    "kind=ortho'; drop table x;--",
    "z=1&kind=ortho",
    "kind=geocode&q=a b",
  ])("rejects %s", (k) => expect(KEY_PATTERN.test(k)).toBe(false));
});

describe("keyValue", () => {
  it("keeps encoded values inside the key pattern", () => {
    for (const q of [
      "Saintes-Maries-de-la-Mer",
      "L'Isle-sur-la-Sorgue (84)",
      "rue d'Arles, 13200",
    ]) {
      const key = `kind=geocode&q=${keyValue(q)}`;
      expect(KEY_PATTERN.test(key)).toBe(true);
      expect(key).not.toContain("'");
      expect(new URLSearchParams(key).get("q")).toBe(q);
    }
  });
});

describe("handleProxy", () => {
  it("fetches imagery tiles from IGN WMTS and base64-encodes them", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const fetchMock = vi.fn(
      async () =>
        new Response(jpeg, { headers: { "content-type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await handleProxy(["kind=ortho&z=17&x=67193&y=47869"]);
    const item = out["kind=ortho&z=17&x=67193&y=47869"];
    expect(item).toMatchObject({
      status: 200,
      ctype: "image/jpeg",
      cache: true,
    });
    expect(decode(item.b64)).toEqual(jpeg);
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get("LAYER")).toBe("ORTHOIMAGERY.ORTHOPHOTOS");
    expect(url.searchParams.get("TILEMATRIX")).toBe("17");
    expect(url.searchParams.get("TILECOL")).toBe("67193");
  });

  it("answers bad keys with an uncached error item instead of failing the batch", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const out = await handleProxy(["kind=ortho&z=40&x=0&y=0", "kind=nope&z=1"]);
    for (const item of Object.values(out))
      expect(item).toMatchObject({ status: 502, cache: false });
  });

  it("refuses oversized batches", async () => {
    await expect(
      handleProxy(
        Array.from({ length: MAX_KEYS + 1 }, () => "kind=ortho&z=1&x=0&y=0"),
      ),
    ).rejects.toThrow();
  });
});
