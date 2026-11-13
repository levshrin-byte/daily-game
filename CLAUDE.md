# Elevation: notes for Claude

The owner builds and tests this project **entirely from the Claude mobile app on a phone**. They can't open
devtools, run commands, or open local files, so every change has to reach their phone as something they can tap.

**Where it lives:** the published Claude artifact https://claude.ai/artifact/44KfvmAFH2zBUJqpg8VFWn (private).
Don't deploy anywhere public (no GitHub Pages, no hosting) and don't buy a domain unless the owner asks.

## After every change (the phone loop)

1. `npm install` (first time in a session: it installs the map-data, PNG and test tooling).
2. `npm run build`, which writes `dist/elevation.html` (the page: CSS, game code and the packed route list inlined,
   about 290 KB) and `dist/files.json` (the supporting files: `data/maps/*.json` and `data/relief/*.jpg`, which the
   game fetches on demand).
3. `npm run check`, which plays a round at iPhone size in light and dark mode on both the plain site and the
   artifact bundle with Google Fonts made to hang: checks first paint and the load event (< 1.5 s), draws with a real
   touch drag, checks tap targets (≥ 44 px) and off-screen buttons, opens the details, replays puzzle #1 from the
   archive, and previews route #300 in testing mode (it must not touch results or the share card). Screenshots go to
   `.cache/screens/` (or `$SCREENS`). Look at them yourself before publishing.
4. Publish `dist/elevation.html` with the Artifact tool **to the existing artifact URL** above, so the owner's
   link keeps working (from a new session: `action: "read"` that URL first, then publish with it as `url`).
   Don't pass `icon` on updates. Pass the files listed in `dist/files.json` as `files` (published path = repo path,
   e.g. `"data/maps/00.json": "data/maps/00.json"`). One publish takes at most 255 files, so send the page with the
   maps and the first relief images, then a second publish to the same artifact with the rest. Files you leave out
   are kept, so after a code-only change publishing just the page is enough.
5. Send the owner one phone screenshot with SendUserFile when the change is visual.
6. Commit and push to the session's branch.

The footer shows `build <time>`, so the owner can confirm their phone has the new version.

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
- **Testing mode** (for the owner): five taps on the footer build stamp, or opening `#test`, adds an "All routes"
  tab to the calendar to preview any route, including future days, at `#t<n>`. Previews live in `store.previews`
  and never touch results, stats, streaks or share cards. It is hidden, not secret.
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
- `scripts/bake_maps.mjs` → `data/maps/NN.json` (ten routes per file, in ROUTES order) and `data/world.js` (locator):
  per-route vector maps (Natural Earth, GeoNames), drawn by `game.js`.
- `scripts/bake_relief.mjs` → `data/relief/<id>.jpg`: **interim** shaded relief from the same DEM, shown under the map
  and labelled "interim" (satellite imagery can't load in an artifact; see `DATA.md`).
- `scripts/verify_terrain.mjs`, `scripts/verify_spikes.mjs` (`npm run verify:terrain`): check baked profiles against a
  finer DEM read. `scripts/score_sim.mjs`: scoring simulation used to tune `SCORE` in game.js.
- `scripts/lib/terrain.mjs`, `scripts/lib/geo.mjs`: shared DEM and land/region helpers.
- Terrain tiles come from `elevation-tiles-prod.s3.amazonaws.com` and are cached in `.cache/tiles/`.
- After changing routes: `npm run gen:routes && npm run bake && npm run build` (bake now also writes the relief).
- **Never reorder published days.** `scripts/schedule.json` is append-only: rebaking keeps its order and adds new
  routes at the end, and it refuses to drop a route that is already public or due within a week.
