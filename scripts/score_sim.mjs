// Scoring simulation: plays six kinds of made-up sketches (expert, good, rough, vague, shifted, flat) on every route
// and prints old (v1) and new (v2) score medians by terrain type and for Athens-Delphi. Used to tune SCORE in game.js.
// Run: node scripts/score_sim.mjs ['{"curve":"hill","w":4,"mix":0.4,"tol":0.01,"k":0.09,"p":1.8}']
import { readFileSync } from "node:fs";
globalThis.window = {}; eval(readFileSync(new URL("../data/routes.js", import.meta.url).pathname, "utf8"));
const R = window.ROUTES, N = 120;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const axis = (e) => ({ lo: Math.min(...e) < -50 ? -500 : 0, hi: [1000, 2500, 5000, 9000].find((t) => t >= Math.max(...e) * 1.05) || 9000 });
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const smooth = (e, w) => e.map((_, i) => mean(e.slice(Math.max(0, i - w), i + w + 1)));
const pl = (e, ks, jit) => { const knots = ks.map((k) => [Math.round(k * (N - 1)), e[Math.round(k * (N - 1))] + jit()]); const out = []; for (let i = 0; i < N; i++) { let j = 0; while (j < knots.length - 2 && knots[j + 1][0] < i) j++; const [x0, y0] = knots[j], [x1, y1] = knots[j + 1]; out.push(y0 + (y1 - y0) * (i - x0) / (x1 - x0)); } return out; };
const guesses = {
  expert: (e, sp) => smooth(e, 5).map((v) => v + (rnd() - 0.5) * 0.04 * sp),
  good: (e, sp) => { const s = smooth(e, 10), m = mean(e); const off = (rnd() - 0.5) * 0.1 * sp; return s.map((v) => m + (v - m) * 0.8 + off); },
  rough: (e, sp) => pl(smooth(e, 8), [0, .25, .5, .75, 1], () => (rnd() - 0.5) * 0.3 * sp),
  vague: (e, sp) => pl(smooth(e, 15), [0, .5, 1], () => (rnd() - 0.5) * 0.4 * sp),
  shifted: (e, sp) => { const s = smooth(e, 6); return s.map((_, i) => s[Math.min(N - 1, Math.max(0, i - 7))]); },
  flatMid: (e, sp, ax) => e.map(() => (ax.lo + ax.hi) / 2),
  flatLow: (e, sp, ax) => e.map(() => ax.lo + 0.05 * sp),
};
export function oldScore(u, e, ax) { const sp = ax.hi - ax.lo; return Math.round(100 * Math.max(0, 1 - mean(u.map((v, i) => Math.abs(v - e[i]) / sp)) / 0.25)); }
export function newScore(u, e, ax, P) {
  const sp = ax.hi - ax.lo, w = P.w;
  const err = u.map((v, i) => {
    const seg = e.slice(Math.max(0, i - w), i + w + 1), lo = Math.min(...seg), hi = Math.max(...seg);
    const env = v < lo ? lo - v : v > hi ? v - hi : 0;
    const d = P.mix * Math.abs(v - e[i]) + (1 - P.mix) * env;
    return Math.max(0, d / sp - P.tol);
  });
  const E = mean(err);
  return Math.round(P.curve==="hill" ? 100 / (1 + Math.pow(E / P.k, P.p)) : 100 * Math.exp(-Math.pow(E / P.k, P.p)));
}
const P = JSON.parse(process.argv[2] || '{"curve":"hill","w":4,"mix":0.4,"tol":0.01,"k":0.09,"p":1.8}');
const res = {};
for (const r of R) { const ax = axis(r.elev), sp = ax.hi - ax.lo;
  for (const [g, f] of Object.entries(guesses)) { seed = r.id.length * 31 + g.length; const u = f(r.elev, sp, ax).map((v) => Math.min(ax.hi, Math.max(ax.lo, v)));
    for (const [name, sc] of [["old", oldScore(u, r.elev, ax)], ["new", newScore(u, r.elev, ax, P)]]) { const k = `${g}/${r.kind}/${name}`; (res[k] ||= []).push(sc); if (r.id === "athens-delphi") (res[`${g}/ATHENS/${name}`] ||= []).push(sc); } } }
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
for (const g of Object.keys(guesses)) for (const kind of ["flat", "hilly", "mountain", "ATHENS"]) { const o = res[`${g}/${kind}/old`], n = res[`${g}/${kind}/new`]; console.log(`${g.padEnd(8)} ${kind.padEnd(8)} old med ${q(o, .5)} (p10 ${q(o, .1)})  new med ${q(n, .5)} (p10 ${q(n, .1)})`); }
