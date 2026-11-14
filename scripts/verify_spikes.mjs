// Checks every one-sample spike or dip in the baked profiles against the source DEM at a finer zoom.
// A spike is a sample that stands out from both neighbours by more than 15% of the chart height.
// "real" = the finer read at the same spot agrees with the baked value (a narrow ridge, summit or gorge);
// "artifact" = the finer read disagrees by more than half the jump (a bad pixel or a coarse-zoom blend).
// Run: node scripts/verify_spikes.mjs
import { readFileSync } from "node:fs";
import { elevation, linePoints, SAMPLES } from "./lib/terrain.mjs";
const ROOT = new URL("..", import.meta.url).pathname;
globalThis.window = {}; eval(readFileSync(ROOT + "data/routes.js", "utf8"));
const span = (e) => ([1000, 2500, 5000, 9000].find((t) => t >= Math.max(...e) * 1.05) || 9000) - (Math.min(...e) < -50 ? -500 : 0);
const zoomFor = (km, lat) => { for (let z = 8; z <= 12; z++) if ((40075 * Math.cos(lat * Math.PI / 180)) / (256 * 2 ** z) <= km / (SAMPLES - 1) / 3) return z; return 12; };
let real = 0, art = 0; const bad = [];
for (const r of window.ROUTES) {
  const e = r.elev, sp = span(e);
  const z = Math.min(14, zoomFor(r.distanceKm, (r.a[0] + r.b[0]) / 2) + 2), pts = linePoints(r.a, r.b);
  for (let i = 1; i < SAMPLES - 1; i++) {
    const a = e[i] - e[i - 1], b = e[i] - e[i + 1];
    if (Math.sign(a) !== Math.sign(b) || Math.min(Math.abs(a), Math.abs(b)) <= 0.15 * sp) continue;
    const fine = await elevation(...pts[i], z);
    const jump = Math.min(Math.abs(a), Math.abs(b));
    if (Math.abs(fine - e[i]) > jump / 2) { art++; bad.push(`${r.id} #${i}: baked ${e[i]} m, z${z} ${Math.round(fine)} m, neighbours ${e[i - 1]}/${e[i + 1]}`); }
    else real++;
  }
}
console.log(`spikes checked: ${real + art}; confirmed by finer data: ${real}; not confirmed: ${art}`);
bad.forEach((b) => console.log("  " + b));
