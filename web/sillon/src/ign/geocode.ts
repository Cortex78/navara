import type { LngLat } from "../geo/lambert93";

import { GEOPF, geopfFetch, type FetchOptions } from "./geoplateforme";

export type Place = LngLat & { label: string; kind: string; context: string };

/**
 * Accepts "lat, lng" (the order farmers copy from phone maps) as well as
 * "lat lng"; returns null for anything else so the text goes to the geocoder.
 */
export const parseLatLng = (text: string): LngLat | null => {
  const m = text
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
};

/** IGN Géoplateforme geocoder: communes, addresses, places. */
export const searchPlaces = async (
  query: string,
  options?: FetchOptions & { limit?: number },
): Promise<Place[]> => {
  const coords = parseLatLng(query);
  if (coords)
    return [
      {
        ...coords,
        label: `${coords.lat}, ${coords.lng}`,
        kind: "coordinates",
        context: "",
      },
    ];
  const q = new URLSearchParams({
    q: query,
    limit: String(options?.limit ?? 5),
  });
  const res = await geopfFetch(`${GEOPF}/geocodage/search?${q}`, options);
  const json = (await res.json()) as {
    features: {
      geometry: { coordinates: [number, number] };
      properties: Record<string, string>;
    }[];
  };
  return json.features.map(({ geometry, properties }) => ({
    lng: geometry.coordinates[0],
    lat: geometry.coordinates[1],
    label: properties.label,
    kind: properties.type ?? properties._type ?? "",
    context: properties.context ?? "",
  }));
};
