// Real elevation along a straight line, read from the AWS Terrain Tiles "terrarium" PNGs
// (https://registry.opendata.aws/terrain-tiles/). Nothing here invents terrain: every value is a
// bilinear interpolation of four real DEM pixels. Tiles are cached in .cache/tiles/.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const ROOT = new URL("../..", import.meta.url).pathname;
const CACHE = ROOT + ".cache/tiles/";
const TILE_URL = (z, x, y) => `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;
export const SAMPLES = 120;   // must match COLS in game.js

const mem = new Map();
let fetched = 0;
export const stats = () => ({ fetched, inMemory: mem.size });

export async function tile(z, x, y) {
  const key = `${z}_${x}_${y}`;
  if (mem.has(key)) return mem.get(key);
  const path = CACHE + key + ".png";
  if (!existsSync(path)) {
    mkdirSync(CACHE, { recursive: true });
    let buf, lastErr;
    for (let attempt = 0; attempt < 4 && !buf; attempt++) {
      try {
        const res = await fetch(TILE_URL(z, x, y));
        if (!res.ok) throw new Error(`HTTP ${res.status} for tile ${key}`);
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); }
    }
    if (!buf) throw lastErr;
    writeFileSync(path, buf);
    fetched++;
  }
  const png = PNG.sync.read(readFileSync(path));
  if (mem.size > 3000) mem.clear();   // keep memory bounded on long runs
  mem.set(key, png);
  return png;
}

export const merc = (lat, lon) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
};
export const unmerc = (x, y) => [(Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI, x * 360 - 180];

async function pixel(z, px, py) {
  const n = 256 * 2 ** z;
  px = ((px % n) + n) % n; py = Math.min(n - 1, Math.max(0, py));
  const t = await tile(z, Math.floor(px / 256), Math.floor(py / 256));
  const i = ((py % 256) * 256 + (px % 256)) * 4;
  return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
}

/** Bilinear-interpolated elevation in metres. */
export async function elevation(lat, lon, z) {
  const [mx, my] = merc(lat, lon);
  const n = 256 * 2 ** z, fx = mx * n - 0.5, fy = my * n - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const [e00, e10, e01, e11] = await Promise.all([pixel(z, x0, y0), pixel(z, x0 + 1, y0), pixel(z, x0, y0 + 1), pixel(z, x0 + 1, y0 + 1)]);
  return (e00 * (1 - tx) + e10 * tx) * (1 - ty) + (e01 * (1 - tx) + e11 * tx) * ty;
}

export function haversine([la1, lo1], [la2, lo2]) {
  const r = Math.PI / 180, h = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Evenly spaced points along the straight Web Mercator line, as the map draws it. */
export function linePoints(a, b, n = SAMPLES) {
  const [ax, ay] = merc(...a), [bx, by] = merc(...b);
  return Array.from({ length: n }, (_, i) => unmerc(ax + ((bx - ax) * i) / (n - 1), ay + ((by - ay) * i) / (n - 1)));
}

/** Zoom whose pixels are a few times finer than the spacing between samples (z8 to z12). */
export function zoomFor(distKm, lat) {
  const spacing = distKm / (SAMPLES - 1);
  for (let z = 8; z <= 12; z++) if ((40075 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** z) <= spacing / 3) return z;
  return 12;
}

export async function profile(a, b, z) {
  const pts = linePoints(a, b);
  let dist = 0;
  for (let i = 1; i < pts.length; i++) dist += haversine(pts[i - 1], pts[i]);
  const zoom = z ?? zoomFor(dist, (a[0] + b[0]) / 2);
  const elev = [];
  for (const [lat, lon] of pts) elev.push(await elevation(lat, lon, zoom));
  return { pts, distanceKm: dist, zoom, elev };
}
