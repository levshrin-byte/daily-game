// Simulated fingers for the drawing input (drawing.js), at iPhone size: a 300 px wide plot, 120 columns, touch
// events at 60 Hz. Compares the new pipeline (one-euro height filter, direction lock, RDP) with the old one
// (a plain moving average of the height) on taps, wobbles, slow careful strokes, fast wobbly strokes and quick
// deliberate climbs. Prints a table and exits non-zero if a check fails. Run: npm run sim:input
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { rasterize, createStroke } = require("../drawing.js");

const COLS = 120, L = 50, PW = 300;
const colX = (c) => L + (c / (COLS - 1)) * PW;
const colAt = (x) => Math.max(0, Math.min(COLS - 1, Math.round(((x - L) / PW) * (COLS - 1))));
const INPUT = { travel: 14, across: 10, back: 10, simplify: 1.5, sigmaT: 24, sigmaD: 5 };

// Seeded noise, so runs are repeatable.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// New pipeline: what game.js draws and scores, in px per column.
function newLine(samples) {
  const s = createStroke(samples[0], INPUT);
  for (const p of samples.slice(1)) s.move(p);
  if (!s.live) return null;
  return rasterize(s.points(), { cols: COLS, colX, colAt });
}
// Old pipeline (v5): moving average of the height (0.45), each sample painted straight into its column.
function oldLine(samples) {
  const out = new Array(COLS).fill(null);
  let travel = 0, px = samples[0].x, py = samples[0].y, sy = samples[0].y, live = false, last = null;
  const paint = (x, y) => {
    const col = colAt(x);
    if (last && last.col !== col) { const d = Math.sign(col - last.col); for (let i = last.col + d; i !== col; i += d) out[i] = last.y + ((y - last.y) * (i - last.col)) / (col - last.col); }
    out[col] = y; last = { col, y };
  };
  for (const p of samples.slice(1)) {
    travel += Math.hypot(p.x - px, p.y - py); px = p.x; py = p.y;
    if (!live) { if (travel < 14 || Math.abs(p.x - samples[0].x) < 9) continue; live = true; paint(samples[0].x, samples[0].y); }
    sy += 0.45 * (p.y - sy); paint(p.x, sy);
  }
  return live ? out : null;
}

// A finger following `path(u)` (u from 0 to 1) over `ms`, plus noise; returns 60 Hz samples.
function finger(path, ms, noise = () => [0, 0]) {
  const n = Math.max(2, Math.round(ms / 16.7));
  return Array.from({ length: n + 1 }, (_, i) => { const u = i / n, [x, y] = path(u), [nx, ny] = noise(i); return { x: x + nx, y: y + ny, t: i * 16.7 }; });
}
const truthCols = (path) => { // the intended line, per column
  const out = new Array(COLS).fill(null);
  for (let k = 0; k <= 4000; k++) { const [x, y] = path(k / 4000); const c = colAt(x); if (out[c] == null || Math.abs(colX(c) - x) < 0.4) out[c] = y; }
  return out;
};
function measure(line, truth) {
  if (!line) return { cover: 0 };
  const cs = line.map((v, i) => [v, truth[i], i]).filter(([v, t]) => v != null && t != null);
  const err = cs.reduce((a, [v, t]) => a + Math.abs(v - t), 0) / cs.length;
  const vals = line.filter((v) => v != null);
  const jag = vals.slice(2).reduce((a, v, i) => a + Math.abs(v - 2 * vals[i + 1] + vals[i]), 0) / Math.max(1, vals.length - 2);
  const flips = vals.slice(2).filter((v, i) => Math.sign(v - vals[i + 1]) * Math.sign(vals[i + 1] - vals[i]) < 0 && Math.abs(v - vals[i + 1]) > 1).length;
  return { cover: Math.round((vals.length / COLS) * 100), err: +err.toFixed(1), jag: +jag.toFixed(2), flips };
}

const hill = (x0, x1) => (u) => [x0 + (x1 - x0) * u, 150 - 60 * Math.sin(Math.PI * u) - 25 * Math.sin(5 * Math.PI * u)];
const cases = [
  ["tap", finger(() => [150, 120], 80), null],
  ["wobble (±6 px)", finger((u) => [150 + 6 * Math.sin(u * 9), 120 + 6 * Math.cos(u * 7)], 300), null],
  ["slow wobble on the spot (±8 px, 1 s)", finger((u) => [150 + 8 * Math.sin(u * 20), 120 + 4 * Math.sin(u * 31)], 1000), null],
  ["slow careful stroke, ±3 px jitter", finger(hill(L, L + PW), 3000, () => [gauss() * 1.5, gauss() * 3]), hill(L, L + PW)],
  ["normal stroke, ±2 px jitter", finger(hill(L, L + PW), 1200, () => [gauss() * 1, gauss() * 2]), hill(L, L + PW)],
  ["fast wobbly stroke (±12 px shakes)", finger(hill(L, L + PW), 700, (i) => [gauss() * 2, i % 2 ? 12 : -12]), hill(L, L + PW)],
  ["hand tremor (10 Hz, ±3 px)", finger(hill(L, L + PW), 1500, (i) => [0, 3 * Math.sin(i * 16.7 * 0.0628)]), hill(L, L + PW)],
  ["shaky hand (6 Hz, ±6 px)", finger(hill(L, L + PW), 1500, (i) => [0, 6 * Math.sin(i * 16.7 * 0.0377)]), hill(L, L + PW)],
  ["sideways jitter on a slow stroke", finger(hill(L, L + PW), 2500, (i) => [(i % 3 - 1) * 5, gauss() * 1.5]), hill(L, L + PW)],
];
let failed = false;
const row = (...a) => console.log(a.map((v, i) => String(v).padEnd(i ? 26 : 40)).join(""));
row("case", "old: cover err jag flips", "new: cover err jag flips");
for (const [name, samples, path] of cases) {
  const o = oldLine(samples), n = newLine(samples), t = path ? truthCols(path) : null;
  if (!path) {
    row(name, o ? "DREW" : "nothing", n ? "DREW" : "nothing");
    if (n) { failed = true; console.log("  FAIL: should draw nothing"); }
    continue;
  }
  const mo = measure(o, t), mn = measure(n, t);
  row(name, `${mo.cover}% ${mo.err}px ${mo.jag} ${mo.flips}`, `${mn.cover}% ${mn.err}px ${mn.jag} ${mn.flips}`);
  if (mn.cover < 95) { failed = true; console.log("  FAIL: stroke lost coverage"); }
  if (mn.jag > mo.jag) { failed = true; console.log("  FAIL: new line is more jagged than the old one"); }
}

// Responsiveness: a quick deliberate climb (150 px up in 150 ms) in the middle of a stroke. How far behind the
// finger is the line's tip while it climbs, and at the moment of lifting? (Smaller is better; under ~10 px is
// hidden under a fingertip.)
{
  const climb = (u) => [L + PW * u, u < 0.45 ? 200 : u < 0.55 ? 200 - 1500 * (u - 0.45) : 50];
  const samples = finger(climb, 1500);
  const s = createStroke(samples[0], INPUT);
  let worst = 0, worstOld = 0, sy = samples[0].y;
  for (const p of samples.slice(1)) {
    s.move(p); sy += 0.45 * (p.y - sy);
    if (s.live) { const line = rasterize(s.points(), { cols: COLS, colX, colAt }); worst = Math.max(worst, Math.abs(line[colAt(p.x)] - p.y)); }
    worstOld = Math.max(worstOld, Math.abs(sy - p.y));
  }
  const settle = samples.findIndex((p, i) => i > samples.length * 0.55 && Math.abs(newLine(samples.slice(0, i + 1))?.[colAt(p.x)] - p.y) < 3);
  console.log(`\nQuick climb (1000 px/s): tip lag at worst ${worst.toFixed(0)} px (old ${worstOld.toFixed(0)} px), within 3 px of the finger ${((settle - samples.length * 0.55) * 16.7).toFixed(0)} ms after the climb ends.`);
  if (worst > 40) { failed = true; console.log("  FAIL: the line trails the finger"); }
}
// Undo is per stroke in game.js (one snapshot each time a stroke goes live); a turn round must redraw.
{
  const back = finger((u) => [u < 0.6 ? L + 250 * (u / 0.6) : L + 250 - 150 * ((u - 0.6) / 0.4), u < 0.6 ? 150 : 90], 1500);
  const n = newLine(back);
  const ok = Math.abs(n[colAt(L + 150)] - 90) < 6 && Math.abs(n[colAt(L + 60)] - 150) < 3;
  console.log(`Turning round redraws the part you go back over: ${ok ? "yes" : "NO"}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
