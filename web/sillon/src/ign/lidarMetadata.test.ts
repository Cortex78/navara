import { describe, expect, it } from "vitest";

import {
  lidarMetadataUrl,
  parseLidarMetadataFeature,
  summarizeAcquisition,
} from "./lidarMetadata";

// Abridged from a real IGNF_LIDAR-HD_METADONNEE:metadata response (Camargue).
const CAMARGUE_FEATURE = {
  properties: {
    capteur: '["Leica TerrainMapper:90560"]',
    url_mnt:
      "https://data.geopf.fr/wms-r?SERVICE=WMS&VERSION=1.3.0&EXCEPTIONS=text/xml&REQUEST=GetMap&LAYERS=IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93&FORMAT=image/geotiff&STYLES=&CRS=EPSG:2154&BBOX=824999.75,6277000.25,825999.75,6278000.25&WIDTH=2000&HEIGHT=2000&FILENAME=LHD_FXX_0825_6278_MNT_O_0M50_LAMB93_IGN69.tif",
    url_npl:
      "https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/NUALHD_1-0__LAZ_LAMB93_NQ_2024-12-19/LHD_FXX_0825_6278_PTS_LAMB93_IGN69.copc.laz",
    code_mission: "21LHD7NQ",
    date_edition: "2024-12-19Z",
    nombre_points: 13900661,
    coordonnees_nw: "0825-6278",
    procede_classement: "ST_AUTO_MANUEL",
    date_fin_acquisition: "2021-05-27Z",
    date_debut_acquisition: "2021-05-27Z",
  },
};

describe("LiDAR HD metadata", () => {
  it("parses a WFS feature", () => {
    const m = parseLidarMetadataFeature(CAMARGUE_FEATURE);
    expect(m).toMatchObject({
      tileId: "0825_6278",
      mission: "21LHD7NQ",
      acquisitionStart: "2021-05-27",
      acquisitionEnd: "2021-05-27",
      editionDate: "2024-12-19",
      sensors: ["Leica TerrainMapper"],
      pointCount: 13900661,
      classification: "ST_AUTO_MANUEL",
    });
    expect(m.density).toBeCloseTo(13.9, 1);
    expect(m.copcUrl).toMatch(/\.copc\.laz$/);
  });

  it("summarises the tiles under an area", () => {
    const a = parseLidarMetadataFeature(CAMARGUE_FEATURE);
    const b = {
      ...a,
      acquisitionStart: "2021-04-02",
      acquisitionEnd: "2021-04-03",
      density: 10.1,
      sensors: ["Riegl VQ-1560"],
    };
    expect(summarizeAcquisition([a, b])).toEqual({
      tiles: 2,
      start: "2021-04-02",
      end: "2021-05-27",
      sensors: ["Leica TerrainMapper", "Riegl VQ-1560"],
      meanDensity: (a.density + 10.1) / 2,
    });
    expect(summarizeAcquisition([])).toBeNull();
  });

  it("queries by a CRS84 bbox", () => {
    const url = new URL(
      lidarMetadataUrl({
        west: 4.548,
        south: 43.582,
        east: 4.558,
        north: 43.588,
      }),
    );
    expect(url.searchParams.get("TYPENAMES")).toBe(
      "IGNF_LIDAR-HD_METADONNEE:metadata",
    );
    expect(url.searchParams.get("BBOX")).toBe(
      "4.548,43.582,4.558,43.588,urn:ogc:def:crs:OGC:1.3:CRS84",
    );
  });
});
