# Elevation: notes for Claude

The owner builds and tests this project **entirely from their phone**: they chat in the Claude mobile app and
play the live site in their phone's browser. They can't open devtools, run commands, or open local files.

**Live site:** https://levshrin-byte.github.io/daily-game/, served by GitHub Pages straight from the
`claude/eloquent-wozniak-mwx5wg` branch, with no build step. Every push goes live in about a minute.

## After every change

1. `npm install` (first time in a session; it installs the test and map-data tooling).
2. `npm run check`, which plays a round at iPhone size in light and dark mode. It fails on page errors or sideways
   scrolling and saves screenshots to `.cache/screens/` (or `$SCREENS`). Look at them before pushing.
3. Commit and push to the branch above. That is the deploy.
4. Tell the owner the change is live, and send a phone screenshot with SendUserFile when the change is visual.
   GitHub Pages caches pages for up to 10 minutes. If they see the old version, they should reload. The footer's
   "updated …" time shows which version they're on.

## Rules for the code

- Plain static files: `index.html`, `style.css`, `game.js` and `data/*.js`. No bundler and no build step.
- Phone first: big tap targets (≥ 44px), no hover-only UI, and no sideways scrolling at 390px.
  The drawing canvas uses `touch-action: none`, and the map is a static canvas, so neither traps page scrolling.
- Uncaught errors appear in a red bar at the top of the page, which is the only way the owner sees them.
  Keep it.
- `localStorage` is best effort: every read and write sits in try/catch.
- Colours are CSS tokens in `style.css`, with dark-mode overrides. Don't hard-code colours.
- `.nojekyll` must stay, so GitHub Pages serves the files as they are.

## Project layout

- `scripts/routes.json`: the route list (endpoints and a fact for each).
- `scripts/bake_profiles.py` → `data/routes.js`: elevation profiles from AWS Terrain Tiles
  (needs the hosts `elevation-tiles-prod.s3.amazonaws.com` and `s3.amazonaws.com`; tiles are cached in `.cache/`).
- `scripts/bake_maps.mjs` → `data/maps.js`: per-route vector maps (Natural Earth, GeoNames), drawn by `game.js`.
- After editing `routes.json`, run both bake scripts.
