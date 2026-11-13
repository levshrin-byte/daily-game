// How hard a profile is to sketch, from the baked profile alone: big swings and lots of detail make it harder;
// a plateau far above sea level is harder than one near it. Shared by bake_profiles.mjs and plan_days.mjs.
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

// The chart's height range in metres (must match axisFor in game.js).
export function axisSpan(elev) {
  const max = Math.max(...elev), min = Math.min(...elev);
  const hi = [1000, 2500, 5000, 9000].find((t) => t >= max * 1.05) || 9000;
  return hi - (min < -50 ? -500 : 0);
}

export function difficultyScore(elev) {
  const span = axisSpan(elev), relief = Math.max(...elev) - Math.min(...elev);
  const smooth = elev.map((_, i) => mean(elev.slice(Math.max(0, i - 7), i + 8)));
  const detail = mean(elev.map((e, i) => Math.abs(e - smooth[i]))) / span;
  let turns = 0, dir = 0, ref = elev[0];
  for (const e of elev) {
    if (dir >= 0 && e < ref - 0.1 * span) { if (dir > 0) turns++; dir = -1; ref = e; }
    else if (dir <= 0 && e > ref + 0.1 * span) { if (dir < 0) turns++; dir = 1; ref = e; }
    else if ((dir > 0 && e > ref) || (dir < 0 && e < ref)) ref = e;
  }
  const height = mean(elev) / span;                   // how far up the chart the ground sits
  return turns * 1.2 + detail * 60 + (relief / span) * 3 + height * 2;
}
