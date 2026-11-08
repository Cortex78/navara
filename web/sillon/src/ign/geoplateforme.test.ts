import { describe, expect, it, vi } from "vitest";

import { parseLatLng } from "./geocode";
import {
  GeoplateformeError,
  geopfFetch,
  parseOgcException,
  wmsGetMapUrl,
  wmtsTemplate,
} from "./geoplateforme";

describe("URL builders", () => {
  it("builds a WMS-R BIL GetMap request", () => {
    const url = new URL(
      wmsGetMapUrl({
        layer: "L",
        crs: "EPSG:2154",
        bbox: [824999.75, 6277000.25, 825999.75, 6278000.25],
        width: 2000,
        height: 2000,
      }),
    );
    expect(url.origin + url.pathname).toBe("https://data.geopf.fr/wms-r/wms");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      REQUEST: "GetMap",
      VERSION: "1.3.0",
      CRS: "EPSG:2154",
      BBOX: "824999.75,6277000.25,825999.75,6278000.25",
      FORMAT: "image/x-bil;bits=32",
    });
  });

  it("refuses sizes the server would reject", () => {
    expect(() =>
      wmsGetMapUrl({
        layer: "L",
        crs: "EPSG:2154",
        bbox: [0, 0, 1, 1],
        width: 6000,
        height: 10,
      }),
    ).toThrow(RangeError);
  });

  it("leaves XYZ placeholders in WMTS templates", () => {
    expect(wmtsTemplate("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg")).toContain(
      "TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
    );
  });
});

describe("geopfFetch", () => {
  const xml = (text: string) =>
    new Response(
      `<ServiceExceptionReport><ServiceException code="X">${text}</ServiceException></ServiceExceptionReport>`,
      {
        status: 400,
        headers: { "content-type": "text/xml" },
      },
    );

  it("surfaces OGC exceptions as errors", async () => {
    const err = await geopfFetch("https://x", {
      fetchImpl: async () => xml("Style terrainrgb is unknown"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GeoplateformeError);
    expect(err.message).toBe("Style terrainrgb is unknown");
    expect(err.status).toBe(400);
  });

  it("treats an XML body with status 200 as an error too", async () => {
    const ok = new Response(
      "<ExceptionReport><ExceptionText>bad bbox</ExceptionText></ExceptionReport>",
      {
        headers: { "content-type": "application/xml" },
      },
    );
    await expect(
      geopfFetch("https://x", { fetchImpl: async () => ok }),
    ).rejects.toThrow("bad bbox");
  });

  it("retries throttled requests", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(
        new Response("ok", { headers: { "content-type": "image/png" } }),
      );
    const pending = geopfFetch("https://x", { fetchImpl });
    await vi.runAllTimersAsync();
    expect(await (await pending).text()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("extracts exception text", () => {
    expect(
      parseOgcException(
        '<ows:ExceptionText lang="fr">Couche inconnue</ows:ExceptionText>',
      ),
    ).toBe("Couche inconnue");
  });
});

describe("parseLatLng", () => {
  it.each([
    ["43.585, 4.553", { lat: 43.585, lng: 4.553 }],
    ["43.585 4.553", { lat: 43.585, lng: 4.553 }],
    ["-12.5;130", { lat: -12.5, lng: 130 }],
  ])("reads %s", (text, expected) =>
    expect(parseLatLng(text)).toEqual(expected),
  );

  it.each(["Arles", "95, 4", "13200 Arles"])(
    "leaves %s to the geocoder",
    (text) => {
      expect(parseLatLng(text)).toBeNull();
    },
  );
});
