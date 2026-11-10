// Phone-sized smoke test: plays one round in light and dark mode and saves screenshots.
// Fails on page errors or sideways scrolling. Run: npm run check   (SCREENS=dir sets the output folder)
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
  if (path.endsWith("/")) path += "index.html";
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(0);
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
let failed = false;
for (const [label, path] of [["site", "/"]]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ ...devices["iPhone 13"], colorScheme: scheme, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Fonts can't load in some sandboxes; ignore only those network failures.
    page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|ERR_NAME/.test(m.text()) && errors.push(m.text()));
    await page.goto(base + path);
    await page.waitForTimeout(500);
    if (await page.locator("#help[open]").count()) await page.click("#help-close");

    const box = await page.locator("#chart").boundingBox();
    await page.mouse.move(box.x + 52, box.y + 180);
    await page.mouse.down();
    for (let i = 0; i <= 30; i++) await page.mouse.move(box.x + 52 + (box.width - 64) * (i / 30), box.y + 170 - 70 * Math.sin(i / 6));
    await page.mouse.up();
    await page.click("#submit");
    await page.waitForTimeout(1700);

    const info = await page.evaluate(() => ({
      score: document.getElementById("score").textContent,
      squares: document.getElementById("squares").textContent,
      route: `${document.getElementById("from").textContent} → ${document.getElementById("to").textContent}`,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      errorBar: document.getElementById("error-bar").hidden ? "" : document.getElementById("error-bar").textContent,
    }));
    const shot = join(OUT, `${label}-${scheme}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const ok = !errors.length && !info.overflow && !info.errorBar && info.score !== "";
    failed ||= !ok;
    console.log(`${ok ? "PASS" : "FAIL"} ${label}/${scheme}: ${info.route}, score ${info.score} ${info.squares}${info.overflow ? ", SIDEWAYS SCROLL" : ""}${errors.length ? ", errors: " + errors.join(" | ") : ""}  → ${shot}`);
    await ctx.close();
  }
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
