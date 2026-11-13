// Phone-sized check at iPhone 13 size, light and dark, on the plain site and on the artifact bundle:
//  - load: the page must paint the chart and a route within 1.5 s even when Google Fonts never answers
//  - drawing with a real finger (touch events), then submit; a score and a well-formed share card must appear
//  - every visible button must be at least 44 px tall (the build stamp is exempt: it is a hidden testing switch)
//  - the map data and relief load (fetched on demand), the archive opens and replays puzzle #1
//  - testing mode: All routes → preview a future route; the preview must not change stats or the share card
// Fails on page errors, sideways scrolling or any of the above, and saves screenshots to .cache/screens/
// (or $SCREENS). Run: npm run build && npm run check
import { createServer } from "node:http";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const OUT = process.env.SCREENS || join(ROOT, ".cache/screens");
mkdirSync(OUT, { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg" };
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/artifact.html") {
    // Mimic the artifact host: wrap the bundle in a minimal page skeleton. Supporting files sit next to it.
    const body = readFileSync(join(ROOT, "dist/elevation.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>[hidden]{display:none!important}</style></head><body>${body}</body></html>`);
  }
  if (path.endsWith("/")) path += "index.html";
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(0);
const base = `http://localhost:${server.address().port}`;

// A real one-finger drag through the Chrome DevTools protocol (Playwright's touchscreen only taps).
async function fingerDraw(page, pts) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, p) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [{ x: p[0], y: p[1], id: 1, radiusX: 8, radiusY: 8, force: 1 }] : [] });
  await send("touchStart", pts[0]);
  for (const p of pts.slice(1)) { await send("touchMove", p); await page.waitForTimeout(8); }
  await send("touchEnd");
  await page.waitForTimeout(500);   // a person lifts their finger before reaching for Submit
}

const browser = await chromium.launch();
let failed = false;
for (const [label, path] of [["site", "/"], ["artifact", "/artifact.html"]]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ ...devices["iPhone 13"], colorScheme: scheme, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [], problems = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|ERR_NAME|ERR_FAILED|ERR_ABORTED/.test(m.text()) && errors.push(m.text()));
    // Google Fonts never answers: the game must still paint promptly.
    await page.route(/fonts\.(googleapis|gstatic)\.com/, () => {});
    const t0 = Date.now();
    await page.goto(base + path, { waitUntil: "commit" });
    await page.waitForFunction(() => document.getElementById("from")?.textContent !== "—" && document.getElementById("chart")?.width > 0, null, { timeout: 5000 }).catch(() => {});
    const paintMs = Date.now() - t0;
    if (paintMs > 1500) problems.push(`slow first paint ${paintMs} ms`);
    // The page's load event must not wait for fonts or other slow hosts (the artifact host times out on it).
    await page.waitForFunction(() => document.readyState === "complete", null, { timeout: 5000 }).catch(() => {});
    const loadMs = Math.round(await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.loadEventEnd || -1));
    if (loadMs < 0 || loadMs > 1500) problems.push(`load event ${loadMs < 0 ? "never fired" : loadMs + " ms"}`);
    await page.waitForTimeout(3000);   // onboarding demo, map and relief fetches
    if (label === "site") await page.screenshot({ path: join(OUT, `${label}-${scheme}-help.png`) });
    if (await page.locator("#help[open]").count()) await page.tap("#help-close");
    await page.tap(`#units button[data-u="${scheme === "dark" ? "imperial" : "metric"}"]`);

    const mapState = await page.evaluate(() => ({ map: !!Object.keys(window.MAPS || {}).length }));
    if (!mapState.map) problems.push("route map did not load");

    // Tap targets: every visible button at least 44 px tall.
    const small = await page.evaluate(() => [...document.querySelectorAll("button, summary, input")].filter((b) => {
      const r = b.getBoundingClientRect(); return r.width && r.height && b.id !== "build-tag" && r.height < 43.5;
    }).map((b) => `${b.id || b.textContent.trim().slice(0, 16)} ${Math.round(b.getBoundingClientRect().height)}px`));
    if (small.length) problems.push("small tap targets: " + small.join(", "));

    await page.locator("#chart").scrollIntoViewIfNeeded();
    const box = await page.locator("#chart").boundingBox();
    const pts = Array.from({ length: 41 }, (_, i) => [box.x + 52 + (box.width - 64) * (i / 40), box.y + 170 - 70 * Math.sin(i / 8)]);
    await fingerDraw(page, pts);
    const cover = await page.evaluate(() => parseFloat(document.getElementById("coverage-bar").style.width));
    if (!(cover > 90)) problems.push(`finger drawing covered only ${cover}%`);
    await page.tap("#submit");
    await page.waitForTimeout(2600);   // reveal + score count-up

    const info = await page.evaluate(() => ({
      title: `${document.getElementById("puzzle-no").textContent} ${document.getElementById("puzzle-date").textContent} ${document.getElementById("difficulty").textContent}`,
      score: document.getElementById("score").textContent,
      takeaway: document.getElementById("takeaway").textContent,
      share: document.getElementById("share-preview").textContent,
      route: `${document.getElementById("from").textContent} → ${document.getElementById("to").textContent}`,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      errorBar: document.getElementById("error-bar").hidden ? "" : document.getElementById("error-bar").textContent,
    }));
    const shot = join(OUT, `${label}-${scheme}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const shareOk = /^Elevation #\d+ · [A-Z][a-z]{2} \d+ ⛰️\n[🟩🟨🟧🟥]{5} \d+\/100/u.test(info.share);
    if (!shareOk) problems.push("bad share card " + JSON.stringify(info.share));
    if (!info.takeaway) problems.push("no takeaway line");
    // Details expander
    if (await page.locator("#result").isHidden()) { console.log(`FAIL ${label}/${scheme}: no result after submit`, problems, errors, await page.evaluate(() => [document.getElementById("prompt").textContent, document.querySelector(".toast").textContent, document.getElementById("coverage-bar").style.width, document.getElementById("submit").getBoundingClientRect().y])); failed = true; await ctx.close(); continue; }
    await page.tap(".details summary");
    await page.waitForTimeout(150);
    if (label === "site") await page.locator("#result").screenshot({ path: join(OUT, `${label}-${scheme}-details.png`) });

    // Archive: open it, replay the oldest puzzle.
    await page.tap("#archive-btn");
    await page.waitForTimeout(300);
    const rows = await page.locator(".arch-row").count();
    if (label === "site") await page.screenshot({ path: join(OUT, `${label}-${scheme}-archive.png`) });
    await page.locator('.arch-row[data-n="1"]').tap();
    await page.waitForTimeout(400);
    const replay = await page.evaluate(() => ({ no: document.getElementById("puzzle-no").textContent, hash: location.hash }));
    if (!(rows >= 1 && replay.no === "#1" && (rows === 1 || replay.hash === "#p1"))) problems.push("archive replay failed " + JSON.stringify(replay));

    // Testing mode: five taps on the build stamp, then preview route #300 from All routes.
    const before = await page.evaluate(() => localStorage.getItem("elevation:v1"));
    for (let i = 0; i < 5; i++) await page.locator("#build-tag").click();
    await page.tap("#archive-btn");
    await page.tap('#archive-tabs button[data-tab="all"]');
    await page.fill("#route-search", "300");
    const allRows = await page.locator(".arch-row[data-t]:visible").count();
    if (label === "site") await page.screenshot({ path: join(OUT, `${label}-${scheme}-routes.png`) });
    await page.locator('.arch-row[data-t="300"]').tap();
    await page.waitForTimeout(400);
    await page.locator("#chart").scrollIntoViewIfNeeded();
    const box2 = await page.locator("#chart").boundingBox();
    await fingerDraw(page, Array.from({ length: 31 }, (_, i) => [box2.x + 52 + (box2.width - 64) * (i / 30), box2.y + 150]));
    await page.tap("#submit");
    await page.waitForTimeout(2600);
    const pv = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("elevation:v1"));
      return { no: document.getElementById("puzzle-no").textContent, hash: location.hash, shareHidden: document.getElementById("share-box").hidden,
        noteShown: !document.getElementById("preview-note").hidden, previewSaved: !!s.previews["300"], resultsKeys: Object.keys(s.results) };
    });
    const beforeKeys = Object.keys(JSON.parse(before).results);
    const previewOk = pv.no === "Preview #300" && pv.hash === "#t300" && pv.shareHidden && pv.noteShown && pv.previewSaved && JSON.stringify(pv.resultsKeys) === JSON.stringify(beforeKeys);
    if (!previewOk) problems.push("preview failed " + JSON.stringify(pv));
    if (label === "site" && scheme === "light") await page.screenshot({ path: join(OUT, `${label}-${scheme}-preview.png`), fullPage: true });

    const after = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > window.innerWidth, errorBar: document.getElementById("error-bar").hidden ? "" : document.getElementById("error-bar").textContent }));
    if (info.overflow || after.overflow) problems.push("sideways scroll");
    // Nothing tappable may hang off the side of the screen (the header with testing mode on, for example).
    const offscreen = await page.evaluate(() => [...document.querySelectorAll("header button, .puzzle-bar button, main button")]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1); }).map((b) => b.id || b.textContent.trim()));
    if (offscreen.length) problems.push("off-screen buttons: " + offscreen.join(", "));
    if (info.errorBar || after.errorBar) problems.push("error bar: " + (info.errorBar || after.errorBar));
    if (errors.length) problems.push("errors: " + errors.join(" | "));
    const ok = !problems.length;
    failed ||= !ok;
    console.log(`${ok ? "PASS" : "FAIL"} ${label}/${scheme}: paint ${paintMs} ms, load ${loadMs} ms | ${info.title} | ${info.route}, score ${info.score} ` +
      `"${info.takeaway}" | archive ${rows} rows, all routes search → ${allRows} | ${problems.join("; ")}  → ${shot}`);
    await ctx.close();
  }
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
