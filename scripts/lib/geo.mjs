// Land, country and region lookups from Natural Earth 1:10m (world-atlas) and GeoNames (all-the-cities).
import { createRequire } from "node:module";
import { feature } from "topojson-client";

const require = createRequire(import.meta.url);
export const cities = require("all-the-cities");

// Every land mass (Natural Earth 1:10m land, so continents are single polygons), with its bounding box and
// rough area in km², so we can tell islands from mainland. Edges are bucketed by 0.1° latitude bands so
// the point-in-polygon test only looks at the few edges near the point.
const landTopo = require("world-atlas/land-10m.json");
const polys = [];
for (const f of feature(landTopo, landTopo.objects.land).features) {
  const g = f.geometry; if (!g) continue;
  const list = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  for (const rings of list) {
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    for (const [x, y] of rings[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    polys.push({ rings: rings.map(indexRing), box: [x0, y0, x1, y1], areaKm2: ringAreaKm2(rings[0]) });
  }
}
function indexRing(ring) {
  const bands = new Map();
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ya = ring[i][1], yb = ring[j][1];
    for (let k = Math.floor(Math.min(ya, yb) * 10); k <= Math.floor(Math.max(ya, yb) * 10); k++) {
      if (!bands.has(k)) bands.set(k, []);
      bands.get(k).push(ring[i][0], ya, ring[j][0], yb);
    }
  }
  return bands;
}
function ringAreaKm2(ring) {
  // Shoelace formula on a sinusoidal (equal-area) projection.
  const P = ([lon, lat]) => [lon * 111.32 * Math.cos((lat * Math.PI) / 180), lat * 111.32];
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) { const [x1, y1] = P(ring[i]), [x2, y2] = P(ring[i + 1]); s += x1 * y2 - x2 * y1; }
  return Math.abs(s / 2);
}
function inRing(bands, x, y) {
  const e = bands.get(Math.floor(y * 10)); if (!e) return false;
  let inside = false;
  for (let i = 0; i < e.length; i += 4) {
    const xi = e[i], yi = e[i + 1], xj = e[i + 2], yj = e[i + 3];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** The land mass under a point, or null over sea. */
export function landAt(lat, lon) {
  for (const p of polys) {
    const [x0, y0, x1, y1] = p.box;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    if (inRing(p.rings[0], lon, lat) && !p.rings.slice(1).some((h) => inRing(h, lon, lat))) return p;
  }
  return null;
}

// ISO 3166 alpha-2 → broad region, used only to balance the dataset.
const REGION_OF = {};
const R = {
  "Europe": "AD AL AT BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GI GR HR HU IE IM IS IT LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM UA VA XK GG JE AX",
  "North America": "US CA GL PM BM",
  "Central America & Caribbean": "MX GT BZ SV HN NI CR PA CU JM HT DO PR BS TT BB LC VC GD DM AG KN AW CW BQ SX MF BL GP MQ KY TC VG VI AI MS",
  "South America": "CO VE GY SR GF EC PE BR BO PY CL AR UY FK",
  "Africa": "MA DZ TN LY EG SD SS ER DJ ET SO KE UG RW BI TZ CD CG GA CM CF TD NE NG BJ TG GH CI LR SL GN GW SN GM ML BF MR CV ST GQ AO ZM MW MZ ZW BW NA ZA LS SZ MG MU RE KM SC YT EH SH",
  "Middle East": "TR SY LB IL PS JO IQ IR SA YE OM AE QA BH KW GE AM AZ",
  "Central & South Asia": "KZ UZ TM KG TJ AF PK IN NP BT BD LK MV",
  "East Asia": "CN MN KP KR JP TW HK MO",
  "Southeast Asia": "MM TH LA KH VN MY SG ID BN PH TL",
  "Oceania": "AU NZ PG FJ SB VU NC PF WS TO KI FM MH PW NR TV GU MP CK NU",
};
for (const [region, codes] of Object.entries(R)) for (const c of codes.split(" ")) REGION_OF[c] = region;
export const REGIONS = Object.keys(R);
export const regionOf = (iso2) => REGION_OF[iso2] || "Other";

const names = new Intl.DisplayNames(["en"], { type: "region" });
export const countryName = (iso2) => { try { return names.of(iso2); } catch { return iso2; } };

/** Nearest GeoNames place to a point (optionally above a population), with its distance in km. */
export function nearestCity(lat, lon, minPop = 0, list = cities) {
  let best = null, bd = Infinity;
  const k = Math.cos((lat * Math.PI) / 180);
  for (const c of list) {
    if (c.population < minPop) continue;
    const [x, y] = c.loc.coordinates, d = Math.hypot((x - lon) * k, y - lat);
    if (d < bd) { bd = d; best = c; }
  }
  return best && { city: best, km: bd * 111.2 };
}
