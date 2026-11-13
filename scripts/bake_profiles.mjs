// Bake real elevation profiles, checks, difficulty, facts and the daily schedule into data/routes.js,
// and write DATA.md (sources, licences and what the checks found).
//
// Every profile is read from the AWS Terrain Tiles (see scripts/lib/terrain.mjs). Each line is read twice,
// at two zoom levels, and dropped if the two disagree, if any value is no-data or physically impossible,
// or if it runs through lake-bed bathymetry. Samples over open sea (outside the Natural Earth land
// polygons) are shown at sea level and marked as water. Run: npm run bake:profiles
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { profile, SAMPLES, stats } from "./lib/terrain.mjs";
import { landAt, nearestCity, regionOf, countryName, cities } from "./lib/geo.mjs";
import { difficultyScore } from "./lib/difficulty.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const routes = JSON.parse(readFileSync(ROOT + "scripts/routes.json", "utf8"));
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
  const b = await bake(r);
  if (!b.ok) { dropped.push(b); console.error(`DROP ${b.id}: ${b.why}`); continue; }
  ok.push(b);
  if (ok.length % 50 === 0) console.error(`${ok.length} baked, ${dropped.length} dropped, tiles fetched ${stats().fetched}`);
}

const scores = ok.map((b) => difficultyScore(b.elev));
const sorted = [...scores].sort((x, y) => x - y);
const cut1 = sorted[Math.floor(sorted.length / 3)], cut2 = sorted[Math.floor((sorted.length * 2) / 3)];

const baked = ok.map((b, k) => {
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
const agrees = baked.map((r) => r._agree).sort((x, y) => x - y);
const dist = baked.map((r) => r.distanceKm).sort((x, y) => x - y);
const day = (n) => new Date(LAUNCH + (n - 1) * 864e5).toISOString().slice(0, 10);
const md = `# Elevation route data

Generated by \`scripts/bake_profiles.mjs\` on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand.

**${baked.length} routes** (${baked.filter((r) => r.source === "curated").length} hand-picked, ${baked.filter((r) => r.source === "generated").length} generated).
That covers puzzles #1 to #${baked.length} (${day(1)} to ${day(baked.length)}). After that the list repeats in a reshuffled order.

## Sources and licences

| What | Source | Licence |
|---|---|---|
| Elevation profiles | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen "terrarium" encoding), which merges SRTM, GMTED2010, ETOPO1, USGS NED/3DEP, EU-DEM, Canada CDEM, Geoscience Australia, LINZ (NZ), INEGI (Mexico), ArcticDEM and others | Free to use with attribution; see the [Terrain Tiles attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md). Most inputs are public domain (SRTM, GMTED, ETOPO1, NED); EU-DEM is Copernicus (attribution), CDEM is Open Government Licence – Canada, Geoscience Australia and LINZ are CC BY 4.0. |
| Route endpoints, towns on maps, country of each end | [GeoNames](https://www.geonames.org/) via the \`all-the-cities\` package | CC BY 4.0 |
| Coastlines, borders, land/sea test | [Natural Earth](https://www.naturalearthdata.com/) 1:10m via \`world-atlas\` | Public domain |
| Lakes on maps | \`@geo-maps/earth-lakes-1km\` (derived from Natural Earth) | Public domain / see package |
| Shaded relief on maps (interim) | Computed from the same AWS Terrain Tiles | As for elevation profiles |

No terrain is invented, smoothed into shape or edited by hand. Each value is a bilinear interpolation of four real DEM pixels.

## How each route is checked

1. The line is sampled at ${SAMPLES} evenly spaced points (Web Mercator straight line, as drawn on the map) at zoom 8–12, chosen so pixels are at least 3× finer than the sample spacing.
2. It is read again one zoom level coarser. Routes where the two readings differ by more than 6% of the chart height on average are dropped.
3. Any no-data value, anything above 8,850 m, or land below −30 m (−440 m for the hand-picked Dead Sea route) drops the route, since that is usually lake-bed bathymetry.
4. Samples outside the Natural Earth land polygons are open sea: shown at sea level and drawn as water. Routes over 22% sea are dropped.
5. Routes with under 25 m of relief are dropped.

Result: ${baked.length} kept, ${dropped.length} dropped. Median zoom agreement: ${(agrees[Math.floor(agrees.length / 2)] * 100).toFixed(2)}% of chart height; worst kept: ${(agrees.at(-1) * 100).toFixed(2)}%.
${dropped.length ? "\nDropped:\n\n" + dropped.map((d) => `- \`${d.id}\`: ${d.why}`).join("\n") + "\n" : ""}
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
- \`scripts/verify_spikes.mjs\` checks every one-sample spike or dip in all routes (a sample that stands out from both neighbours by over 15% of the chart). Run on 2026-11-13: 95 found, 94 confirmed by the finer read, 1 borderline (\`horizonte-paraipaba\` #40: 651 m baked, 573 m finer, neighbours 286/495 m, so still a real hill).

Verdict: the drastic ups and downs are real terrain (for Athens–Delphi: the Parnitha foothills, the Boeotian plain, Helicon and the slopes of Parnassus), not sampling artifacts. Profiles are left as they are; the scoring forgives them instead (see \`scoreOf\` in game.js).

## Maps and imagery

| Layer | Source | Status |
|---|---|---|
| Vector map (coastlines, borders, lakes, towns) | Natural Earth, GeoNames, baked by \`scripts/bake_maps.mjs\` into \`data/maps/NN.json\` (10 routes per file, loaded on demand) | Live |
| Shaded relief (**interim**) | Hillshade computed from AWS Terrain Tiles by \`scripts/bake_relief.mjs\` into \`data/relief/<id>.jpg\` (320×240, ~14 KB each, loaded on demand) | Live, labelled "interim" in the game |
| Satellite imagery | none | **Blocked**: not possible inside a Claude artifact |
| OpenStreetMap tiles | tile.openstreetmap.org | **Blocked**: not possible inside a Claude artifact |

Why satellite and OSM tiles are blocked: the artifact page runs under a Content Security Policy that only lets it load scripts from a few CDNs and stylesheets/fonts from Google Fonts. Images, fetch and XHR to any other host are blocked silently. So no live tile layer (OSM, Esri, EOX, NASA GIBS or any other) can load in the published artifact, whatever its licence. Images published as files alongside the artifact do load, which is how the relief works.

What a future hosted version (its own web page, outside the artifact) could do:

- **OpenStreetMap standard tiles** (\`tile.openstreetmap.org\`): allowed for light use under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/) with visible "© OpenStreetMap contributors" attribution, a valid Referer, no bulk downloading or prefetching, and caching that respects the headers. Data is ODbL. Fine for a small game; heavy traffic should move to a paid or self-hosted tile service.
- **Free satellite imagery**: [EOX Sentinel-2 cloudless](https://s2maps.eu): the 2016 layer is CC BY 4.0; later years are CC BY-NC-SA 4.0 (non-commercial only, which is ambiguous if the game ever earns money). Attribution: "Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data)". [NASA GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api) is public domain with no key, but only ~250 m per pixel for true colour, too coarse for short routes. Esri World Imagery is free only under Esri's own terms (an ArcGIS account and attribution), so it would need checking first.
- Satellite imagery shows mountains plainly, so it makes the game easier, as the relief layer does. The player can switch back to the plain map.
`;
writeFileSync(ROOT + "DATA.md", md);
console.error(`\ndata/routes.js: ${baked.length} routes (${dropped.length} dropped), ${(js.length / 1024).toFixed(0)} KB. Tiles fetched: ${stats().fetched}`);
console.error("Difficulty:", count((r) => r.difficulty), "Kinds:", count((r) => r.kind));
