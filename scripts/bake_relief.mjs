// Bake a shaded-relief image for each route map into data/relief/<id>.jpg.
//
// INTERIM stand-in for satellite imagery: Claude artifacts block images from other hosts, so live satellite or
// OpenStreetMap tiles can't load at runtime (see DATA.md). This is a hillshade computed from the same AWS
// Terrain Tiles DEM the profiles use: grey where the ground faces away from a north-west sun, light where it faces
// it, and mid-grey (no change) on flat ground. The game blends it over the land colour with "soft-light" and
// clips it to the Natural Earth land shapes, so it works in light and dark mode.
// Needs data/maps/*.json (run bake_maps.mjs first). Run: npm run bake:relief
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tile } from "./lib/terrain.mjs";

const require = createRequire(import.meta.url);
const jpeg = require("jpeg-js");
const ROOT = new URL("..", import.meta.url).pathname;
const OUT = ROOT + "data/relief/";
const PX_W = 320, PX_H = 240;      // 4:3 like the map; the game scales it to the canvas
const QUALITY = 55;
mkdirSync(OUT, { recursive: true });

const maps = {};
for (const f of readdirSync(ROOT + "data/maps").sort()) Object.assign(maps, JSON.parse(readFileSync(ROOT + "data/maps/" + f, "utf8")));
const only = process.argv.slice(2);
const force = !!process.env.FORCE;

for (const [id, m] of Object.entries(maps)) {
  if (only.length && !only.includes(id)) continue;
  if (!force && !only.length && existsSync(OUT + id + ".jpg")) continue;
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
  const rgba = Buffer.alloc(PX_W * PX_H * 4);
  for (let j = 0; j < PX_H; j++) for (let i = 0; i < PX_W; i++) {
    const g = (di, dj) => G[(j + 1 + dj) * (PX_W + 2) + (i + 1 + di)];
    const dzdx = (g(1, -1) + 2 * g(1, 0) + g(1, 1) - g(-1, -1) - 2 * g(-1, 0) - g(-1, 1)) / (8 * cell);
    const dzdy = (g(-1, 1) + 2 * g(0, 1) + g(1, 1) - g(-1, -1) - 2 * g(0, -1) - g(1, -1)) / (8 * cell);
    const slope = Math.atan(exag * Math.hypot(dzdx, dzdy)), aspect = Math.atan2(dzdy, -dzdx);
    const shade = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect);
    const v = Math.max(0, Math.min(255, Math.round(128 + (shade - flat) * 300)));
    const k = (j * PX_W + i) * 4;
    rgba[k] = rgba[k + 1] = rgba[k + 2] = v; rgba[k + 3] = 255;
  }
  const out = jpeg.encode({ data: rgba, width: PX_W, height: PX_H }, QUALITY).data;
  writeFileSync(OUT + id + ".jpg", out);
  console.error(`${id.padEnd(40)} z${z} ${tiles.size} tiles  ${(out.length / 1024).toFixed(1)} KB`);
}
const files = readdirSync(OUT);
const kb = files.reduce((s, f) => s + readFileSync(OUT + f).length, 0) / 1024;
console.error(`data/relief: ${files.length} images, ${kb.toFixed(0)} KB`);
