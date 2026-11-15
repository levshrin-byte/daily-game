# Elevation: notes for Claude

The owner builds and tests this project **entirely from the Claude mobile app on a phone**. They can't open
devtools, run commands, or open local files, so every change has to reach their phone as something they can tap.

**Where it lives:** the published Claude artifact https://claude.ai/artifact/44KfvmAFH2zBUJqpg8VFWn (private).
Don't deploy anywhere public (no GitHub Pages, no hosting) and don't buy a domain unless the owner asks.

## After every change (the phone loop)

1. `npm install` (first time in a session: it installs the map-data, PNG and test tooling).
2. `npm run build`, which writes `dist/elevation.html` (the page: CSS, game code and the routes for the next month
   inlined) and `dist/files.json` (a map of published path → source file for the supporting files the game fetches
   on demand: `data/routes/*.json` from `dist/`, `data/maps/*.json` and `data/relief/*.jpg`).
3. `npm run check`, which plays at iPhone size in light and dark mode on both the plain site and the artifact
   bundle (with Google Fonts made to hang, and on the bundle with `history.replaceState` made to throw, as in a
   sandboxed frame): first paint and load event (< 1.5 s); taps, wobbles and two-finger touches must draw nothing;
   a shaky real drag draws; Undo/Clear; switching Easy/Medium/Hard keeps drafts; submit, share card, "Next" route;
   tap targets (≥ 44 px); calendar replay of day 1 Easy; a preview via Help → "Preview any route" (must not touch
   results, streak or the share card); and the migration of one-a-day results. Screenshots go to
   `.cache/screens/` (or `$SCREENS`). Look at them yourself before publishing.
4. Publish `dist/elevation.html` with the Artifact tool **to the existing artifact URL** above, so the owner's
   link keeps working (from a new session: `action: "read"` that URL first, then publish with it as `url`).
   Don't pass `icon` on updates. Pass the files listed in `dist/files.json` as `files` (published path = repo path,
   exactly as `dist/files.json` maps them, e.g. `"data/routes/00.json": "dist/data/routes/00.json"`). One publish
   takes at most 255 files, so send the page with the route files and maps, then a second publish to the same
   artifact with the relief sheets. Files you leave out are kept, so after a code-only change publishing just the
   page is enough (but the route files must be republished whenever routes change).
5. Send the owner one phone screenshot with SendUserFile when the change is visual.
6. Commit and push to the session's branch.

The footer shows `build <time>`, so the owner can confirm their phone has the new version.

## Two builds: artifact (testing) and hosted site (not launched)

- `npm run build` → the artifact above. `npm run build:site` → `dist/site/`, a static site with manifest, icons,
  service worker, hashed files and `_headers` (see `DEPLOY.md`). **Never deploy it anywhere** until the owner approves
  a launch; no domain purchase either.
- One code base: `window.ELEVATION_CONFIG` says where it runs (`target: "artifact"` is written by the build;
  `config.js` holds the site settings). Map tiles (OpenStreetMap), ads (reserved slots only, off; `ADS.md`) and the
  service worker exist only on the site. The artifact keeps the "interim" relief label.
- Ads must never come near the map, the chart or its buttons, and must reserve their space up front (no layout shift).

## Rules for the code

- **It must run inside a Claude artifact.** The artifact's CSP blocks every other host: no map or satellite tiles
  (OSM included), no APIs, no CDN stylesheets. Fetching files published *with* the artifact (relative URLs such as
  `data/maps/03.json`) works. Google Fonts are the one outside host allowed, every face needs a fallback, and
  game.js adds the font stylesheet only after the page's `load` event: a slow font host used to hold the load event
  open, which is the likely cause of "Artifact took too long to load".
- Keep the page small and quick to paint: anything not needed for the first screen loads on demand. `alert`, `confirm`,
  `prompt`, `window.open`, `navigator.share` and query strings don't work there. Puzzle links use the hash (`#p12`).
- Phone first: big tap targets (≥ 44px), no hover-only UI, and no sideways scrolling at 390px.
  The drawing canvas uses `touch-action: none`, and the map is a static canvas, so neither traps page scrolling.
- Uncaught errors appear in a red bar at the top of the page, which is the only way the owner sees them. Keep it.
- `localStorage` is best effort: every read and write sits in try/catch.
- Colours are CSS tokens in `style.css`, with dark-mode overrides. Don't hard-code colours.
- **Three routes a day** (Easy, Medium, Hard): `data/days.js` (`window.DAYS`, from `scripts/plan_days.mjs`). Results
  live in `store.days` keyed `<day><e|m|h>` (e.g. `12m`); one streak counts days with at least one route finished
  on the day; the share card covers the whole day. Links: `#p12m`. Old one-a-day results (`store.results`, kept as
  a backup) were moved to the slot where their route now plays (days 1-5 kept their routes).
- **Route previews** (for the owner): the calendar always has an "All routes · testing" tab, also reachable from
  Help → "Preview any route (testing)", five taps on the build stamp, or `#test`. Previews open at `#t<route no.>`,
  live in `store.previews` and never touch results, stats, streaks or share cards.
- **Drawing input** is deliberate and calm (`INPUT` in game.js, helpers in `drawing.js`): a stroke counts only after
  a real drag, one finger at a time; a direction lock stops sideways jitter rewriting columns; centred (zero-lag)
  smoothing of the finger's height and RDP simplification remove shake. `npm run sim:input` tests it with simulated
  fingers. Never smooth the terrain itself.
- **Nothing may move the chart while a finger is down.** The live readout sits in a fixed, absolutely positioned
  slot over the chart's empty top-right corner (never put it back in the flow next to the prompt: its changing
  length rewrapped the prompt and made the chart jump mid-stroke). A layout guard in game.js (`pinChart`, a
  ResizeObserver on everything above the chart) scrolls back any shift from a late font swap or the error bar
  before it is painted. `npm run sim:input` checks the chart box frame by frame in a real browser.
- Never let `history.replaceState` (or any other nice-to-have browser API) abort loading a puzzle: wrap it.
- **Route data must be real.** Every profile comes from the AWS Terrain Tiles DEM; never invent, smooth into
  shape or hand-edit terrain. Routes that fail the checks are dropped, not fixed up. See `DATA.md`.

## Project layout

- `index.html`, `style.css`, `game.js`: the game. `index.html` also works as a plain static site
  (`npm run serve`). The `<!-- build:... -->` markers tell `scripts/build.mjs` what goes into the artifact.
- `scripts/curated.json`: hand-picked routes with hand-written facts (always kept).
- `scripts/generate_routes.mjs` → `scripts/routes.json`: curated routes plus generated ones. It pairs real
  GeoNames cities, screens each line against real terrain and Natural Earth land, and picks a balanced set by
  region and terrain type. Deterministic (seeded). `TARGET=n` sets how many to generate.
- `scripts/bake_profiles.mjs` → `data/routes.js` and `DATA.md`: full-resolution profiles, a second read at
  another zoom to cross-check, sea masking, difficulty, data-driven facts and the **daily schedule** (the
  array order is the puzzle order, kept in `scripts/schedule.json`).
- `scripts/plan_days.mjs` → `data/days.js`, `scripts/days.json` (append-only, like schedule.json): three routes a
  day, tiers by thirds of the difficulty score (`scripts/lib/difficulty.mjs`); rewrites each route's `difficulty`
  to its slot. Part of `npm run bake`.
- `scripts/bake_maps.mjs` → `data/maps/NN.json` (ten routes per file, in ROUTES order) and `data/world.js` (locator):
  per-route vector maps (Natural Earth, GeoNames), drawn by `game.js`.
- `scripts/bake_relief.mjs` → `data/relief/<id>.jpg`: **interim** shaded relief from the same DEM, shown under the map
  and labelled "interim" (satellite imagery can't load in an artifact; see `DATA.md`).
- `drawing.js`: drawing input helpers (stroke start, direction lock, smoothing, RDP, columns). `config.js`: site
  settings. `sw.js`, `manifest.webmanifest`, `icons/` (`npm run icons`), `site/_headers`, `site/robots.txt`: hosted site.
- `scripts/verify_terrain.mjs`, `scripts/verify_spikes.mjs` (`npm run verify:terrain`): check baked profiles against a
  finer DEM read. `scripts/score_sim.mjs`: scoring simulation used to tune `SCORE` in game.js.
- `scripts/lib/terrain.mjs`, `scripts/lib/geo.mjs`: shared DEM and land/region helpers.
- Terrain tiles come from `elevation-tiles-prod.s3.amazonaws.com` and are cached in `.cache/tiles/`.
- After changing routes: `npm run gen:routes && npm run bake && npm run build` (bake now also writes the relief).
  To add routes without touching existing ones: `npm run gen:more` (EXTEND=n) then `npm run bake`.
- Route files: `data/maps/NN.json` holds 20 routes, `data/relief/NNN.jpg` stacks 10 routes' relief (320×240 each),
  `data/routes/NN.json` (built into `dist/`) holds 50 packed routes; game.js `MAP_CHUNK`, `RELIEF_CHUNK` and
  `ROUTE_CHUNK` must match.
- **Never reorder published days.** `scripts/schedule.json` is append-only: rebaking keeps its order and adds new
  routes at the end, and it refuses to drop a route that is already public or due within a week.
