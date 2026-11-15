// Phone-sized check at iPhone 13 size, light and dark, on the plain site and on the artifact bundle:
//  - load: the page must paint the chart and a route within 1.5 s even when Google Fonts never answers
//  - drawing is deliberate: a tap, a tiny wobble and a second finger draw nothing; a real drag draws; a shaky
//    finger is smoothed; Undo takes back one stroke at a time; Clear can be undone
//  - three routes a day: the Easy/Medium/Hard tabs switch routes and keep unfinished drawings; after a submit,
//    "Next" goes to the next route of the day; the share card covers the day
//  - every visible button must be at least 44 px tall (the build stamp is exempt)
//  - the map data and relief load, the calendar opens and replays day 1's Easy route
//  - previews: Help → "Preview any route" → search → Preview → draw and submit; nothing may change in results,
//    stats, streak or the share card; Exit preview goes back to today
//  - long routes: the "150+ mi" length filter shows only routes that long; the newest one previews and scores
//  - the artifact run makes history.replaceState throw, as it does in a sandboxed frame
//  - results saved by the one-a-day version are moved to the matching day and difficulty
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

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png", ".webmanifest": "application/manifest+json" };
// The hosted build is served under /site/ with the Content-Security-Policy from its own _headers file, so a
// resource the policy would block fails here too.
const siteCsp = existsSync(join(ROOT, "dist/site/_headers")) ? (/Content-Security-Policy: (.*)/.exec(readFileSync(join(ROOT, "dist/site/_headers"), "utf8")) || [])[1] : null;
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.startsWith("/site/")) {
    if (path.endsWith("/")) path += "index.html";
    const file = join(ROOT, "dist", path);
    if (!file.startsWith(join(ROOT, "dist/site")) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", ...(siteCsp ? { "content-security-policy": siteCsp } : {}) });
    return res.end(readFileSync(file));
  }
  if (path === "/artifact.html") {
    // Mimic the artifact host: wrap the bundle in a minimal page skeleton. Supporting files sit next to it.
    const body = readFileSync(join(ROOT, "dist/elevation.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>[hidden]{display:none!important}</style></head><body>${body}</body></html>`);
  }
  if (path.endsWith("/")) path += "index.html";
  // Route files written by the build (dist/data/routes) sit next to the artifact page, as when published.
  const file = path.startsWith("/data/routes/") ? join(ROOT, "dist", path) : join(ROOT, path);
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

// Several fingers at once: each step is a list of touch points (or [] to lift all).
async function touches(page, steps) {
  const cdp = await page.context().newCDPSession(page);
  for (const [type, pts] of steps) {
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 })) });
    await page.waitForTimeout(8);
  }
  await page.waitForTimeout(150);
}
const coverage = (page) => page.evaluate(() => parseFloat(document.getElementById("coverage-bar").style.width) || 0);
const store = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("elevation:v1") || "{}"));

const browser = await chromium.launch();
let failed = false;
// A stand-in map tile (see-through, so screenshots still show the map), so tests never call the real
// OpenStreetMap servers.
const { PNG } = require("pngjs");
const TILE = PNG.sync.write(new PNG({ width: 1, height: 1 }));
for (const [label, path] of [["site", "/"], ["artifact", "/artifact.html"], ["hosted", "/site/"]]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ ...devices["iPhone 13"], colorScheme: scheme, deviceScaleFactor: 2 });
    // In a sandboxed frame the history API throws; the game must not care.
    if (label === "artifact") await ctx.addInitScript(() => { history.replaceState = () => { throw new DOMException("blocked", "SecurityError"); }; });
    // Hosted run with ads on (structure only): slots must reserve their space and never touch the game.
    if (label === "hosted") await ctx.addInitScript(() => { window.ELEVATION_CONFIG = { ads: { enabled: true } }; });
    let tileRequests = 0;
    await ctx.route(/tile\.openstreetmap\.org/, (r) => { tileRequests++; r.fulfill({ status: 200, contentType: "image/png", body: TILE }); });
    const page = await ctx.newPage();
    const errors = [], problems = [];
    if (label === "hosted") await page.addInitScript(() => {
      window.__cls = 0;
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}
    });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => (m.type() === "error" && !/fonts\.g|ERR_TUNNEL|ERR_NAME|ERR_FAILED|ERR_ABORTED/.test(m.text()) || /Content Security Policy|Refused to/.test(m.text())) && errors.push(m.text()));
    await page.route(/fonts\.(googleapis|gstatic)\.com/, () => {});
    const t0 = Date.now();
    await page.goto(base + path, { waitUntil: "commit" });
    await page.waitForFunction(() => document.getElementById("from")?.textContent !== "—" && document.getElementById("chart")?.width > 0, null, { timeout: 5000 }).catch(() => {});
    const paintMs = Date.now() - t0;
    if (paintMs > 1500) problems.push(`slow first paint ${paintMs} ms`);
    await page.waitForFunction(() => document.readyState === "complete", null, { timeout: 5000 }).catch(() => {});
    const loadMs = Math.round(await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.loadEventEnd || -1));
    if (loadMs < 0 || loadMs > 1500) problems.push(`load event ${loadMs < 0 ? "never fired" : loadMs + " ms"}`);
    await page.waitForTimeout(3000);
    // Layout shift while the page loads and settles, before any tap (the result card appearing later is the game).
    const loadCls = label === "hosted" ? await page.evaluate(() => +window.__cls.toFixed(3)) : 0;
    if (label === "site") await page.screenshot({ path: join(OUT, `${label}-${scheme}-help.png`) });
    if (await page.locator("#help[open]").count()) await page.tap("#help-close");
    await page.tap(`#units button[data-u="${scheme === "dark" ? "imperial" : "metric"}"]`);
    if (!(await page.evaluate(() => !!Object.keys(window.MAPS || {}).length))) problems.push("route map did not load");

    const small = await page.evaluate(() => [...document.querySelectorAll("button, summary, input")].filter((b) => {
      const r = b.getBoundingClientRect(); return r.width && r.height && b.id !== "build-tag" && r.height < 43.5;
    }).map((b) => `${b.id || b.textContent.trim().slice(0, 16)} ${Math.round(b.getBoundingClientRect().height)}px`));
    if (small.length) problems.push("small tap targets: " + small.join(", "));

    // ---- Deliberate drawing
    await page.locator("#chart").scrollIntoViewIfNeeded();
    const box = await page.locator("#chart").boundingBox();
    const X = (f) => box.x + 52 + (box.width - 64) * f, cy = box.y + 150;
    await touches(page, [["touchStart", [[X(0.3), cy, 1]]], ["touchEnd", []]]);                       // a tap
    await touches(page, [["touchStart", [[X(0.5), cy, 1]]], ["touchMove", [[X(0.5) + 4, cy + 5, 1]]], ["touchMove", [[X(0.5) + 6, cy - 3, 1]]], ["touchEnd", []]]); // a wobble
    await touches(page, [["touchStart", [[X(0.6), cy, 1], [X(0.2), cy + 40, 2]]], ["touchMove", [[X(0.8), cy + 30, 1], [X(0.4), cy, 2]]], ["touchEnd", []]]); // two fingers
    const strayCover = await coverage(page);
    if (strayCover !== 0) problems.push(`stray touches drew ${strayCover}%`);
    // First half, with a shaky finger (±12 px every event)
    const shaky = Array.from({ length: 41 }, (_, i) => [X(0.5 * i / 40), cy - 40 * Math.sin(i / 8) + (i % 2 ? 12 : -12)]);
    await fingerDraw(page, shaky);
    const half = await coverage(page);
    const draft = Object.values((await store(page)).drafts || {})[0] || [];
    const vals = draft.filter((v) => v != null), jumps = vals.slice(1).map((v, i) => Math.abs(v - vals[i]));
    if (!(half > 40 && half < 60)) problems.push(`first stroke covered ${half}%`);
    // Second half
    await fingerDraw(page, Array.from({ length: 31 }, (_, i) => [X(0.5 + 0.5 * i / 30), cy + 20 - 50 * Math.sin(i / 7)]));
    const full = await coverage(page);
    if (!(full > 90)) problems.push(`finger drawing covered only ${full}%`);
    await page.tap("#undo"); const afterUndo = await coverage(page);
    if (afterUndo !== half) problems.push(`undo went to ${afterUndo}% (expected ${half}%)`);
    await page.tap("#clear"); const afterClear = await coverage(page);
    await page.tap("#undo"); const afterUndo2 = await coverage(page);
    if (afterClear !== 0 || afterUndo2 !== half) problems.push(`clear/undo: ${afterClear}% then ${afterUndo2}%`);

    // ---- Switch to Medium and back: the unfinished drawing must survive
    const easyRoute = await page.textContent("#from");
    await page.tap('#tiers button[data-tier="1"]');
    const medRoute = await page.textContent("#from"), medCover = await coverage(page);
    await page.tap('#tiers button[data-tier="0"]');
    const backCover = await coverage(page);
    if (medRoute === easyRoute || medCover !== 0 || backCover !== half) problems.push(`tier switch: ${easyRoute}/${medRoute} ${medCover}% back ${backCover}%`);
    await page.locator("#chart").scrollIntoViewIfNeeded();
    await fingerDraw(page, Array.from({ length: 31 }, (_, i) => [X(0.45 + 0.55 * i / 30), cy + 20 - 50 * Math.sin(i / 7)]));
    if (label === "site") await page.locator(".draw").screenshot({ path: join(OUT, `${label}-${scheme}-drawing.png`) });
    await page.tap("#submit");
    await page.waitForTimeout(2600);

    const info = await page.evaluate(() => ({
      title: `${document.getElementById("puzzle-no").textContent} ${document.getElementById("puzzle-date").textContent}`,
      tiers: [...document.querySelectorAll("#tiers .t-state")].map((e) => e.textContent).join("|"),
      score: document.getElementById("score").textContent,
      takeaway: document.getElementById("takeaway").textContent,
      share: document.getElementById("share-preview").textContent,
      next: document.querySelector("#day-next [data-go]")?.textContent || "",
      route: `${document.getElementById("from").textContent} → ${document.getElementById("to").textContent}`,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }));
    if (label === "hosted") {
      const h = await page.evaluate(async () => {
        const reg = await Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 4000))]);
        const slots = [...document.querySelectorAll(".ad-slot")].map((el) => ({ ad: el.dataset.ad, shown: !el.hidden && el.getBoundingClientRect().height > 0, h: Math.round(el.querySelector(".ad-fill").getBoundingClientRect().height) }));
        const game = ["#chart", "#undo", "#clear", "#submit", "#map", "#tiers"].map((s) => document.querySelector(s).getBoundingClientRect());
        const overlap = [...document.querySelectorAll(".ad-slot:not([hidden])")].some((el) => { const a = el.getBoundingClientRect(); return game.some((g) => g.width && a.left < g.right && a.right > g.left && a.top < g.bottom + 24 && a.bottom > g.top - 24); });
        return { sw: reg, slots, overlap, manifest: !!document.querySelector('link[rel="manifest"]'), og: !!document.querySelector('meta[property="og:image"]'), note: document.getElementById("map-note").textContent };
      });
      const want = h.slots.find((x) => x.ad === "below-game"), inResult = h.slots.find((x) => x.ad === "result");
      if (!h.sw) problems.push("service worker didn't register");
      if (!want?.shown || want.h !== 100 || !inResult?.shown || inResult.h !== 250) problems.push("ad slots not reserved: " + JSON.stringify(h.slots));
      if (h.overlap) problems.push("an ad slot sits within 24 px of the game");
      if (loadCls > 0.05) problems.push(`layout shift while loading ${loadCls}`);
      if (!h.manifest || !h.og) problems.push("missing manifest or social tags");
      if (!tileRequests || !/OpenStreetMap/.test(h.note)) problems.push(`map tiles: ${tileRequests} requests, note "${h.note}"`);
    }
    const shot = join(OUT, `${label}-${scheme}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    if (await page.locator("#result").isHidden()) { console.log(`FAIL ${label}/${scheme}: no result after submit`, problems, errors); failed = true; await ctx.close(); continue; }
    const shareOk = /^Elevation #\d+ · [A-Z][a-z]{2} \d+ ⛰️\nEasy   [🟩🟨🟧🟥]{5} \d+\nMedium ⬜{5} –\nHard   ⬜{5} –$/u.test(info.share);
    if (!shareOk) problems.push("bad share card " + JSON.stringify(info.share));
    if (!info.takeaway) problems.push("no takeaway line");
    if (!/Next: Medium/.test(info.next)) problems.push("no Next button: " + info.next);
    await page.tap(".details summary");
    await page.waitForTimeout(150);
    if (label === "site") await page.locator("#result").screenshot({ path: join(OUT, `${label}-${scheme}-details.png`) });
    await page.tap("#day-next [data-go]");
    await page.waitForTimeout(400);
    const tierNow = await page.evaluate(() => document.querySelector('#tiers button[aria-pressed="true"]')?.dataset.tier);
    if (tierNow !== "1") problems.push("Next didn't open Medium");

    // ---- Calendar: replay day 1, Easy
    await page.tap("#archive-btn");
    await page.waitForTimeout(300);
    const days = await page.locator(".arch-day").count();
    if (label === "site") await page.screenshot({ path: join(OUT, `${label}-${scheme}-archive.png`) });
    await page.locator('.arch-cell[data-n="1"][data-tier="0"]').tap();
    await page.waitForTimeout(400);
    const replay = await page.evaluate(() => ({ no: document.getElementById("puzzle-no").textContent, hash: location.hash, tier: document.querySelector('#tiers button[aria-pressed="true"]')?.dataset.tier, from: document.getElementById("from").textContent }));
    if (!(days >= 1 && replay.no === "#1" && replay.tier === "0" && replay.from === "Denver" && (label === "artifact" || days === 1 || replay.hash === "#p1e"))) problems.push("archive replay failed " + JSON.stringify(replay));

    // ---- Previews, through the visible way in: Help → "Preview any route"
    let longInfo = "";
    const before = await store(page);
    const streakBefore = await page.evaluate(() => document.getElementById("streak-chip").textContent);
    await page.tap("#help-btn");
    await page.tap("#help-preview");
    await page.waitForSelector(".arch-row[data-t]", { timeout: 5000 }).catch(() => {});
    await page.fill("#route-search", "100");
    const allRows = await page.locator(".arch-row[data-t]:visible").count();
    if (label === "site") await page.screenshot({ path: join(OUT, `${label}-${scheme}-routes.png`) });
    const target = page.locator(".arch-row[data-t]:visible").nth(2);   // day 100, Hard
    const no = await target.getAttribute("data-t");
    await target.tap();
    await page.waitForTimeout(400);
    await page.locator("#chart").scrollIntoViewIfNeeded();
    const box2 = await page.locator("#chart").boundingBox();
    await fingerDraw(page, Array.from({ length: 31 }, (_, i) => [box2.x + 52 + (box2.width - 64) * (i / 30), box2.y + 150]));
    await page.tap("#submit");
    await page.waitForTimeout(2600);
    const after = await store(page);
    const pv = await page.evaluate(() => ({ what: document.getElementById("preview-what").textContent, hash: location.hash, shareHidden: document.getElementById("share-box").hidden,
      noteShown: !document.getElementById("preview-note").hidden, barShown: !document.getElementById("preview-bar").hidden, tiersHidden: document.getElementById("tiers").hidden,
      streak: document.getElementById("streak-chip").textContent, score: document.getElementById("score").textContent }));
    const previewOk = allRows === 3 && pv.what.startsWith(`Route ${no}: day 100, Hard`) && (label === "artifact" || pv.hash === `#t${no}`) && pv.shareHidden && pv.noteShown && pv.barShown && pv.tiersHidden &&
      !!after.previews[no] && JSON.stringify(after.days) === JSON.stringify(before.days) && pv.streak === streakBefore;
    if (!previewOk) problems.push("preview failed " + JSON.stringify({ allRows, no, ...pv }));
    if (label === "site" && scheme === "light") await page.screenshot({ path: join(OUT, `${label}-${scheme}-preview.png`), fullPage: true });
    await page.tap("#exit-preview-2");
    await page.waitForTimeout(300);
    const exited = await page.evaluate(() => ({ bar: document.getElementById("preview-bar").hidden, no: document.getElementById("puzzle-no").textContent }));
    if (!exited.bar) problems.push("Exit preview failed");

    // ---- Long routes (150-300 mi): the length filter in "All routes", then preview the last (newest) long route
    await page.tap("#help-btn");
    await page.tap("#help-preview");
    await page.waitForSelector(".arch-row[data-t]", { timeout: 5000 }).catch(() => {});
    await page.fill("#route-search", "");
    await page.tap('#route-length button[data-len="1"]');
    const lenInfo = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".arch-row[data-t]")].filter((b) => !b.parentElement.hidden);
      const btns = [...document.querySelectorAll("#route-length button")];
      return { label: btns[1].textContent, shown: rows.length, minKm: Math.min(...rows.map((b) => +b.dataset.km)), small: btns.filter((x) => x.getBoundingClientRect().height < 43.5).length,
        summary: document.getElementById("archive-summary").textContent, rowText: rows.at(-1)?.querySelector(".arch-date").textContent };
    });
    const wantMin = (scheme === "dark" ? 150 / 0.621371 : 250) - 0.5;   // shown rounded, as the list shows it
    if (!(lenInfo.shown > 300 && lenInfo.minKm >= wantMin && !lenInfo.small && /Showing/.test(lenInfo.summary))) problems.push("length filter failed " + JSON.stringify(lenInfo));
    if (label === "site") await page.screenshot({ path: join(OUT, `${label}-${scheme}-long-list.png`) });
    const longRow = page.locator(".arch-row[data-t]:visible").last();
    const longNo = await longRow.getAttribute("data-t");
    await longRow.scrollIntoViewIfNeeded();
    await longRow.tap();
    await page.waitForTimeout(600);
    await page.locator("#chart").scrollIntoViewIfNeeded();
    const box3 = await page.locator("#chart").boundingBox();
    await fingerDraw(page, Array.from({ length: 41 }, (_, i) => [box3.x + 52 + (box3.width - 64) * (i / 40), box3.y + 110 + 40 * Math.sin(i / 4)]));
    await page.tap("#submit");
    await page.waitForTimeout(2600);
    const longPv = await page.evaluate(() => ({ what: document.getElementById("preview-what").textContent, dist: document.getElementById("distance").textContent, score: document.getElementById("score").textContent }));
    if (!(longPv.what.startsWith(`Route ${longNo}:`) && /\d/.test(longPv.score))) problems.push("long route preview failed " + JSON.stringify(longPv));
    await page.screenshot({ path: join(OUT, `${label}-${scheme}-long.png`), fullPage: true });
    longInfo = `long filter ${lenInfo.label} → ${lenInfo.shown}, route ${longNo} ${longPv.dist} score ${longPv.score}`;
    await page.tap("#exit-preview-2");
    await page.waitForTimeout(300);

    if (label === "artifact" && tileRequests) problems.push(`the artifact asked for ${tileRequests} map tiles`);

    const end = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > window.innerWidth, errorBar: document.getElementById("error-bar").hidden ? "" : document.getElementById("error-bar").textContent }));
    if (info.overflow || end.overflow) problems.push("sideways scroll");
    const offscreen = await page.evaluate(() => [...document.querySelectorAll("header button, .puzzle-bar button, .tiers button, main button")]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1); }).map((b) => b.id || b.textContent.trim()));
    if (offscreen.length) problems.push("off-screen buttons: " + offscreen.join(", "));
    if (end.errorBar) problems.push("error bar: " + end.errorBar);
    if (errors.length) problems.push("errors: " + errors.join(" | "));
    const ok = !problems.length;
    failed ||= !ok;
    const maxJump = jumps.length ? Math.round(Math.max(...jumps)) : -1;
    console.log(`${ok ? "PASS" : "FAIL"} ${label}/${scheme}: paint ${paintMs} ms, load ${loadMs} ms | ${info.title} [${info.tiers}] | ${info.route}, score ${info.score} ` +
      `"${info.takeaway}" | shaky stroke max column jump ${maxJump} m | calendar ${days} days, preview search → ${allRows} | ${longInfo} | ${problems.join("; ")}  → ${shot}`);
    await ctx.close();
  }
}

// ---- Results saved by the one-a-day version move to the matching day and difficulty.
{
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const drawing = Array(120).fill(500);
  await ctx.addInitScript((d) => {
    if (!localStorage.getItem("elevation:v1")) localStorage.setItem("elevation:v1", JSON.stringify({ seenHelp: true, scoring: 2, testMode: true,
      results: { 1: { score: 61, squares: "🟨🟨🟧🟨🟩", drawing: d, daily: true }, 3: { score: 40, squares: "🟧🟧🟧🟥🟧", drawing: d, daily: false }, 4: { score: 70, squares: "🟨🟨🟨🟩🟨", drawing: d, daily: true } } }));
  }, drawing);
  const page = await ctx.newPage();
  await page.goto(base + "/#p3h");
  await page.waitForTimeout(800);
  const s = await store(page);
  const keys = Object.keys(s.days).sort().join(",");
  const shown = await page.evaluate(() => ({ score: document.getElementById("score").textContent, from: document.getElementById("from").textContent }));
  const ok = keys === "1e,3h,4m" && s.days["1e"].daily && !s.days["3h"].daily && shown.score === "40" && shown.from === "Athens";
  failed ||= !ok;
  console.log(`${ok ? "PASS" : "FAIL"} migration: old results 1,3,4 → ${keys}; day 3 Hard shows ${JSON.stringify(shown)}`);
  await ctx.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
