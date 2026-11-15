# Elevation ⛰️

A daily game: you get a straight line between two real places, sketch the height of the ground along it, then
see the real profile and your score out of 100.

## Play it

The game is published as a private Claude artifact for testing (see `CLAUDE.md`). It is also ready to host as its
own website (`npm run build:site`, see [DEPLOY.md](DEPLOY.md)), but that hasn't been launched. The repo itself runs as
a plain static site:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

`#p12m` opens day 12's Medium route. Past puzzles are in the calendar (archive) and behind the ‹ › arrows; future ones are locked.

## How it works

- **Daily puzzles:** day #1 is Mon 9 Nov 2026 in the player's local time, and three new routes (Easy, Medium, Hard)
  come out at local midnight. The plan is baked into `data/days.js` (and `scripts/days.json`, append-only) by
  `scripts/plan_days.mjs`; regions are spread out across each day. When the plan runs out it repeats reshuffled.
- **Data:** about two years of routes (three a day) from real elevation data. See [DATA.md](DATA.md) for sources, licences, checks and coverage.
- **Scoring (v2):** each column's miss is measured as a share of the chart height. 40% of it is the plain distance to the
  real ground; 60% is the distance to the real ground's range a few columns either side, so a line through the middle
  of quick ups and downs counts as close. The first 1% is free. The mean miss becomes `score = 100 / (1 + (miss / 0.09)^1.8)`,
  so close sketches land in the 90s and a flat guess still gets a few points. Old results are rescored once from their
  saved drawings. One share-card square per fifth of the route: 🟩 ≥ 85, 🟨 ≥ 65, 🟧 ≥ 40, 🟥 below.
- **Axis:** the y-axis tops out at one of a few coarse tiers (1,000 / 2,500 / 5,000 / 9,000 m), so it gives away
  little about the answer. It drops to −500 m for routes that go below sea level.
- **Map:** each route has a small vector map (coastlines, borders, lakes and towns) baked by `scripts/bake_maps.mjs`,
  and a shaded-relief layer (`scripts/bake_relief.mjs`), both loaded on demand. In the artifact the relief is labelled
  **interim**; the hosted site adds OpenStreetMap tiles.
- **Drawing:** strokes start only after a real drag, keep their direction through small jitter, and are smoothed
  without lag (`drawing.js`; `npm run sim:input` compares old and new input with simulated fingers).
- **Ads:** reserved, off-by-default slots on the hosted site only, with no provider loaded ([ADS.md](ADS.md)).
- **Testing mode:** five taps on the footer build stamp (or `#test`) adds "All routes" to the calendar, to preview any
  route without touching results or share cards.
- **Storage:** results, streaks and settings are kept in `localStorage`.

## Rebuilding the data

```sh
npm install
npm run gen:routes   # pick routes (scripts/routes.json); npm run gen:more adds routes and keeps the old ones
npm run bake         # profiles, checks, schedule, DATA.md, maps, relief
npm run verify:terrain  # re-check profiles against a finer DEM read
npm run build        # dist/elevation.html for the artifact
npm run build:site   # dist/site/ for a future hosted site (not deployed)
npm run sim:input    # drawing input with simulated fingers
npm run check        # phone-size test round with screenshots
```

Terrain tiles are cached in `.cache/` (gitignored).
