// Build the game for its two homes, from the same index.html, style.css, drawing.js and game.js.
//
//   npm run build        → dist/elevation.html + dist/files.json: the Claude artifact used for testing. The page
//                          has no doctype/html/head/body (the artifact host adds its own skeleton) and carries the
//                          CSS, the code and the routes for the first weeks inline; dist/files.json maps each
//                          supporting file's published path to its source, for the Artifact publish.
//   npm run build:site   → dist/site/: the hosted static site (see DEPLOY.md). A full HTML page with social tags,
//                          a web app manifest, icons, a service worker, content-hashed code and a versioned data
//                          folder, plus _headers with caching and security headers. Nothing is deployed.
//
// Both builds write the route files the game loads on demand: data/routes/NN.json (50 routes each, packed) and
// data/routes/index.json (names and distances, for the route search). Maps (data/maps/NN.json) and the shaded relief
// (data/relief/NNN.jpg) are used as they are.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, copyFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

const ROOT = new URL("..", import.meta.url).pathname;
const TARGET = process.argv[2] === "site" ? "site" : "artifact";
const read = (p) => readFileSync(ROOT + p, "utf8");
const between = (src, start, end = "<!-- build:end -->") => {
  // A marker may carry a note before its closing "-->", e.g. <!-- build:artifact-head (note) -->
  const i = src.indexOf(start), k = src.indexOf("-->", i), j = src.indexOf(end, k);
  if (i < 0 || j < 0) throw new Error(`Marker ${start} not found in index.html`);
  return src.slice(k + 3, j).trim();
};
const inlineScript = (code) => `<script>\n${code.replace(/<\/script/gi, "<\\/script")}\n</script>`;
const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 10);
const write = (p, data) => { mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); writeFileSync(p, data); };

// ---------- Routes ----------
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
new Function("window", read("data/routes.js") + read("data/days.js"))(window);
const routes = window.ROUTES.map((r) => ({ ...r, elev: pack(r.elev) }));
const DAYS = window.DAYS;
const ROUTE_CHUNK = 50;   // must match game.js

// The page carries the routes of the days up to a month after the build (and the first five, which old saved
// results refer to); everything else loads on demand, so the page stays small however long the list grows.
const LAUNCH = Date.UTC(2026, 10, 9);   // must match game.js
const buildDay = Math.floor((Date.now() - LAUNCH) / 864e5) + 1;
const AHEAD = 30;
const core = new Set([0, 1, 2, 3, 4]);
for (let n = 1; n <= Math.min(DAYS.length, buildDay + AHEAD); n++) DAYS[n - 1].forEach((i) => core.add(i));
const coreJs = `window.ROUTE_COUNT = ${routes.length};\nwindow.ROUTES = ` +
  JSON.stringify([...core].sort((a, b) => a - b).map((i) => ({ ...routes[i], i }))) + ";";

const DIST = ROOT + "dist/";
function writeRouteFiles(dir) {
  rmSync(dir + "routes", { recursive: true, force: true });
  for (let c = 0; c * ROUTE_CHUNK < routes.length; c++)
    write(`${dir}routes/${String(c).padStart(2, "0")}.json`, JSON.stringify(routes.slice(c * ROUTE_CHUNK, (c + 1) * ROUTE_CHUNK)));
  write(dir + "routes/index.json", JSON.stringify(routes.map((r) => [r.id, r.from, r.to, r.country, r.region, Math.round(r.distanceKm)])));
}
const dataFiles = (sub) => readdirSync(ROOT + "data/" + sub).sort().map((f) => `data/${sub}/${f}`);

const html = read("index.html");
const stamp = new Date().toISOString();
const appCode = (config) => [
  `window.BUILD = ${JSON.stringify(stamp)};`,
  config,
  coreJs,
  read("data/days.js"),
  read("data/world.js"),
  read("drawing.js"),
  read("game.js"),
];

if (TARGET === "artifact") {
  // ---------- Claude artifact ----------
  // No outside hosts are reachable from an artifact, so no tiles, ads or service worker.
  const config = `window.ELEVATION_CONFIG = ${JSON.stringify({ target: "artifact", data: "data/", sw: false, tiles: null, ads: null })};`;
  const out = [
    between(html, "<!-- build:artifact-head"),
    `<style>\n${read("style.css")}\n</style>`,
    between(html, "<!-- build:artifact-body"),
    ...appCode(config).map(inlineScript),
  ].join("\n");
  writeRouteFiles(DIST + "data/");
  write(DIST + "elevation.html", out + "\n");
  const files = {};
  for (const f of readdirSync(DIST + "data/routes").sort()) files[`data/routes/${f}`] = `dist/data/routes/${f}`;
  for (const f of [...dataFiles("maps"), ...dataFiles("relief")]) files[f] = f;
  write(DIST + "files.json", JSON.stringify(files, null, 1) + "\n");
  console.log(`dist/elevation.html  ${(out.length / 1024).toFixed(0)} KB  build ${stamp}  ${core.size} of ${routes.length} routes inline  (+${Object.keys(files).length} files loaded on demand)`);
} else {
  // ---------- Hosted static site ----------
  const SITE = DIST + "site/";
  const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");   // e.g. https://example.com once there is a domain
  rmSync(SITE, { recursive: true, force: true });
  // Data: one folder named after a hash of its contents, so it can be cached for good and changes on any rebake.
  const sources = [...dataFiles("maps"), ...dataFiles("relief")];
  const h = createHash("sha256");
  for (const f of sources) h.update(f).update(readFileSync(ROOT + f));
  h.update(JSON.stringify(routes));
  const dataDir = `data/${h.digest("hex").slice(0, 10)}/`;
  for (const f of sources) { mkdirSync(SITE + dataDir + f.split("/")[1], { recursive: true }); copyFileSync(ROOT + f, SITE + dataDir + f.slice(5)); }
  writeRouteFiles(SITE + dataDir);

  const siteConfig = read("config.js").replace(/\}, window\.ELEVATION_CONFIG\);\s*$/, `}, window.ELEVATION_CONFIG, ${JSON.stringify({ sw: true, data: dataDir })});\n`);
  if (!siteConfig.includes(dataDir)) throw new Error("config.js: couldn't set the data folder");
  const app = appCode(siteConfig).join("\n");
  const appFile = `app.${hash(app)}.js`, css = read("style.css"), cssFile = `style.${hash(css)}.css`;
  write(SITE + appFile, app);
  write(SITE + cssFile, css);
  for (const f of readdirSync(ROOT + "icons")) copyFileSync(ROOT + "icons/" + f, (mkdirSync(SITE + "icons", { recursive: true }), SITE + "icons/" + f));
  copyFileSync(ROOT + "manifest.webmanifest", SITE + "manifest.webmanifest");

  // The page: index.html with the hashed files in place of the development ones.
  let page = html
    .replace('<link rel="stylesheet" href="style.css">', `<link rel="stylesheet" href="${cssFile}">`)
    .replace(/\s*<script src="config\.js"><\/script>[\s\S]*?<script src="game\.js"><\/script>/, `\n  <script src="${appFile}"></script>`);
  if (!page.includes(appFile) || !page.includes(cssFile)) throw new Error("index.html: couldn't swap in the built files");
  page = page.replace(/<!-- build:[^>]*-->\n?/g, "");
  if (SITE_URL) page = page
    .replace(/(<meta property="og:image" content=")([^"]+)"/, `$1${SITE_URL}/$2"`)
    .replace(/(<meta name="twitter:image" content=")([^"]+)"/, `$1${SITE_URL}/$2"`)
    .replace("</title>", `</title>\n  <link rel="canonical" href="${SITE_URL}/">\n  <meta property="og:url" content="${SITE_URL}/">`);
  write(SITE + "index.html", page);

  // Service worker: the app shell is cached on install; data and hashed files are cached as they are used.
  const shell = ["./", appFile, cssFile, "manifest.webmanifest", "icons/icon-192.png"];
  write(SITE + "sw.js", read("sw.js").replace('"__VERSION__"', JSON.stringify(hash(app + css + dataDir))).replace("[/*__SHELL__*/]", JSON.stringify(shell)));
  copyFileSync(ROOT + "site/_headers", SITE + "_headers");
  copyFileSync(ROOT + "site/robots.txt", SITE + "robots.txt");
  const size = (p) => statSync(SITE + p).size / 1024;
  console.log(`dist/site/  index.html ${size("index.html").toFixed(0)} KB, ${appFile} ${size(appFile).toFixed(0)} KB, ${cssFile} ${size(cssFile).toFixed(0)} KB, ` +
    `${dataDir} (${sources.length} map and relief files + route files)  build ${stamp}${SITE_URL ? "" : "  (no SITE_URL: social image links are relative)"}`);
}
