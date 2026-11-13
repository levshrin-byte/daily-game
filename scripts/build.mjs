// Bundle the game for publishing as a Claude artifact.
// Output: dist/elevation.html, the page itself (CSS, game code and the route list inlined; no doctype/html/head/body,
// because the artifact host adds its own page skeleton), and dist/files.json, the supporting files to publish next
// to it: data/maps/*.json (route maps, ten per file) and data/relief/*.jpg (interim shaded relief, one per route).
// The game fetches those on demand, so the page stays small and paints fast. Run: npm run build
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(ROOT + p, "utf8");
const between = (src, start, end = "<!-- build:end -->") => {
  // A marker may carry a note before its closing "-->", e.g. <!-- build:artifact-head (note) -->
  const i = src.indexOf(start), k = src.indexOf("-->", i), j = src.indexOf(end, k);
  if (i < 0 || j < 0) throw new Error(`Marker ${start} not found in index.html`);
  return src.slice(k + 3, j).trim();
};
const inlineScript = (code) => `<script>\n${code.replace(/<\/script/gi, "<\\/script")}\n</script>`;

// Pack each profile into a short string: zigzag-encoded deltas, 5 bits per character, low digits first; characters
// 32-63 of the alphabet mean "more digits follow". game.js unpacks it. Values are whole metres, so this is lossless.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function pack(elev) {
  let out = "", prev = 0;
  for (const v of elev) {
    const d = v - prev; prev = v;
    let z = d < 0 ? -2 * d - 1 : 2 * d;
    while (z >= 32) { out += B64[32 + (z % 32)]; z = Math.floor(z / 32); }
    out += B64[z];
  }
  return out;
}
const window = {};
new Function("window", read("data/routes.js"))(window);
const routes = window.ROUTES.map((r) => ({ ...r, elev: pack(r.elev) }));
const routesJs = "window.ROUTES = " + JSON.stringify(routes) + ";";

const html = read("index.html");
const stamp = new Date().toISOString();
const out = [
  between(html, "<!-- build:artifact-head"),
  `<style>\n${read("style.css")}\n</style>`,
  between(html, "<!-- build:artifact-body"),
  inlineScript(`window.BUILD = ${JSON.stringify(stamp)};`),
  inlineScript(routesJs),
  inlineScript(read("data/world.js")),
  inlineScript(read("game.js")),
].join("\n");

mkdirSync(ROOT + "dist", { recursive: true });
writeFileSync(ROOT + "dist/elevation.html", out + "\n");
const files = [
  ...readdirSync(ROOT + "data/maps").sort().map((f) => "data/maps/" + f),
  ...readdirSync(ROOT + "data/relief").sort().map((f) => "data/relief/" + f),
];
writeFileSync(ROOT + "dist/files.json", JSON.stringify(files, null, 1) + "\n");
console.log(`dist/elevation.html  ${(out.length / 1024).toFixed(0)} KB  build ${stamp}  (+${files.length} files loaded on demand)`);
