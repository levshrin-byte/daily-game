// Phone-sized smoke test: plays one round on the plain site and on the artifact bundle, in light and dark
// mode, opens the archive and replays a past puzzle, and saves screenshots. Fails on page errors, sideways
// scrolling, a missing score or a malformed share card. Run: npm run build && npm run check
// (SCREENS=dir sets the output folder)
import { createServer } from "node:http";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const OUT = process.env.SCREENS || join(ROOT, ".cache/screens");
mkdirSync(OUT, { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/artifact.html") {
    // Mimic the artifact host: wrap the bundle in a minimal page skeleton.
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

const browser = await chromium.launch();
let failed = false;
for (const [label, path] of [["site", "/"], ["artifact", "/artifact.html"]]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ ...devices["iPhone 13"], colorScheme: scheme, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Fonts can't load in some sandboxes; ignore only those network failures.
    page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|ERR_NAME/.test(m.text()) && errors.push(m.text()));
    await page.goto(base + path);
    await page.waitForTimeout(3500);   // let the onboarding demo finish animating
    if (label === "site") await page.screenshot({ path: join(OUT, `${label}-${scheme}-help.png`) });
    if (await page.locator("#help[open]").count()) await page.click("#help-close");
    // Exercise both unit settings: metric in light mode, feet/miles in dark mode.
    await page.click(`#units button[data-u="${scheme === "dark" ? "imperial" : "metric"}"]`);

    await page.locator("#chart").scrollIntoViewIfNeeded();
    const box = await page.locator("#chart").boundingBox();
    await page.mouse.move(box.x + 52, box.y + 180);
    await page.mouse.down();
    for (let i = 0; i <= 30; i++) await page.mouse.move(box.x + 52 + (box.width - 64) * (i / 30), box.y + 170 - 70 * Math.sin(i / 6));
    await page.mouse.up();
    await page.click("#submit");
    await page.waitForTimeout(1700);

    await page.waitForTimeout(800);   // score count-up
    const info = await page.evaluate(() => ({
      title: `${document.getElementById("puzzle-no").textContent} ${document.getElementById("puzzle-date").textContent} ${document.getElementById("difficulty").textContent}`,
      score: document.getElementById("score").textContent,
      squares: document.getElementById("share-preview").textContent.split("\n")[1] || "",
      share: document.getElementById("share-preview").textContent,
      route: `${document.getElementById("from").textContent} → ${document.getElementById("to").textContent}`,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      errorBar: document.getElementById("error-bar").hidden ? "" : document.getElementById("error-bar").textContent,
    }));
    const shot = join(OUT, `${label}-${scheme}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    // The share card: game name, puzzle number and date, five squares and the score.
    const shareOk = /^Elevation #\d+ · [A-Z][a-z]{2} \d+ ⛰️\n[🟩🟨🟧🟥]{5} \d+\/100/u.test(info.share);

    // Archive: open it, replay the oldest puzzle, check the header follows, and screenshot.
    await page.click("#archive-btn");
    await page.waitForTimeout(300);
    const rows = await page.locator(".arch-row").count();
    if (label === "site") await page.screenshot({ path: join(OUT, `${label}-${scheme}-archive.png`) });
    await page.locator('.arch-row[data-n="1"]').click();
    await page.waitForTimeout(300);
    const replay = await page.evaluate(() => ({ no: document.getElementById("puzzle-no").textContent, today: !document.getElementById("today-btn").hidden, hash: location.hash }));
    const archiveOk = rows >= 1 && replay.no === "#1" && (rows === 1 || (replay.today && replay.hash === "#p1"));
    const after = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > window.innerWidth, errorBar: document.getElementById("error-bar").hidden ? "" : document.getElementById("error-bar").textContent }));
    const ok = !errors.length && !info.overflow && !after.overflow && !info.errorBar && !after.errorBar && info.squares !== "" && shareOk && archiveOk;
    failed ||= !ok;
    console.log(`${ok ? "PASS" : "FAIL"} ${label}/${scheme}: ${info.title} | ${info.route}, score ${info.score} ${info.squares}` +
      `${shareOk ? "" : ", BAD SHARE CARD: " + JSON.stringify(info.share)}${archiveOk ? `, archive ${rows} rows → replay ${replay.no}` : ", ARCHIVE FAILED " + JSON.stringify(replay)}` +
      `${info.overflow || after.overflow ? ", SIDEWAYS SCROLL" : ""}${errors.length ? ", errors: " + errors.join(" | ") : ""}  → ${shot}`);
    await ctx.close();
  }
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
