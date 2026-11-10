# Elevation: notes for Claude

The owner builds and tests this project **entirely from the Claude mobile app on a phone**.
They can't open devtools, run commands, or open local files, so every change has to reach their phone
as something they can tap.

## After every change (the phone loop)

1. `npm install` (first time in a session: it installs the map-data and test tooling).
2. `npm run build`, which writes `dist/elevation.html`: one self-contained file with all CSS, JS and data inlined.
3. `npm run check`, which plays a round at iPhone size in light and dark mode, on both the plain site and
   the artifact bundle. It fails on page errors or sideways scrolling and saves screenshots to
   `.cache/screens/` (or `$SCREENS`). Look at the screenshots yourself before publishing.
4. Publish `dist/elevation.html` with the Artifact tool **to the existing artifact URL**, so the owner's
   link keeps working: https://claude.ai/artifact/44KfvmAFH2zBUJqpg8VFWn
   (from a new session pass it as `url`, after an `action: "read"` of that URL). Don't pass `icon` on updates.
5. Send the owner one phone screenshot with SendUserFile when the change is visual.
6. Commit and push to the session's branch.

The footer shows `build <timestamp>`, so the owner can confirm their phone has the new version.

## Rules for the code

- **It must run inside a Claude artifact.** That means no network requests: no map tiles, no APIs, no
  CDN stylesheets. Google Fonts are the one exception, and every face needs a fallback. Scripts may only come from
  cdnjs, jsDelivr or unpkg. `alert`, `confirm`, `prompt`, `window.open`, `navigator.share` and query
  strings don't work there. Puzzle links use the hash (`#p12`).
- Phone first: big tap targets (≥ 44px), no hover-only UI, and no sideways scrolling at 390px.
  The drawing canvas uses `touch-action: none`, and the map is a static canvas, so neither traps page scrolling.
- `localStorage` is best effort: every read and write sits in try/catch.
- Uncaught errors appear in a red bar at the top of the page, which is the only way the owner sees them.
  Keep it.
- Colours are CSS tokens in `style.css`, with dark-mode overrides. Don't hard-code colours.

## Project layout

- `index.html`, `style.css`, `game.js`: the game. `index.html` also works as a normal static site.
  The `<!-- build:... -->` markers tell `scripts/build.mjs` which parts go into the artifact.
- `scripts/routes.json`: the route list (endpoints and a fact for each).
- `scripts/bake_profiles.py` → `data/routes.js`: elevation profiles from AWS Terrain Tiles
  (needs the hosts `elevation-tiles-prod.s3.amazonaws.com` and `s3.amazonaws.com`; tiles are cached in `.cache/`).
- `scripts/bake_maps.mjs` → `data/maps.js`: per-route vector maps (Natural Earth, GeoNames), drawn by `game.js`.
- After editing `routes.json`, run both bake scripts, then build.
