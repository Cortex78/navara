import { IGN_ATTRIBUTION, wmtsTemplate } from "../ign/geoplateforme";

export type ImagerySource = {
  id: string;
  label: string;
  url: string;
  maxZoom: number;
  minZoom?: number;
  attribution: string;
  attributionUrl: string;
};

const ESRI_ATTRIBUTION = {
  attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
  attributionUrl:
    "https://www.esri.com/en-us/legal/terms/full-master-agreement",
};

/** Base imagery the field is drawn on. */
export const BASE_IMAGERY: ImagerySource[] = [
  {
    id: "ign-ortho",
    label: "IGN orthophoto (BD ORTHO®)",
    url: wmtsTemplate("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg"),
    maxZoom: 19,
    ...IGN_ATTRIBUTION,
  },
  {
    id: "ign-ortho-irc",
    label: "IGN infrared colour (crop vigour)",
    url: wmtsTemplate("ORTHOIMAGERY.ORTHOPHOTOS.IRC", "image/jpeg"),
    maxZoom: 19,
    ...IGN_ATTRIBUTION,
  },
  {
    id: "esri-world-imagery",
    label: "Esri World Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 19,
    ...ESRI_ATTRIBUTION,
  },
];

/** Server-rendered LiDAR HD views, drawn over the base imagery with an opacity. */
export const LIDAR_OVERLAYS: ImagerySource[] = [
  {
    id: "ign-lidar-shade",
    label: "LiDAR HD shaded relief (IGN)",
    url: wmtsTemplate(
      "IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW",
      "image/png",
    ),
    maxZoom: 18,
    ...IGN_ATTRIBUTION,
  },
  {
    id: "ign-lidar-classes",
    label: "LiDAR HD point classes (IGN)",
    url: wmtsTemplate("IGNF_LIDAR-HD_CLASS", "image/png", "cartes-classes-p"),
    maxZoom: 18,
    ...IGN_ATTRIBUTION,
  },
];
