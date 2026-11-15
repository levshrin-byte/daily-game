// Bake real elevation profiles, checks, difficulty, facts and the daily schedule into data/routes.js,
// and write DATA.md (sources, licences and what the checks found).
//
// Every profile is read from the AWS Terrain Tiles (see scripts/lib/terrain.mjs). Each line is read twice,
// at two zoom levels, and dropped if the two disagree, if any value is no-data or physically impossible,
// or if it runs through lake-bed bathymetry. Samples over open sea (outside the Natural Earth land
// polygons) are shown at sea level and marked as water. Run: npm run bake:profiles
//
// Incremental: routes already in data/routes.js are kept exactly as they are (byte for byte, so published and
// planned days can never change), and only routes new to scripts/routes.json are read and checked. Each bake that
// adds routes appends a batch (kept, dropped, zoom agreement) to scripts/bake_batches.json, which DATA.md reports;
// routes dropped by an earlier batch are not retried. FULL=1 rebakes every route from the tiles.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { profile, elevation, SAMPLES, stats } from "./lib/terrain.mjs";
import { landAt, nearestCity, regionOf, countryName, cities } from "./lib/geo.mjs";
import { difficultyScore } from "./lib/difficulty.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const routes = JSON.parse(readFileSync(ROOT + "scripts/routes.json", "utf8"));
const FULL = !!process.env.FULL;
const BATCHES = ROOT + "scripts/bake_batches.json";
const batches = existsSync(BATCHES) && !FULL ? JSON.parse(readFileSync(BATCHES, "utf8")) : [];
const prior = new Map();
if (!FULL && existsSync(ROOT + "data/routes.js")) {
  const w = {};
  new Function("window", readFileSync(ROOT + "data/routes.js", "utf8"))(w);
  for (const r of w.ROUTES) prior.set(r.id, r);
}
const droppedBefore = new Set(batches.flatMap((b) => b.dropped.map((d) => d.id)));
const sourceOf = new Map(routes.map((r) => [r.id, r.source]));
const LAUNCH = Date.UTC(2026, 10, 9);   // puzzle #1, a Monday; must match game.js
// scripts/schedule.json is the published day order. It is only ever appended to, so days that have been
// played keep their routes. Before it existed, puzzles #1–#5 had already been played with these routes.
const SCHEDULE = ROOT + "scripts/schedule.json";
const PINNED = existsSync(SCHEDULE) ? JSON.parse(readFileSync(SCHEDULE, "utf8"))
  : ["denver-kc", "hilo-maunakea", "athens-delphi", "nairobi-mombasa", "cosprings-pikes"];
const todayNo = Math.floor((Date.now() - LAUNCH) / 864e5) + 1;
// Difficulty by weekday, Monday first: 1 easy, 2 medium, 3 hard.
const WEEK = [1, 1, 2, 2, 3, 3, 2];

const towns = cities.filter((c) => c.population >= 1000);
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (a) => sum(a) / a.length;

function axisSpan(elev) {
  const max = Math.max(...elev), min = Math.min(...elev);
  const hi = [1000, 2500, 5000, 9000].find((t) => t >= max * 1.05) || 9000;
  return hi - (min < -50 ? -500 : 0);
}

async function bake(r) {
  const fail = (why) => ({ ok: false, id: r.id, why });
  const main = await profile(r.a, r.b);
  const check = await profile(r.a, r.b, Math.max(7, main.zoom - 1));
  const land = main.pts.map(([la, lo]) => landAt(la, lo));
  const raw = main.elev;
  if (raw.some((e) => !Number.isFinite(e) || e < -11000)) return fail("no-data value in the tiles");
  // Treat sea, and DEM bathymetry right at the shoreline, as water at sea level.
  const sea = land.map((p, i) => !p || (raw[i] < 0 && [i - 2, i - 1, i + 1, i + 2].some((j) => j >= 0 && j < SAMPLES && !land[j])));
  const elev = raw.map((e, i) => (sea[i] ? 0 : Math.round(e)));
  const landElev = elev.filter((_, i) => !sea[i]);
  if (!landElev.length) return fail("no land under the line");
  if (Math.max(...landElev) > 8850) return fail("above Everest: bad data");
  const lowest = Math.min(...landElev);
  if (lowest < (r.source === "curated" ? -440 : -30)) return fail(`land sample at ${lowest} m (lake-bed bathymetry?)`);
  if (sea.filter(Boolean).length / SAMPLES > 0.22) return fail("mostly over sea");
  // Agreement between the two zoom levels, relative to the chart height.
  const span = axisSpan(elev);
  const chk = check.elev.map((e, i) => (sea[i] ? 0 : e));
  const agree = mean(elev.map((e, i) => Math.abs(e - chk[i]))) / span;
  if (agree > 0.06) return fail(`zoom ${main.zoom} and ${check.zoom} disagree by ${(agree * 100).toFixed(1)}% of the chart`);
  const max = Math.max(...elev), min = Math.min(...elev), relief = max - min;
  if (relief < 25) return fail("nothing to draw (under 25 m of relief)");
  // One-sample spikes or dips (standing out from both neighbours by over 15% of the chart) are read again two
  // zoom levels finer. If the finer read doesn't stand out the same way, the sample is a bad pixel: drop the route.
  const fineZ = Math.min(14, main.zoom + 2);
  for (let i = 1; i < SAMPLES - 1; i++) {
    const up = elev[i] - elev[i - 1], down = elev[i] - elev[i + 1];
    if (sea[i] || Math.sign(up) !== Math.sign(down) || Math.min(Math.abs(up), Math.abs(down)) <= 0.15 * span) continue;
    const fine = await elevation(...main.pts[i], fineZ), s = Math.sign(up);
    if (!((fine - elev[i - 1]) * s > 0 && (fine - elev[i + 1]) * s > 0))
      return fail(`sample ${i} (${elev[i]} m between ${elev[i - 1]} and ${elev[i + 1]} m) is not confirmed by a finer read (${Math.round(fine)} m at z${fineZ})`);
  }
  return { ok: true, r, main, elev, sea, land, agree, span, max, min, relief };
}

function seaRanges(sea) {
  const out = []; let s = -1;
  sea.forEach((v, i) => { if (v && s < 0) s = i; if (!v && s >= 0) { out.push([s, i - 1]); s = -1; } });
  if (s >= 0) out.push([s, sea.length - 1]);
  return out;
}

// Facts for generated routes, made only from the data. {h:…} and {d:…} are metres and km that the game
// shows in the player's units.
function factFor(b, kind, tags, cA, cB) {
  const { r, elev, main } = b;
  const step = main.distanceKm / (SAMPLES - 1);
  const parts = [];
  const iMax = elev.indexOf(b.max);
  const near = nearestCity(...main.pts[iMax], 0, towns);
  const nearName = near && near.km < 15 && ![r.from, r.to].includes(near.city.name) ? `, near ${near.city.name}` : "";
  const up = Math.round(sum(elev.slice(1).map((e, i) => Math.max(0, e - elev[i]))));
  const down = Math.round(sum(elev.slice(1).map((e, i) => Math.max(0, elev[i] - e))));
  const seaKm = Math.round(b.sea.filter(Boolean).length * step);
  const midSea = b.sea.slice(3, -3).some(Boolean);

  if (tags.includes("island")) parts.push(`Both ends are on the same island${cA ? `, in ${cA}` : ""}.`);
  else if (cA && cB && cA !== cB) parts.push(`The line runs from ${cA} into ${cB}.`);
  if (midSea && seaKm >= 2) parts.push(`About {d:${seaKm}} of it is over open water.`);
  if (b.min < -20) parts.push(`It dips to {h:${b.min}}, below sea level.`);
  if (kind === "mountain") parts.push(`The highest point, {h:${b.max}}, is {d:${Math.round(iMax * step)}} from ${r.from}${nearName}.`);
  else if (kind === "flat") parts.push(`The highest and lowest points are only {h:${b.relief}} apart.`);
  else parts.push(`Walking it from ${r.from} to ${r.to} means about {h:${up}} of climbing and {h:${down}} of descent.`);
  if (parts.length < 2 && kind === "mountain") parts.push(`That's {h:${up}} of climbing in all from ${r.from} to ${r.to}.`);
  return parts.slice(0, 2).join(" ");
}

// ---------- Bake everything ----------
const ok = [], dropped = [];
for (const r of routes) {
  if (prior.has(r.id)) { ok.push({ ok: true, kept: prior.get(r.id), elev: prior.get(r.id).elev }); continue; }
  if (droppedBefore.has(r.id)) continue;
  const b = await bake(r);
  if (!b.ok) { dropped.push(b); console.error(`DROP ${b.id}: ${b.why}`); continue; }
  ok.push(b);
  if (ok.length % 50 === 0) console.error(`${ok.length} baked, ${dropped.length} dropped, tiles fetched ${stats().fetched}`);
}

const scores = ok.map((b) => difficultyScore(b.elev));
const sorted = [...scores].sort((x, y) => x - y);
const cut1 = sorted[Math.floor(sorted.length / 3)], cut2 = sorted[Math.floor((sorted.length * 2) / 3)];

const baked = ok.map((b, k) => {
  if (b.kept) return b.kept;   // already baked and published: left exactly as it is
  const { r, main, elev } = b;
  const nA = nearestCity(...r.a), nB = nearestCity(...r.b);
  const isoA = nA && nA.km < 30 ? nA.city.country : null, isoB = nB && nB.km < 30 ? nB.city.country : null;
  const cA = isoA && countryName(isoA), cB = isoB && countryName(isoB);
  const kind = b.max >= 2000 || b.relief >= 1500 ? "mountain" : b.relief >= 300 ? "hilly" : "flat";
  const tags = [];
  const pA = b.land.find(Boolean), pB = [...b.land].reverse().find(Boolean);
  if (pA && pA === pB && pA.areaKm2 < 800000 && b.land.every((p) => !p || p === pA)) tags.push("island");
  if (b.sea.slice(0, 4).some(Boolean) || b.sea.slice(-4).some(Boolean) || b.sea.some(Boolean)) tags.push("coastal");
  if (b.min < -20) tags.push("below-sea");
  const s = scores[k];
  return {
    id: r.id, from: r.from, to: r.to, a: r.a, b: r.b,
    country: cA === cB ? cA : [cA, cB].filter(Boolean).join(" → "),
    region: regionOf(isoA || isoB || ""),
    kind, tags, difficulty: s < cut1 ? 1 : s < cut2 ? 2 : 3,
    fact: r.fact || factFor(b, kind, tags, cA, cB),
    distanceKm: +main.distanceKm.toFixed(1), zoom: main.zoom,
    elev, sea: seaRanges(b.sea), source: r.source,
    _agree: b.agree,
  };
});

// ---------- Daily schedule ----------
// Pinned routes first, then each day takes a route of that weekday's difficulty, avoiding the regions of
// the last few days and yesterday's terrain type. Deterministic.
let seed = 1109;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const left = new Set(baked);
const order = [];
PINNED.forEach((id, i) => {
  const r = baked.find((x) => x.id === id);
  if (r) { order.push(r); left.delete(r); return; }
  // A route that was already published must not disappear, or every later day would shift.
  if (i < todayNo + 7) throw new Error(`Scheduled route ${id} (puzzle #${i + 1}) failed to bake; it is already public or due within a week.`);
  console.error(`Unscheduling ${id} (puzzle #${i + 1}): it no longer bakes.`);
});
while (left.size) {
  const day = order.length;                     // 0-based; day 0 is a Monday
  const tier = WEEK[day % 7];
  const recent = order.slice(-4);
  let best = null, bs = -Infinity;
  for (const r of left) {
    let s = -Math.abs(r.difficulty - tier) * 10 + rand();
    recent.forEach((o, i) => { if (o.region === r.region) s -= 1 + i; });
    if (recent.length && recent.at(-1).kind === r.kind) s -= 1.5;
    if (s > bs) { bs = s; best = r; }
  }
  order.push(best); left.delete(best);
}

const out = order.map(({ _agree, zoom, source, ...r }) => r);
const js = "// Generated by scripts/bake_profiles.mjs. Do not edit by hand.\n" +
  "// Elevation: AWS Terrain Tiles (SRTM, GMTED2010, ETOPO1, NED, EU-DEM and others). Places: GeoNames (CC BY 4.0).\n" +
  "// The array is in daily order: puzzle n is ROUTES[(n - 1) % ROUTES.length].\n" +
  "window.ROUTES = " + JSON.stringify(out) + ";\n";
writeFileSync(ROOT + "data/routes.js", js);
writeFileSync(SCHEDULE, JSON.stringify(out.map((r) => r.id), null, 0).replace(/","/g, '",\n"') + "\n");

// ---------- DATA.md ----------
const count = (f) => { const m = {}; for (const r of baked) for (const k of [].concat(f(r))) m[k] = (m[k] || 0) + 1; return m; };
const table = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join("\n");
const fresh = baked.filter((r) => r._agree != null);
if (fresh.length || dropped.length) {
  const ag = fresh.map((r) => r._agree).sort((x, y) => x - y);
  const d = fresh.map((r) => r.distanceKm).sort((x, y) => x - y);
  batches.push({ date: new Date().toISOString().slice(0, 10), label: process.env.BATCH || (batches.length ? "added routes" : "all routes"),
    kept: fresh.length, dropped: dropped.map(({ id, why }) => ({ id, why })),
    agreeMedian: ag.length ? +ag[Math.floor(ag.length / 2)].toFixed(4) : null, agreeWorst: ag.length ? +ag.at(-1).toFixed(4) : null,
    km: d.length ? [d[0], d.at(-1)] : null });
  writeFileSync(BATCHES, "[\n" + batches.map((b) => " " + JSON.stringify(b)).join(",\n") + "\n]\n");
}
const pct = (v) => (v * 100).toFixed(2) + "%";
const batchText = batches.map((b) => `- ${b.date}, ${b.label}${b.km ? ` (${b.km[0]}–${b.km[1]} km)` : ""}: ${b.kept} kept, ${b.dropped.length} dropped.` +
  (b.agreeMedian != null ? ` Median zoom agreement: ${pct(b.agreeMedian)} of chart height; worst kept: ${pct(b.agreeWorst)}.` : "") +
  (b.dropped.length ? " Dropped:\n" + b.dropped.map((d) => `  - \`${d.id}\`: ${d.why}`).join("\n") : "")).join("\n");
const dist = baked.map((r) => r.distanceKm).sort((x, y) => x - y);
const day = (n) => new Date(LAUNCH + (n - 1) * 864e5).toISOString().slice(0, 10);
const md = `# Elevation route data

Generated by \`scripts/bake_profiles.mjs\` on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand.

**${baked.length} routes** (${baked.filter((r) => sourceOf.get(r.id) === "curated").length} hand-picked, ${baked.filter((r) => sourceOf.get(r.id) !== "curated").length} generated).
At three routes a day (Easy, Medium, Hard; see \`scripts/plan_days.mjs\`) that covers about ${Math.floor(baked.length / 3)} days, ${day(1)} to ${day(Math.floor(baked.length / 3))}. After that the days repeat in a reshuffled order.

New routes are added with \`npm run gen:more\` (\`EXTEND=n\`: keeps every existing route as it is and screens new real city pairs with the same checks), then \`npm run bake\`. The schedule and the day plan are append-only, so published days never change.

## Sources and licences

| What | Source | Licence |
|---|---|---|
| Elevation profiles | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen "terrarium" encoding), which merges SRTM, GMTED2010, ETOPO1, USGS NED/3DEP, EU-DEM, Canada CDEM, Geoscience Australia, LINZ (NZ), INEGI (Mexico), ArcticDEM and others | Free to use with attribution; see the [Terrain Tiles attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md). Most inputs are public domain (SRTM, GMTED, ETOPO1, NED); EU-DEM is Copernicus (attribution), CDEM is Open Government Licence – Canada, Geoscience Australia and LINZ are CC BY 4.0. |
| Route endpoints, towns on maps, country of each end | [GeoNames](https://www.geonames.org/) via the \`all-the-cities\` package | CC BY 4.0 |
| Coastlines, borders, land/sea test | [Natural Earth](https://www.naturalearthdata.com/) 1:10m via \`world-atlas\` | Public domain |
| Lakes on maps | \`@geo-maps/earth-lakes-1km\` (derived from Natural Earth) | Public domain / see package |
| Shaded relief on maps (labelled interim in the artifact) | Computed from the same AWS Terrain Tiles | As for elevation profiles |
| Map tiles (hosted site only) | [OpenStreetMap](https://www.openstreetmap.org/copyright) standard tiles | Data ODbL, © OpenStreetMap contributors; [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) |

No terrain is invented, smoothed into shape or edited by hand. Each value is a bilinear interpolation of four real DEM pixels.

## How each route is checked

1. The line is sampled at ${SAMPLES} evenly spaced points (Web Mercator straight line, as drawn on the map) at zoom 8–12, chosen so pixels are at least 3× finer than the sample spacing.
2. It is read again one zoom level coarser. Routes where the two readings differ by more than 6% of the chart height on average are dropped.
3. Any no-data value, anything above 8,850 m, or land below −30 m (−440 m for the hand-picked Dead Sea route) drops the route, since that is usually lake-bed bathymetry.
4. Samples outside the Natural Earth land polygons are open sea: shown at sea level and drawn as water. Routes over 22% sea are dropped.
5. Routes with under 25 m of relief are dropped.
6. Any one-sample spike or dip (over 15% of the chart height against both neighbours) is read again two zoom levels finer; if the finer read doesn't stand out the same way, it's a bad DEM pixel and the route is dropped.

Each bake checks only the routes that are new (published routes are never re-read or changed). Results by batch:

${batchText}

## Coverage

| Region | Routes |
|---|---|
${table(count((r) => r.region))}

| Terrain | Routes |
|---|---|
${table(count((r) => r.kind))}

| Tag | Routes |
|---|---|
${table(count((r) => r.tags.length ? r.tags : ["(none)"]))}

| Difficulty | Routes |
|---|---|
${table(count((r) => ["", "Easy", "Medium", "Hard"][r.difficulty]))}

Distances: ${dist[0]} km to ${dist.at(-1)} km (median ${dist[Math.floor(dist.length / 2)]} km). Countries at either end: ${new Set(baked.flatMap((r) => r.country.split(" → "))).size}.

## Limits

- Accuracy is that of the source DEMs at the zoom used: roughly 30–90 m pixels for short routes and 150–600 m for long ones, so narrow summits and gorges can be shaved off. Vertical error is typically under ±20 m where SRTM is the source.
- Large lakes appear at their bed depth in some sources (ETOPO1), so routes over them are dropped rather than shown wrongly.
- The land/sea test uses 1:10m coastlines, so the first or last sample of a coastal route can sit just offshore and show as sea level.
- Generated facts are computed from the profile and GeoNames, not written by hand.

## Terrain audit (are the sharp ups and downs real?)

\`npm run verify:terrain\` re-reads routes from the source DEM two zoom levels finer and 10× denser:

- \`scripts/verify_terrain.mjs\` compares Athens–Delphi and the 12 most jagged routes against the finer read. Run on 2026-11-13: baked values matched the finer read within 0.3–1.4% of the chart height on average, peaks matched within ~50 m, and the slice averages were just as jagged as the baked samples (Athens–Delphi: 87 m vs 82 m average step). No spikes.
- \`scripts/verify_spikes.mjs\` checks every one-sample spike or dip in all routes (a sample that stands out from both neighbours by over 15% of the chart). Run on 2026-11-13 (399 routes): 95 found, 94 confirmed by the finer read, 1 borderline (\`horizonte-paraipaba\` #40: 651 m baked, 573 m finer, neighbours 286/495 m, so still a real hill). Run again on 2026-11-15 after the list grew to about two years (2,173 routes): 607 found, 603 confirmed; 3 borderline but real (the finer read stands out the same way: \`horizonte-paraipaba\`, \`wollongong-canberra\` #42, a gorge read even deeper at 151 m, and \`butterworth-uitenhage\` #14, a valley at 539 m between 607/618 m); 1 bad pixel (\`porto-alegre-marau\` #1: 862 m baked, −993 m finer, neighbours 37/21 m), so that route was dropped and the check became part of the bake (check 6 above).

- Long routes (2026-11-15, the 312 routes of 150–300 miles added for testing longer lines): the bake's spike check dropped 1 (\`gyula-pristina\`, a 404 m sample between 86 and 66 m that a finer read put at 72 m). \`FROM=2172 node scripts/verify_spikes.mjs\` then found 131 spikes or dips in the 312 kept, all 131 confirmed by the finer read. \`verify_terrain.mjs\` on the 12 most jagged long routes: baked values within 0.4–1.1% of the chart height of a read two zooms finer, peaks within 0–85 m, no spikes.
- Sample spacing on long routes: 120 samples over 240–480 km is one every 2–4 km (zoom 8, pixels about 0.6 km). Re-reading each long route 4× denser at the same zoom, the straight lines between baked samples differ from the denser read by 0.74% of the chart height on average (median; 90th percentile 1.6%), against 0.46% (1.1%) for a sample of the shorter routes, about a pixel on a phone chart, which is narrower than 120 columns anyway. The highest point is missed by a median 1.1% of the chart (90th percentile 5.4%; worst 24%, a narrow ridge between two samples on the flat \`mountain-brook-augusta\`). So long routes keep 120 samples like the rest: real point reads, not averaged.

Verdict: the drastic ups and downs are real terrain (for Athens–Delphi: the Parnitha foothills, the Boeotian plain, Helicon and the slopes of Parnassus), not sampling artifacts. Profiles are left as they are; the scoring forgives them instead (see \`scoreOf\` in game.js).

## Maps and imagery

| Layer | Source | Artifact (testing) | Hosted site |
|---|---|---|---|
| Vector map (coastlines, borders, lakes, towns) | Natural Earth, GeoNames, baked by \`scripts/bake_maps.mjs\` into \`data/maps/NN.json\` (20 routes per file, loaded on demand) | Live ("Map") | Shown underneath the tiles, and on its own if they fail |
| Shaded relief | Hillshade computed from AWS Terrain Tiles by \`scripts/bake_relief.mjs\` into \`data/relief/NNN.jpg\` (sheets of 10 routes, 320×240 each, loaded on demand) | Live ("Relief"), labelled **interim**: it stands in for satellite imagery, which can't load in an artifact | Live ("Relief"), labelled "Shaded relief" |
| OpenStreetMap tiles | \`tile.openstreetmap.org\`, set in \`config.js\` (\`tiles\`) | **Blocked** by the artifact sandbox; never requested | Live ("Map"), with "© OpenStreetMap contributors" credit on the map and a link under it |
| Satellite imagery | none | Blocked | Not added (see below) |

Why tiles are blocked in the artifact: the artifact page runs under a Content Security Policy that only lets it load scripts from a few CDNs and stylesheets/fonts from Google Fonts. Images, fetch and XHR to any other host are blocked silently, whatever the licence. Files published with the artifact do load, which is how the maps and relief work there. The artifact build sets \`tiles: null\`, so it never even asks.

### OpenStreetMap tiles on the hosted site: licence and policy

- **Data licence:** OpenStreetMap data is © OpenStreetMap contributors, under the [Open Database Licence (ODbL)](https://www.openstreetmap.org/copyright); the rendered tiles may be shown with that credit. The game shows "© OpenStreetMap" on the map itself and "Map © OpenStreetMap contributors" (linking to the copyright page) under it whenever the tile layer is on.
- **Tile usage policy** ([operations.osmfoundation.org/policies/tiles](https://operations.osmfoundation.org/policies/tiles/)): the standard tiles are a donated service for light use. The game follows its rules: visible credit, the browser's normal Referer (the hosted site sends \`Referrer-Policy: strict-origin-when-cross-origin\`), only the tiles in view are requested (no prefetching, no bulk download), and the service worker does not cache tiles (the browser's HTTP cache honours the server's headers).
- **Before launch with real traffic (and ads):** the policy can withdraw access from heavy users, and a commercial site with many daily players should not rely on the free servers. Point \`tiles.url\` in \`config.js\` at a tile provider with a free or paid plan (MapTiler, Stadia Maps, Thunderforest, Protomaps self-hosted PMTiles, …) and update its credit text and the \`img-src\` host in \`site/_headers\`. No code change is needed.
- **Spoilers:** detailed tiles print summit names and heights. \`tiles.maxZoom\` is 11, where OSM's standard style shows towns and roads but not spot heights; short routes are slightly upscaled instead. Players can also switch to the relief layer.

### Satellite imagery (not added)

- [EOX Sentinel-2 cloudless](https://s2maps.eu): the 2016 layer is CC BY 4.0; later years are CC BY-NC-SA 4.0 (non-commercial only, which rules them out once the site shows ads). Attribution: "Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data)".
- [NASA GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api) is public domain with no key, but only ~250 m per pixel for true colour, too coarse for short routes.
- Esri World Imagery is free only under Esri's own terms (an ArcGIS account and attribution), so it would need checking first.
- Satellite imagery shows mountains plainly, so it makes the game easier, as the relief layer does.
`;
writeFileSync(ROOT + "DATA.md", md);
console.error(`\ndata/routes.js: ${baked.length} routes (${dropped.length} dropped), ${(js.length / 1024).toFixed(0)} KB. Tiles fetched: ${stats().fetched}`);
console.error("Difficulty:", count((r) => r.difficulty), "Kinds:", count((r) => r.kind));
