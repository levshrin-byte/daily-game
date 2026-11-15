// Generate the route list (scripts/routes.json) from real data.
//
// Endpoints are real GeoNames places (all-the-cities, CC BY 4.0). Each candidate line is screened against
// real terrain (AWS Terrain Tiles, read at low zoom) and the Natural Earth land polygons, classified by its
// actual profile, and then a balanced set is picked by region and terrain type. Nothing is invented: a
// route either has a real profile that passes the checks or it is dropped. The hand-written routes in
// scripts/curated.json are always kept. Deterministic for a given SEED.
//
// Run: npm run gen:routes   (then npm run bake)
//
// EXTEND=n keeps every route already in scripts/routes.json exactly as it is and adds n new generated routes
// after them (screened the same way, with a different seed so new candidates come up). New routes keep their
// distance from the existing ones as well as from each other. This is how the list grows without touching
// routes that are already scheduled: npm run gen:more (EXTEND=1800), then npm run bake.
import { readFileSync, writeFileSync } from "node:fs";
import { linePoints, elevation, haversine, zoomFor, stats } from "./lib/terrain.mjs";
import { cities, landAt, regionOf, REGIONS, nearestCity } from "./lib/geo.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXTEND = Number(process.env.EXTEND || 0);
const SEED = EXTEND ? 20261115 : 20261113;
const TARGET = EXTEND || Number(process.env.TARGET || 366);   // generated routes, on top of the curated ones
const curated = JSON.parse(readFileSync(ROOT + "scripts/curated.json", "utf8"));
// Routes kept as they are when extending (curated and earlier generated ones), in their existing order.
const existing = EXTEND ? JSON.parse(readFileSync(ROOT + "scripts/routes.json", "utf8")) : [];

// Share of the generated set per region (sums to 1).
const REGION_SHARE = {
  "Europe": 0.17, "North America": 0.13, "Central America & Caribbean": 0.07, "South America": 0.12,
  "Africa": 0.125, "Middle East": 0.08, "Central & South Asia": 0.095, "East Asia": 0.09,
  "Southeast Asia": 0.065, "Oceania": 0.055,
};
// Terrain mix we aim for overall; tags (island, coastal) have minimum counts.
const KIND_SHARE = { flat: 0.2, hilly: 0.32, mountain: 0.48 };
const MIN_TAG = { island: Math.round(TARGET * 0.1), coastal: Math.round(TARGET * 0.2) };

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const pickWeighted = (items, w) => {
  const total = items.reduce((s, x) => s + w(x), 0);
  let r = rand() * total;
  for (const x of items) if ((r -= w(x)) <= 0) return x;
  return items[items.length - 1];
};

// ---------- City pool ----------
// Real towns and cities (not neighbourhoods), one per name and country, at least 15,000 people.
const seen = new Set();
const pool = cities
  .filter((c) => c.population >= 15000 && /^PPL(A\d?|C|)?$/.test(c.featureCode) && c.name && !/[0-9]/.test(c.name))
  .sort((a, b) => b.population - a.population)
  .filter((c) => { const k = c.name + "|" + c.country; if (seen.has(k)) return false; seen.add(k); return true; })
  .map((c) => ({ name: c.name, country: c.country, pop: c.population, lat: c.loc.coordinates[1], lon: c.loc.coordinates[0], region: regionOf(c.country) }))
  .filter((c) => c.region !== "Other" && Math.abs(c.lat) < 70);
const grid = new Map();
for (const c of pool) {
  const k = `${Math.floor(c.lat)},${Math.floor(c.lon)}`;
  if (!grid.has(k)) grid.set(k, []); grid.get(k).push(c);
}
function citiesNear(c, maxKm) {
  const out = [], dLat = Math.ceil(maxKm / 111), dLon = Math.ceil(maxKm / (111 * Math.max(0.2, Math.cos((c.lat * Math.PI) / 180))));
  for (let y = Math.floor(c.lat) - dLat; y <= Math.floor(c.lat) + dLat; y++)
    for (let x = Math.floor(c.lon) - dLon; x <= Math.floor(c.lon) + dLon; x++)
      for (const o of grid.get(`${y},${((x + 180) % 360 + 360) % 360 - 180}`) || []) out.push(o);
  return out;
}
// Drop suburbs: places with a city five times bigger (and over 400,000 people) within 25 km.
{
  const big = pool.filter((c) => c.pop > 400000);
  const keep = pool.filter((c) => !big.some((b) => b !== c && b.pop > 5 * c.pop && haversine([b.lat, b.lon], [c.lat, c.lon]) < 25));
  pool.length = 0; pool.push(...keep);
  grid.clear();
  for (const c of pool) { const k = `${Math.floor(c.lat)},${Math.floor(c.lon)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(c); }
}
// Island cities: their land polygon is smaller than ~800,000 km² (so Borneo yes, Australia and Greenland no).
const polyOf = (lat, lon) => landAt(lat, lon);
for (const c of pool) { const p = polyOf(c.lat, c.lon); c.poly = p; c.island = !!p && p.areaKm2 < 800000; }
console.error(`City pool: ${pool.length} places, ${pool.filter((c) => c.island).length} on islands`);

// ---------- Screening ----------
const SCREEN_SAMPLES = 48;
async function screen(A, B) {
  const a = [A.lat, A.lon], b = [B.lat, B.lon];
  const dist = haversine(a, b);
  const z = Math.max(7, Math.min(9, zoomFor(dist, (A.lat + B.lat) / 2) - 3));
  const pts = linePoints(a, b, SCREEN_SAMPLES);
  const land = pts.map(([la, lo]) => landAt(la, lo));
  const sea = land.filter((p) => !p).length / pts.length;
  if (sea > 0.2 || !land[0] && !land[1] || !land.at(-1) && !land.at(-2)) return null;
  const elev = [];
  for (let i = 0; i < pts.length; i++) {
    const e = await elevation(pts[i][0], pts[i][1], z);
    if (!land[i]) { elev.push(0); continue; }
    if (e < -30 || e > 8850) return null;   // lake-bed bathymetry or bad data: not a route we can show honestly
    elev.push(Math.max(-30, e));
  }
  const max = Math.max(...elev), min = Math.min(...elev), relief = max - min;
  if (relief < 25) return null;             // so flat there is nothing to draw
  const kind = max >= 2000 || relief >= 1500 ? "mountain" : relief >= 300 ? "hilly" : "flat";
  const sameIsland = A.island && B.island && A.poly === B.poly;
  const coastal = [0, 1, pts.length - 2, pts.length - 1].some((i) => !land[i]) || nearSea(A) || nearSea(B);
  return { dist, kind, island: sameIsland, coastal, sea, relief, max };
}
function nearSea(c) {
  const d = 0.04; // ~4 km
  return [[d, 0], [-d, 0], [0, d], [0, -d]].some(([y, x]) => !landAt(c.lat + y, c.lon + x / Math.cos((c.lat * Math.PI) / 180)));
}

// ---------- Candidate generation ----------
const BANDS = [[25, 80, 0.25], [80, 200, 0.45], [200, 420, 0.3]];
function partner(A, islandOnly) {
  const band = pickWeighted(BANDS, (b) => b[2]);
  const near = citiesNear(A, band[1]).filter((B) => {
    if (B === A || B.name === A.name) return false;
    if (islandOnly && B.poly !== A.poly) return false;
    const d = haversine([A.lat, A.lon], [B.lat, B.lon]);
    return d >= band[0] && d <= band[1];
  });
  return near.length ? pickWeighted(near, (c) => Math.pow(c.pop, 0.75)) : null;
}
const curatedEnds = curated.flatMap((r) => [r.a, r.b]);
const keepApart = EXTEND ? existing : curated;
const tooCloseToCurated = (A, B) => keepApart.some((r) =>
  (haversine(r.a, [A.lat, A.lon]) < 40 && haversine(r.b, [B.lat, B.lon]) < 40) ||
  (haversine(r.b, [A.lat, A.lon]) < 40 && haversine(r.a, [B.lat, B.lon]) < 40));

const candidates = [];
const want = Object.fromEntries(REGIONS.map((r) => [r, Math.round(TARGET * REGION_SHARE[r])]));
const PER_REGION = Number(process.env.CANDIDATES || 7);   // candidates screened per wanted route
let tried = 0;
for (const region of REGIONS) {
  const local = pool.filter((c) => c.region === region);
  const islands = local.filter((c) => c.island);
  const goal = want[region] * PER_REGION;
  let got = 0, attempts = 0;
  while (got < goal && attempts < goal * 6) {
    attempts++;
    // A third of the attempts start from an island city and stay on that island.
    const islandTry = islands.length > 3 && rand() < 0.33;
    const A = pickWeighted(islandTry ? islands : local, (c) => Math.pow(c.pop, 0.6));
    const B = partner(A, islandTry);
    if (!B || tooCloseToCurated(A, B)) continue;
    tried++;
    const s = await screen(A, B);
    if (!s) continue;
    candidates.push({ A, B, region, ...s });
    got++;
  }
  console.error(`${region.padEnd(28)} ${got} candidates from ${attempts} attempts (tiles fetched so far: ${stats().fetched})`);
}

// ---------- Balanced selection ----------
const chosen = [];
const uses = new Map();
const kindCount = { flat: 0, hilly: 0, mountain: 0 }, tagCount = { island: 0, coastal: 0 };
const regionCount = Object.fromEntries(REGIONS.map((r) => [r, 0]));
const mid = (c) => [(c.A.lat + c.B.lat) / 2, (c.A.lon + c.B.lon) / 2];
// When extending: midpoints of the existing routes, and how often each existing endpoint is already used.
const oldMids = existing.map((r) => [(r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2]);
const oldUses = new Map();
for (const r of existing) for (const n of [r.from, r.to]) oldUses.set(n, (oldUses.get(n) || 0) + 1);
const used = (c) => (uses.get(c) || 0) + (oldUses.get(c.name) || 0);
// Keep routes apart: no two with both ends close together, and midpoints at least 35 km apart. The open list
// is narrowed after each pick (instead of re-checking every candidate against every pick), which gives the same
// picks in the same order but scales to thousands of routes.
for (const c of candidates) c.mid = mid(c);
const fits = (c) => regionCount[c.region] < want[c.region] && used(c.A) < 2 && used(c.B) < 2;
let open = candidates.filter((c) => fits(c) && !oldMids.some((m) => haversine(m, c.mid) < 35));
function need(c) {
  const n = chosen.length + 1;
  let s = KIND_SHARE[c.kind] * n - kindCount[c.kind];                    // under-filled terrain type
  if (c.island) s += (MIN_TAG.island - tagCount.island) / 6;
  if (c.coastal) s += (MIN_TAG.coastal - tagCount.coastal) / 10;
  s += (want[c.region] - regionCount[c.region]) / want[c.region];        // under-filled region
  return s + rand() * 0.6;                                               // some randomness, seeded
}
while (chosen.length < TARGET) {
  if (!open.length) break;
  let best = open[0], bs = -Infinity;
  for (const c of open) { const s = need(c); if (s > bs) { bs = s; best = c; } }
  chosen.push(best);
  uses.set(best.A, (uses.get(best.A) || 0) + 1); uses.set(best.B, (uses.get(best.B) || 0) + 1);
  kindCount[best.kind]++; regionCount[best.region]++;
  if (best.island) tagCount.island++; if (best.coastal) tagCount.coastal++;
  open = open.filter((c) => fits(c) && haversine(best.mid, c.mid) >= 35 &&
    !(best.A === c.A && best.B === c.B) && !(best.A === c.B && best.B === c.A));
}

// ---------- Output ----------
const slug = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const ids = new Set([...curated, ...existing].map((r) => r.id));
const generated = chosen.map((c) => {
  // Put the lower end first about half the time, so not every route is a climb.
  let [A, B] = rand() < 0.5 ? [c.A, c.B] : [c.B, c.A];
  let id = `${slug(A.name)}-${slug(B.name)}`;
  for (let k = 2; ids.has(id); k++) id = `${slug(A.name)}-${slug(B.name)}-${k}`;
  ids.add(id);
  return { id, from: A.name, to: B.name, a: [+A.lat.toFixed(4), +A.lon.toFixed(4)], b: [+B.lat.toFixed(4), +B.lon.toFixed(4)], source: "generated" };
});
const all = EXTEND ? [...existing, ...generated] : [...curated.map((r) => ({ ...r, source: "curated" })), ...generated];
writeFileSync(ROOT + "scripts/routes.json", JSON.stringify(all, null, 1) + "\n");
console.error(`\nScreened ${tried} lines, ${candidates.length} passed, chose ${chosen.length} (+${all.length - chosen.length} kept = ${all.length}).`);
console.error("By region:", regionCount);
console.error("By terrain:", kindCount, "tags:", tagCount);
console.error(`Tiles downloaded this run: ${stats().fetched}`);
