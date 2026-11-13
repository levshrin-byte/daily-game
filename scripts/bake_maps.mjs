// Bake a small vector map for each route into data/maps.js.
//
// The game draws these on a canvas itself, so it needs no map tiles or map
// library at runtime (which keeps it working inside a Claude artifact and offline).
// Sources: Natural Earth 1:10m countries (world-atlas), 1 km lakes (@geo-maps),
// and GeoNames cities (all-the-cities). Run: npm run bake:maps
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { feature } from "topojson-client";
import bboxClip from "@turf/bbox-clip";

const require = createRequire(import.meta.url);
const ROOT = new URL("..", import.meta.url).pathname;
// Maps for exactly the routes that passed the profile checks (run bake_profiles.mjs first).
const routes = (() => { const window = {}; new Function("window", readFileSync(ROOT + "data/routes.js", "utf8"))(window); return window.ROUTES; })();
const countries = feature(require("world-atlas/countries-10m.json"), require("world-atlas/countries-10m.json").objects.countries).features;
// The lakes dataset is one big MultiPolygon; split it so each lake can be skipped cheaply.
const lakes = require("@geo-maps/earth-lakes-1km")().geometries
  .flatMap((g) => polygonsOf(g))
  .map((coordinates) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates } }));
const cities = require("all-the-cities");
const world110 = feature(require("world-atlas/land-110m.json"), require("world-atlas/land-110m.json").objects.land);

const W = 1000, H = 750;          // map units (the canvas scales these)
const MIN_SPAN_KM = 30;           // smallest map width, so tiny routes keep some context

const merc = ([lon, lat]) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
};
const unmerc = ([x, y]) => [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];

// Douglas-Peucker simplification on projected points.
function simplify(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Closed rings start and end on the same point, which breaks plain Douglas-Peucker,
// so split each ring at the vertex farthest from its start and simplify both halves.
function simplifyRing(pts, tol) {
  if (pts.length < 5) return pts;
  let far = 0, best = -1;
  pts.forEach(([x, y], i) => { const d = Math.hypot(x - pts[0][0], y - pts[0][1]); if (d > best) { best = d; far = i; } });
  return [...simplify(pts.slice(0, far + 1), tol).slice(0, -1), ...simplify(pts.slice(far), tol)];
}
function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === "Polygon") return [geom.coordinates];
  if (geom.type === "MultiPolygon") return geom.coordinates;
  return [];
}
function bboxOfFeature(f) {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const poly of polygonsOf(f.geometry)) for (const [x, y] of poly[0]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
const lakeBoxes = lakes.map(bboxOfFeature);
const countryBoxes = countries.map(bboxOfFeature);
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function bake(r) {
  const A = merc([r.a[1], r.a[0]]), B = merc([r.b[1], r.b[0]]);
  const midLat = (r.a[0] + r.b[0]) / 2;
  const unitsPerKm = 1 / (40075 * Math.cos((midLat * Math.PI) / 180));
  const cx = (A[0] + B[0]) / 2, cy = (A[1] + B[1]) / 2;
  let w = Math.max(Math.abs(A[0] - B[0]) * 1.35, Math.abs(A[1] - B[1]) * 1.35 * (W / H), MIN_SPAN_KM * unitsPerKm);
  const h = w * (H / W);
  const view = { x0: cx - w / 2, y0: cy - h / 2, w, h };
  const toMap = ([lon, lat]) => {
    const [x, y] = merc([lon, lat]);
    return [((x - view.x0) / view.w) * W, ((y - view.y0) / view.h) * H];
  };
  // Clip box in lon/lat, slightly larger than the view so clip edges sit off-canvas.
  const [lonMin, latMax] = unmerc([view.x0 - view.w * 0.05, view.y0 - view.h * 0.05]);
  const [lonMax, latMin] = unmerc([view.x0 + view.w * 1.05, view.y0 + view.h * 1.05]);
  const clipBox = [lonMin, latMin, lonMax, latMax];

  const shapes = (features, boxes, minArea) => {
    const out = [];
    features.forEach((f, i) => {
      if (!overlaps(boxes[i], clipBox)) return;
      for (const poly of polygonsOf(bboxClip(f, clipBox).geometry)) {
        const rings = poly
          .map((ring) => simplifyRing(ring.map(toMap), 0.8).map(([x, y]) => [Math.round(x), Math.round(y)]))
          .filter((ring) => ring.length >= 4);
        if (!rings.length) continue;
        if (minArea && Math.abs(area(rings[0])) < minArea) continue;
        out.push(rings.map((ring) => ring.flat()));
      }
    });
    return out;
  };

  const land = shapes(countries, countryBoxes, 0);
  // The lake data has ~1 km cells, so on small maps tiny lakes turn into blocky triangles; keep only sizable ones.
  const water = shapes(lakes, lakeBoxes, 2500);

  // A handful of well-known places for orientation, spread out and away from the pins.
  const a = toMap([r.a[1], r.a[0]]), b = toMap([r.b[1], r.b[0]]);
  const near = cities
    .map((c) => ({ name: c.name, pop: c.population, p: toMap(c.loc.coordinates) }))
    .filter((c) => c.p[0] > 30 && c.p[0] < W - 30 && c.p[1] > 25 && c.p[1] < H - 25)
    .sort((x, y) => y.pop - x.pop);
  const places = [];
  const minPop = near.length ? Math.max(2000, near[0].pop * 0.03) : 0;  // skip suburbs and hamlets
  for (const c of near) {
    if (c.pop < minPop) break;
    if (places.length >= 7) break;
    if (c.name === r.from || c.name === r.to) continue;
    if ([a, b].some((p) => Math.hypot(p[0] - c.p[0], p[1] - c.p[1]) < 70)) continue;
    if (places.some((p) => Math.hypot(p[1] - c.p[0], p[2] - c.p[1]) < 120)) continue;
    places.push([c.name, Math.round(c.p[0]), Math.round(c.p[1])]);
  }

  return {
    w: W, h: H,
    kmPerUnit: +(view.w / unitsPerKm / W).toFixed(4),
    a: a.map(Math.round), b: b.map(Math.round),
    land, water, places,
  };
}
function area(flatOrPts) {
  let s = 0;
  for (let i = 0, n = flatOrPts.length; i < n; i++) {
    const [x1, y1] = flatOrPts[i], [x2, y2] = flatOrPts[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

// World outline for the small locator inset (equirectangular, 360 x 180 units).
const world = [];
for (const f of world110.features) for (const poly of polygonsOf(f.geometry)) {
  const ring = simplifyRing(poly[0].map(([lon, lat]) => [lon + 180, 90 - lat]), 0.6).map(([x, y]) => [Math.round(x), Math.round(y)]);
  if (ring.length >= 4 && Math.abs(area(ring)) > 4) world.push(ring.flat());
}

const maps = {};
for (const r of routes) {
  maps[r.id] = bake(r);
  const m = maps[r.id];
  console.error(`${r.id.padEnd(24)} land ${String(m.land.length).padStart(3)}  lakes ${String(m.water.length).padStart(3)}  places ${m.places.map((p) => p[0]).join(", ")}`);
}
const js = "// Generated by scripts/bake_maps.mjs. Do not edit by hand.\n" +
  "// Map data: Natural Earth (public domain), GeoNames (CC BY 4.0).\n" +
  "window.MAPS = " + JSON.stringify(maps) + ";\nwindow.WORLD = " + JSON.stringify(world) + ";\n";
writeFileSync(ROOT + "data/maps.js", js);
console.error(`data/maps.js: ${(js.length / 1024).toFixed(0)} KB`);
