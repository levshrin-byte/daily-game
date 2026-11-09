# Elevation ⛰️

A daily game: you get a straight line between two real places, sketch the height of the ground along it, then see the real profile and your score out of 100.

## Play locally

It's a static site with no build step:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

`?n=12` opens puzzle #12. Past puzzles can be played with the ‹ › arrows; future ones are locked.

## How it works

- **Daily puzzle:** puzzle #1 is 9 Nov 2026 in the player's local time. The routes are shuffled with a fixed seed, and the order is reshuffled each time the list has been used up.
- **Data:** `scripts/routes.json` lists the routes (endpoints and a fun fact). `scripts/bake_profiles.py` samples 120 evenly spaced points along each line and reads their elevations from the [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) "terrarium" PNGs. The result is written to `data/routes.js`, so the game makes no elevation API calls at runtime.
- **Scoring:** mean absolute error between your sketch and the real profile, normalised by the chart's height. `score = 100 × (1 − error / 0.25)`, floored at 0. The share grid has one square per fifth of the route.
- **Axis:** the y-axis tops out at one of a few coarse tiers (1,000 / 2,500 / 5,000 / 9,000 m), so it gives away little about the answer. It drops to −500 m for routes that go below sea level.
- **Storage:** results and stats are kept in `localStorage`.

## Adding routes

```sh
pip install pillow
# edit scripts/routes.json
python3 scripts/bake_profiles.py
```

Tiles are cached in `.cache/` (gitignored).
