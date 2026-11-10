// Bundle the game into one self-contained HTML file for publishing as a Claude artifact.
// Output: dist/elevation.html (CSS, data and JS inlined; no doctype/html/head/body,
// because the artifact host adds its own page skeleton). Run: npm run build
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(ROOT + p, "utf8");
const between = (src, start, end = "<!-- build:end -->") => {
  // A marker may carry a note before its closing "-->", e.g. <!-- build:artifact-head (note) -->
  const i = src.indexOf(start), k = src.indexOf("-->", i), j = src.indexOf(end, k);
  if (i < 0 || j < 0) throw new Error(`Marker ${start} not found in index.html`);
  return src.slice(k + 3, j).trim();
};
const inlineScript = (code) => `<script>\n${code.replace(/<\/script/gi, "<\\/script")}\n</script>`;

const html = read("index.html");
const stamp = new Date().toISOString().slice(5, 16).replace("T", " ") + " UTC";
const out = [
  between(html, "<!-- build:artifact-head"),
  `<style>\n${read("style.css")}\n</style>`,
  between(html, "<!-- build:artifact-body"),
  inlineScript(`window.BUILD = ${JSON.stringify(stamp)};`),
  inlineScript(read("data/routes.js")),
  inlineScript(read("data/maps.js")),
  inlineScript(read("game.js")),
].join("\n");

mkdirSync(ROOT + "dist", { recursive: true });
writeFileSync(ROOT + "dist/elevation.html", out + "\n");
console.log(`dist/elevation.html  ${(out.length / 1024).toFixed(0)} KB  build ${stamp}`);
