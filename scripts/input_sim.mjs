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

// Layout stability in a real browser, at iPhone 13 size in light and dark mode, on the plain site and the
// artifact bundle: the chart must not move by even half a pixel before, during or after strokes while the live
// readout changes length, and must stay put on screen even when something above it reflows mid-stroke (a late
// font swap, the error bar). Skip with NO_BROWSER=1.
if (!process.env.NO_BROWSER) failed = (await layoutCheck()) || failed;
process.exit(failed ? 1 : 0);

async function layoutCheck() {
  const { chromium, devices } = require("playwright");
  const { createServer } = await import("node:http");
  const { readFileSync, existsSync } = await import("node:fs");
  const { join, extname } = await import("node:path");
  const ROOT = new URL("..", import.meta.url).pathname;
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg" };
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/artifact.html") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>[hidden]{display:none!important}</style></head><body>${readFileSync(join(ROOT, "dist/elevation.html"), "utf8")}</body></html>`);
    }
    if (path.endsWith("/")) path += "index.html";
    const file = path.startsWith("/data/routes/") ? join(ROOT, "dist", path) : join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  }).listen(0);
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch();
  let bad = false;
  console.log("\nChart position while drawing (iPhone 13; max movement of the chart box, px):");
  const pages = existsSync(join(ROOT, "dist/elevation.html")) ? [["site", "/"], ["artifact", "/artifact.html"]] : [["site", "/"]];
  for (const [label, path] of pages) for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ ...devices["iPhone 13"], colorScheme: scheme, deviceScaleFactor: 1 });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await ctx.addInitScript(() => { try { localStorage.setItem("elevation:v1", JSON.stringify({ seenHelp: true, scoring: 2 })); } catch {} });
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + path);
    await page.waitForFunction(() => document.getElementById("from")?.textContent !== "—" && document.getElementById("chart")?.width > 0, null, { timeout: 8000 });
    await page.evaluate(() => { const c = document.getElementById("chart"); window.scrollTo(0, c.getBoundingClientRect().top + scrollY - 160); });
    await page.waitForTimeout(800);
    // Sample after each painted frame: the chart, the prompt above it and the buttons below it, plus the readout.
    await page.evaluate(() => {
      const box = (id) => { const r = document.querySelector(id).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
      window.__samples = [];
      const tick = () => { setTimeout(() => {
        window.__samples.push({ chart: box("#chart"), prompt: box("#prompt"), submit: box("#submit"), y: scrollY, readout: document.getElementById("readout").textContent });
        if (window.__rec) requestAnimationFrame(tick);
      }, 0); };
      window.__rec = true; requestAnimationFrame(tick);
    });
    const cdp = await ctx.newCDPSession(page);
    const r = await page.evaluate(() => { const b = document.getElementById("chart").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
    const send = (type, p) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [{ x: p[0], y: p[1], id: 1, radiusX: 8, radiusY: 8, force: 1 }] : [] });
    const stroke = async (path, n, during) => {
      await send("touchStart", path(0));
      for (let i = 1; i <= n; i++) { await send("touchMove", path(i / n)); if (during && i === Math.round(n / 2)) await during(); await page.waitForTimeout(16); }
      await send("touchEnd"); await page.waitForTimeout(250);
    };
    const X = (u) => r.x + 55 + (r.w - 75) * u, Y = (v) => r.y + 20 + (r.h - 55) * v;
    // Strokes that sweep the readout from the top of the axis (longest numbers) to the bottom (shortest).
    await stroke((u) => [X(u * 0.5), Y(0.02 + 0.96 * u)], 50);
    await stroke((u) => [X(0.4 + u * 0.6), Y(0.98 - 0.96 * Math.abs(Math.sin(u * 6)))], 70);
    await stroke((u) => [X(0.2 + u * 0.3), Y(0.5 + 0.45 * Math.sin(u * 9))], 40);
    const calm = await page.evaluate(() => { const s = window.__samples; window.__samples = []; return s; });
    // Reflow above the chart mid-stroke, applied the way a font swap lands (in the rendering steps of a frame).
    await stroke((u) => [X(u), Y(0.5 + 0.3 * Math.sin(u * 5))], 60, () => page.evaluate(() => requestAnimationFrame(() => {
      const st = document.createElement("style"); st.textContent = "#prompt, .route-title, .route-meta { font-size: 21px !important; letter-spacing: .04em; }";
      document.head.appendChild(st);
      const eb = document.getElementById("error-bar"); eb.hidden = false; eb.textContent = "Simulated error bar during a stroke";
    })));
    const shaken = await page.evaluate(() => { window.__rec = false; return window.__samples; });
    const spread = (ss, f) => { const v = ss.map(f); return Math.max(...v) - Math.min(...v); };
    const move = (ss, k, abs) => Math.max(...[0, 1, 2, 3].map((i) => spread(ss, (s) => s[k][i] + (abs && i === 1 ? s.y : 0))));
    const lens = new Set(calm.map((s) => s.readout.length));
    const m = { chart: move(calm, "chart", true), screen: move(calm, "chart"), prompt: move(calm, "prompt", true), submit: move(calm, "submit", true), shaken: move(shaken, "chart") };
    const ok = m.chart < 0.5 && m.screen < 0.5 && m.prompt < 0.5 && m.submit < 0.5 && m.shaken < 0.5 && lens.size >= 4 && !errors.length;
    console.log(`  ${(label + " " + scheme).padEnd(16)} ${calm.length} frames, readout lengths ${[...lens].sort((a, b) => a - b).join("/")}: chart ${m.chart.toFixed(2)} (on screen ${m.screen.toFixed(2)}), prompt ${m.prompt.toFixed(2)}, buttons ${m.submit.toFixed(2)}; with a reflow above mid-stroke: chart on screen ${m.shaken.toFixed(2)}  ${ok ? "ok" : "FAIL"}`);
    if (errors.length) console.log("  page errors:", errors.join("; "));
    if (!ok) bad = true;
    await ctx.close();
  }
  await browser.close(); server.close();
  return bad;
}
