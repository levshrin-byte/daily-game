// Draw the app icons and the social preview image from the game's own mountain logo and colours, with the
// pre-installed Chromium. Output: icons/*.png (committed). Run: npm run icons
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
mkdirSync(ROOT + "icons", { recursive: true });

const LOGO = (fill) => `<path d="M1 28 L11 10 L16 18 L21 8 L31 28 Z" fill="${fill}"/>`;
// Same colours as style.css (--bg, --accent, --user, --real); fonts fall back to system ones.
const icon = (size, pad) => `<html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="#1f5f46"/><g transform="translate(${pad} ${pad + 0.5}) scale(${(32 - 2 * pad) / 32})">${LOGO("#f9fbf9")}</g></svg></body></html>`;
const og = `<html><body style="margin:0;width:1200px;height:630px;background:#eaeeeb;font-family:'Barlow Condensed','Arial Narrow',sans-serif;display:flex;flex-direction:column;justify-content:center;padding:0 90px;box-sizing:border-box">
  <div style="display:flex;align-items:center;gap:28px"><svg width="120" height="120" viewBox="0 0 32 32">${LOGO("#1f5f46")}</svg>
  <div style="font-size:150px;font-weight:700;color:#17201b;letter-spacing:-1px">Elevation</div></div>
  <div style="font-family:system-ui,sans-serif;font-size:36px;color:#5c6a63;margin:10px 0 40px">Three real routes a day. Sketch the ground from A to B.</div>
  <svg width="1020" height="190" viewBox="0 0 300 56"><line x1="0" y1="54" x2="300" y2="54" stroke="#d3dbd6"/>
    <path d="M0 50 L30 46 L60 40 L85 28 L110 14 L130 6 L150 18 L175 32 L200 36 L230 30 L260 40 L300 50" fill="none" stroke="#9a5b22" stroke-width="3" stroke-linejoin="round"/>
    <path d="M0 48 L40 42 L80 30 L120 10 L160 22 L200 34 L240 34 L300 48" fill="none" stroke="#2b6cd9" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/></svg>
</body></html>`;

const browser = await chromium.launch();
const shoot = async (html, w, h, file) => {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.screenshot({ path: ROOT + "icons/" + file, clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
};
await shoot(icon(192, 4), 192, 192, "icon-192.png");
await shoot(icon(512, 4), 512, 512, "icon-512.png");
await shoot(icon(512, 8), 512, 512, "maskable-512.png");   // safe zone: the logo inside the middle 80%
await shoot(icon(180, 4), 180, 180, "apple-touch-icon.png");
await shoot(og, 1200, 630, "og-image.png");
await browser.close();
console.log("icons/: icon-192, icon-512, maskable-512, apple-touch-icon, og-image");
