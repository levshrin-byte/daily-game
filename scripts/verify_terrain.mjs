// Terrain-vs-data audit: are the sharp ups and downs in a baked profile real terrain, or sampling artifacts?
// For each route it re-reads the line from the source DEM at a finer zoom and 10x denser, then compares:
//  - point:   the baked value vs. a fresh read at the same spot two zooms finer (catches bad pixels / spikes)
//  - window:  the baked value vs. the mean of the dense samples in that sample's 1/120 slice (catches aliasing:
//             a point that happens to land on a narrow ridge or gully that does not represent its slice)
//  - spikes:  baked samples that stand out from both neighbours by >25% of the chart but whose dense slice
//             doesn't back them up.
// Run: node scripts/verify_terrain.mjs [id ...]   (default: Athens-Delphi plus the 12 most jagged routes)
import { readFileSync } from "node:fs";
import { elevation, linePoints, merc, unmerc, SAMPLES } from "./lib/terrain.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
globalThis.window = {};
eval(readFileSync(ROOT + "data/routes.js", "utf8"));
const ROUTES = window.ROUTES;
const meta = Object.fromEntries(JSON.parse(readFileSync(ROOT + "scripts/routes.json", "utf8")).map((r) => [r.id, r]));
const span = (e) => ([1000, 2500, 5000, 9000].find((t) => t >= Math.max(...e) * 1.05) || 9000) - (Math.min(...e) < -50 ? -500 : 0);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const jag = (r) => mean(r.elev.slice(1).map((e, i) => Math.abs(e - r.elev[i]))) / span(r.elev);

let ids = process.argv.slice(2);
if (!ids.length) ids = ["athens-delphi", ...[...ROUTES].sort((x, y) => jag(y) - jag(x)).filter((r) => r.id !== "athens-delphi").slice(0, 12).map((r) => r.id)];
const DENSE = 10;
const rows = [];
for (const id of ids) {
  const r = ROUTES.find((x) => x.id === id);
  const sp = span(r.elev);
  const km = r.distanceKm, spacing = km / (SAMPLES - 1);
  // Zoom the bake used (same rule as lib/terrain.mjs), then two finer, capped at z14.
  let z0 = 12; for (let z = 8; z <= 12; z++) if ((40075 * Math.cos(((r.a[0] + r.b[0]) / 2) * Math.PI / 180)) / (256 * 2 ** z) <= spacing / 3) { z0 = z; break; }
  const zf = Math.min(14, z0 + 2);
  const pts = linePoints(r.a, r.b);
  const seaIdx = new Set(); for (const [s0, s1] of r.sea) for (let i = s0; i <= s1; i++) seaIdx.add(i);
  const point = [], win = [];
  const [ax, ay] = merc(...r.a), [bx, by] = merc(...r.b);
  for (let i = 0; i < SAMPLES; i++) {
    point.push(seaIdx.has(i) ? 0 : await elevation(...pts[i], zf));
    const vals = [];
    for (let k = 0; k < DENSE; k++) {
      const t = Math.min(SAMPLES - 1, Math.max(0, i - 0.5 + (k + 0.5) / DENSE)) / (SAMPLES - 1);
      vals.push(Math.max(0, await elevation(...unmerc(ax + (bx - ax) * t, ay + (by - ay) * t), zf)));
    }
    win.push(seaIdx.has(i) ? 0 : mean(vals));
  }
  const e = r.elev;
  const dPoint = mean(e.map((v, i) => Math.abs(v - point[i]))) / sp;
  const dWin = mean(e.map((v, i) => Math.abs(v - win[i]))) / sp;
  const maxPoint = Math.max(...e.map((v, i) => Math.abs(v - point[i])));
  let spikes = 0;
  for (let i = 1; i < SAMPLES - 1; i++) {
    const out = Math.min(Math.abs(e[i] - e[i - 1]), Math.abs(e[i] - e[i + 1]));
    const sameSide = Math.sign(e[i] - e[i - 1]) === Math.sign(e[i] - e[i + 1]);
    if (sameSide && out > 0.25 * sp && Math.abs(e[i] - win[i]) > 0.15 * sp) spikes++;
  }
  const stepJ = mean(e.slice(1).map((v, i) => Math.abs(v - e[i])));
  const stepW = mean(win.slice(1).map((v, i) => Math.abs(v - win[i])));
  rows.push({ id, km: km.toFixed(0), z: `${z0}→${zf}`, max: Math.max(...e), maxFine: Math.round(Math.max(...point)),
    pointErr: (dPoint * 100).toFixed(1) + "%", worstPoint: Math.round(maxPoint) + " m", windowErr: (dWin * 100).toFixed(1) + "%",
    jagBaked: Math.round(stepJ) + " m", jagSliceMean: Math.round(stepW) + " m", spikes });
  console.error(`done ${id}`);
}
console.table(rows);
