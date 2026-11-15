// Bake a shaded-relief image for each route map, ten routes per JPEG: data/relief/NNN.jpg holds routes NNN*10 ..
// NNN*10+9 in ROUTES order, each 320×240 and stacked top to bottom (game.js RELIEF_CHUNK must match). Grouping
// keeps the artifact under its file limit with two years of routes. Each route's image is computed once and kept
// in .cache/relief/<id>.gray (raw greys), so rebuilding the sheets doesn't refetch terrain.
//
// INTERIM stand-in for satellite imagery: Claude artifacts block images from other hosts, so live satellite or
// OpenStreetMap tiles can't load at runtime (see DATA.md). This is a hillshade computed from the same AWS
// Terrain Tiles DEM the profiles use: grey where the ground faces away from a north-west sun, light where it faces
// it, and mid-grey (no change) on flat ground. The game blends it over the land colour with "soft-light" and
// clips it to the Natural Earth land shapes, so it works in light and dark mode.
// Needs data/maps/*.json (run bake_maps.mjs first). Run: npm run bake:relief
//
// Routes are only ever appended to ROUTES, so a sheet that already exists with all ten rows is kept as it is (not
// re-encoded, and its routes not re-read); only the last, partly filled sheet and new ones are written. FORCE=1
// (or naming route ids) recomputes and rewrites everything.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tile } from "./lib/terrain.mjs";

const require = createRequire(import.meta.url);
const jpeg = require("jpeg-js");
const ROOT = new URL("..", import.meta.url).pathname;
const OUT = ROOT + "data/relief/";
const CACHE = ROOT + ".cache/relief/";
const CHUNK = 10;
mkdirSync(CACHE, { recursive: true });
const PX_W = 320, PX_H = 240;      // 4:3 like the map; the game scales it to the canvas
const QUALITY = 55;
mkdirSync(OUT, { recursive: true });

const maps = {};
for (const f of readdirSync(ROOT + "data/maps").sort()) Object.assign(maps, JSON.parse(readFileSync(ROOT + "data/maps/" + f, "utf8")));
const only = process.argv.slice(2);
const force = !!process.env.FORCE;

// Images baked before the sheets existed (data/relief/<id>.jpg) are reused rather than recomputed.
for (const f of readdirSync(OUT)) {
  if (!/^[a-z].*\.jpg$/.test(f)) continue;
  const id = f.slice(0, -4);
  if (!existsSync(CACHE + id + ".gray")) {
    const img = jpeg.decode(readFileSync(OUT + f), { useTArray: true });
    const g = Buffer.alloc(PX_W * PX_H);
    for (let k = 0; k < g.length; k++) g[k] = img.data[k * 4];
    writeFileSync(CACHE + id + ".gray", g);
  }
  unlinkSync(OUT + f);
}

// The sheets, in ROUTES order. A full sheet already on disk is kept.
const order = (() => { const window = {}; new Function("window", readFileSync(ROOT + "data/routes.js", "utf8"))(window); return window.ROUTES.map((r) => r.id); })();
const sheetName = (c) => OUT + String(c).padStart(3, "0") + ".jpg";
const keepSheet = (c) => !force && !only.length && (c + 1) * CHUNK <= order.length && existsSync(sheetName(c)) &&
  jpeg.decode(readFileSync(sheetName(c)), { useTArray: true }).height === PX_H * CHUNK;
const sheets = [];
for (let c = 0; c * CHUNK < order.length; c++) if (!keepSheet(c)) sheets.push(c);
const needed = new Set(sheets.flatMap((c) => order.slice(c * CHUNK, (c + 1) * CHUNK)));

for (const [id, m] of Object.entries(maps)) {
  if (only.length && !only.includes(id)) continue;
  if (!only.length && !needed.has(id)) continue;
  if (!force && !only.length && existsSync(CACHE + id + ".gray")) continue;
  const [x0, y0, w, h] = m.view;
  const px = w / PX_W;                                    // Mercator units per output pixel
  const z = Math.max(3, Math.min(12, Math.ceil(Math.log2(1 / (256 * px)))));
  const n = 256 * 2 ** z;
  // Load every tile the box touches (plus a pixel of margin for the slope kernel).
  const tx0 = Math.floor(((x0 - px) * n) / 256), tx1 = Math.floor(((x0 + w + px) * n) / 256);
  const ty0 = Math.max(0, Math.floor(((y0 - px) * n) / 256)), ty1 = Math.min(2 ** z - 1, Math.floor(((y0 + h + px) * n) / 256));
  const tiles = new Map();
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
    const wx = ((tx % 2 ** z) + 2 ** z) % 2 ** z;
    tiles.set(`${tx},${ty}`, await tile(z, wx, ty));
  }
  const pix = (gx, gy) => {
    gy = Math.max(ty0 * 256, Math.min(ty1 * 256 + 255, gy));
    const t = tiles.get(`${Math.floor(gx / 256)},${Math.floor(gy / 256)}`);
    const i = ((gy & 255) * 256 + (gx & 255)) * 4, d = t.data;
    return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
  };
  const elevAt = (mx, my) => {
    const fx = mx * n - 0.5, fy = my * n - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
    const v = (pix(ix, iy) * (1 - ax) + pix(ix + 1, iy) * ax) * (1 - ay) + (pix(ix, iy + 1) * (1 - ax) + pix(ix + 1, iy + 1) * ax) * ay;
    return Math.max(0, v);                                // sea floor is clipped away in the game anyway
  };
  // Elevation grid with a one-pixel border.
  const G = new Float32Array((PX_W + 2) * (PX_H + 2));
  for (let j = 0; j < PX_H + 2; j++) for (let i = 0; i < PX_W + 2; i++) G[j * (PX_W + 2) + i] = elevAt(x0 + (i - 0.5) * px, y0 + (j - 0.5) * px);
  // Horn's hillshade. Cell size in metres at the map's centre latitude; slopes are exaggerated a little on
  // big maps, where each pixel averages hundreds of metres of ground and real slopes look flat.
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y0 + h / 2)))), cell = px * 40075016 * Math.cos(lat);
  const exag = Math.min(5, Math.max(1, Math.sqrt(cell / 30)));
  const zen = (45 * Math.PI) / 180, az = (135 * Math.PI) / 180, flat = Math.cos(zen);
  const grey = Buffer.alloc(PX_W * PX_H);
  for (let j = 0; j < PX_H; j++) for (let i = 0; i < PX_W; i++) {
    const g = (di, dj) => G[(j + 1 + dj) * (PX_W + 2) + (i + 1 + di)];
    const dzdx = (g(1, -1) + 2 * g(1, 0) + g(1, 1) - g(-1, -1) - 2 * g(-1, 0) - g(-1, 1)) / (8 * cell);
    const dzdy = (g(-1, 1) + 2 * g(0, 1) + g(1, 1) - g(-1, -1) - 2 * g(0, -1) - g(1, -1)) / (8 * cell);
    const slope = Math.atan(exag * Math.hypot(dzdx, dzdy)), aspect = Math.atan2(dzdy, -dzdx);
    const shade = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect);
    const v = Math.max(0, Math.min(255, Math.round(128 + (shade - flat) * 300)));
    grey[j * PX_W + i] = v;
  }
  writeFileSync(CACHE + id + ".gray", grey);
  console.error(`${id.padEnd(40)} z${z} ${tiles.size} tiles`);
}

const last = Math.ceil(order.length / CHUNK);
for (const f of readdirSync(OUT)) if (!(parseInt(f, 10) < last)) unlinkSync(OUT + f);   // sheets past the end
for (const c of sheets) {
  const ids = order.slice(c * CHUNK, (c + 1) * CHUNK);
  const rgba = Buffer.alloc(PX_W * PX_H * CHUNK * 4, 128);
  ids.forEach((id, k) => {
    const g = readFileSync(CACHE + id + ".gray");
    for (let p = 0; p < g.length; p++) { const o = (k * PX_W * PX_H + p) * 4; rgba[o] = rgba[o + 1] = rgba[o + 2] = g[p]; rgba[o + 3] = 255; }
  });
  const rows = PX_H * ids.length;
  writeFileSync(sheetName(c), jpeg.encode({ data: rgba.subarray(0, PX_W * rows * 4), width: PX_W, height: rows }, QUALITY).data);
}
const files = readdirSync(OUT);
const kb = files.reduce((s, f) => s + readFileSync(OUT + f).length, 0) / 1024;
console.error(`data/relief: ${files.length} sheets for ${order.length} routes, ${kb.toFixed(0)} KB`);
