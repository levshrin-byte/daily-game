// Drawing input helpers for game.js: pure functions with no DOM access, so scripts/input_sim.mjs can test
// them with simulated fingers. They only ever touch the player's sketch, never the real terrain.
(function (root) {
  "use strict";

  // Centred (zero-lag) smoothing of the finger's height. Each point's height becomes a Gaussian-weighted
  // average of its neighbours: points close to it in time (sigmaT ms) or close to it on screen (sigmaD px).
  // Time catches a fast shake, where each report jumps up and down; distance catches a slow, wavering finger.
  // The window is always centred, so the smoothed line never trails behind the finger: near the tip it
  // shrinks to the points that exist (the newest point is used as it is) and fills in as the finger moves on.
  // A steep stroke keeps its shape, because points far apart on screen are not averaged together.
  function smoothPath(pts, { sigmaT = 22, sigmaD = 4, reach = 40 } = {}) {
    const n = pts.length, out = new Array(n);
    for (let i = 0; i < n; i++) {
      const P = pts[i];
      // Centred: as many steps on each side as the shorter side has, so the average stays put in time.
      const k = Math.min(reach, i, n - 1 - i);
      let sw = 1, sy = P.y;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        const Q = pts[j];
        const u = Math.min(Math.abs(Q.t - P.t) / sigmaT, Math.hypot(Q.x - P.x, Q.y - P.y) / sigmaD);
        if (u > 3) continue;
        const w = Math.exp(-0.5 * u * u);
        sw += w; sy += w * Q.y;
      }
      out[i] = { x: P.x, y: sy / sw, t: P.t };
    }
    return out;
  }

  // Ramer-Douglas-Peucker: drop points that sit within `eps` px of the line through their neighbours.
  // Iterative, so a long stroke can't overflow the stack. Endpoints are always kept.
  function simplifyPath(pts, eps) {
    if (pts.length < 3 || !(eps > 0)) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const A = pts[a], B = pts[b], dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
      let worst = -1, wd = eps;
      for (let i = a + 1; i < b; i++) {
        const P = pts[i];
        const d = len < 1e-9 ? Math.hypot(P.x - A.x, P.y - A.y) : Math.abs(dy * (P.x - A.x) - dx * (P.y - A.y)) / len;
        if (d > wd) { wd = d; worst = i; }
      }
      if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // Write a polyline (screen px) into chart columns: out[c] is the line's height (px) at column c's x,
  // or null where the stroke didn't pass. Later segments win, so going back over a stretch redraws it.
  function rasterize(pts, { cols, colX, colAt }) {
    const out = new Array(cols).fill(null);
    if (!pts.length) return out;
    out[colAt(pts[0].x)] = pts[0].y;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const ca = colAt(a.x), cb = colAt(b.x);
      if (ca === cb || a.x === b.x) { out[cb] = b.y; continue; }
      const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x), dir = Math.sign(cb - ca);
      for (let c = ca; c !== cb + dir; c += dir) {
        const x = Math.min(hi, Math.max(lo, colX(c)));
        out[c] = a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y);
      }
    }
    return out;
  }

  // One finger's stroke, from landing to lift. Feed it pointer samples {x, y, t}; `live` turns true once the
  // finger has clearly dragged (taps and wobbles never get there). `raw` holds the stroke's points from
  // where the finger landed; `points()` gives them smoothed and simplified, ready to draw and score.
  // Settings, in px and ms:
  //  travel/across: distance in all, and sideways, before a stroke counts;
  //  back: how far the finger must come back before the stroke turns round (sideways jitter smaller than
  //  that only moves the height at the tip, so it can't scribble over the last few columns);
  //  sigmaT/sigmaD: smoothing (smoothPath); simplify: RDP tolerance (simplifyPath).
  function createStroke(p, opt) {
    const s = { live: false, raw: null, x0: p.x, y0: p.y, t0: p.t, px: p.x, py: p.y, travel: 0, dir: 0, head: p.x };
    // Returns true when the stroke's points changed.
    s.move = (q) => {
      s.travel += Math.hypot(q.x - s.px, q.y - s.py);
      s.px = q.x; s.py = q.y;
      if (!s.live) {
        if (s.travel < opt.travel || Math.abs(q.x - s.x0) < opt.across) return false;
        // A real drag: start the stroke where the finger landed.
        s.live = true;
        s.dir = Math.sign(q.x - s.x0);
        s.raw = [{ x: s.x0, y: s.y0, t: s.t0 }];
      }
      const ahead = (q.x - s.head) * s.dir;
      if (ahead < 0 && -ahead < opt.back) { s.raw.push({ x: s.head, y: q.y, t: q.t }); return true; }
      if (ahead < 0) s.dir = -s.dir;                 // a clear turn: redraw going the other way
      s.head = q.x;
      s.raw.push({ x: q.x, y: q.y, t: q.t });
      return true;
    };
    s.points = () => simplifyPath(smoothPath(s.raw, opt), opt.simplify);
    return s;
  }

  const api = { smoothPath, simplifyPath, rasterize, createStroke };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DRAWING = api;
})(typeof window !== "undefined" ? window : globalThis);
