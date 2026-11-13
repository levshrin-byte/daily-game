(() => {
  "use strict";

  // Show uncaught errors on the page itself, so they're visible when testing on a phone.
  const errorBar = document.getElementById("error-bar");
  function showError(msg) {
    errorBar.hidden = false;
    errorBar.textContent = (errorBar.textContent ? errorBar.textContent + "\n" : "") + "Error: " + msg;
  }
  window.addEventListener("error", (e) => showError(`${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => showError(String(e.reason)));

  // ---------- Config ----------
  const LAUNCH = [2026, 10, 9]; // 9 Nov 2026 (month is 0-based) = puzzle #1
  const COLS = 120;            // must match SAMPLES in scripts/lib/terrain.mjs
  const STORE_KEY = "elevation:v1";
  const PAD = { l: 50, r: 12, t: 14, b: 28 };
  const RANKS = [
    [92, "Mountain goat 🐐"], [80, "Trail guide 🧭"], [65, "Day hiker 🥾"],
    [45, "Tourist 📸"], [0, "Lost in the fog 🌫️"],
  ];
  // Scoring v2 (see scoreOf). Saved results from v1 are rescored from their saved drawings once.
  const SCORING = 2;
  const SCORE = { win: 4, mix: 0.4, tol: 0.01, e50: 0.09, p: 1.8 };

  const $ = (id) => document.getElementById(id);
  const ROUTES = window.ROUTES || [];
  // The artifact build packs each profile into a short string (scripts/build.mjs): zigzag deltas in 5-bit digits.
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function unpack(str) {
    const out = []; let acc = 0, shift = 0, prev = 0;
    for (const ch of str) {
      const d = B64.indexOf(ch);
      acc += (d & 31) * 2 ** shift;
      if (d >= 32) { shift += 5; continue; }
      const delta = acc % 2 ? -(acc + 1) / 2 : acc / 2;
      prev += delta; out.push(prev); acc = 0; shift = 0;
    }
    return out;
  }
  for (const r of ROUTES) if (typeof r.elev === "string") r.elev = unpack(r.elev);
  // Route maps load on demand (data/maps/NN.json, ten routes per file), so the page itself stays small.
  const MAPS = (window.MAPS = window.MAPS || {});
  // Anything not needed for the first screen waits for the page's load event, so a slow or unreachable host
  // (Google Fonts, in particular) can never hold the page in a "still loading" state.
  const afterLoad = (fn) => (document.readyState === "complete" ? fn() : window.addEventListener("load", fn, { once: true }));
  const WORLD = window.WORLD || [];
  const MAP_CHUNK = 10;
  const mapLoads = {}, reliefLoads = {};
  function loadMap(r) {
    if (MAPS[r.id]) return Promise.resolve(MAPS[r.id]);
    const c = Math.floor(ROUTES.indexOf(r) / MAP_CHUNK);
    mapLoads[c] = mapLoads[c] || fetch(`data/maps/${String(c).padStart(2, "0")}.json`)
      .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
      .then((j) => Object.assign(MAPS, j))
      .catch((e) => { delete mapLoads[c]; throw e; });
    return mapLoads[c].then(() => MAPS[r.id]);
  }
  // Interim shaded relief (scripts/bake_relief.mjs), one small JPEG per route.
  function loadRelief(r) {
    reliefLoads[r.id] = reliefLoads[r.id] || new Promise((ok, fail) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => { delete reliefLoads[r.id]; fail(new Error("relief")); };
      img.src = `data/relief/${r.id}.jpg`;
    });
    return reliefLoads[r.id];
  }
  // A version stamp, so the owner can tell when a phone shows a stale copy: the artifact build time, or the
  // file's Last-Modified time on the plain site.
  const updated = window.BUILD ? new Date(window.BUILD) : new Date(document.lastModified);
  if (!isNaN(updated)) $("build-tag").textContent = "build " + updated.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  // ---------- Daily selection ----------
  function dayNumber(date) {
    const a = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const b = Date.UTC(LAUNCH[0], LAUNCH[1], LAUNCH[2]);
    return Math.max(1, Math.floor((a - b) / 864e5) + 1);
  }
  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // ROUTES is baked in daily order (scripts/bake_profiles.mjs balances difficulty by weekday and spreads
  // regions out). After the list runs out it repeats, reshuffled once per cycle.
  function routeFor(n) {
    const cycle = Math.floor((n - 1) / ROUTES.length);
    if (cycle === 0) return ROUTES[n - 1];
    const rand = mulberry32(20261109 + cycle * 7919);
    const order = ROUTES.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return ROUTES[order[(n - 1) % ROUTES.length]];
  }

  function puzzleDate(n) { return new Date(LAUNCH[0], LAUNCH[1], LAUNCH[2] + n - 1); }
  const fmtDate = (n, opts = { month: "short", day: "numeric" }) => puzzleDate(n).toLocaleDateString("en-US", opts);
  const DIFF = ["", "Easy", "Medium", "Hard"];

  // ---------- Storage (best effort: may be blocked or empty) ----------
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { results: {} }; }
    catch { return { results: {} }; }
  }
  function save(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {} }
  let store = load();
  store.previews = store.previews || {};

  // ---------- Units ----------
  // Everything is stored in metres and km; only what's shown on screen is converted.
  const UNITS = {
    metric: { h: "m", d: "km", hPer: 1, dPer: 1 },
    imperial: { h: "ft", d: "mi", hPer: 3.28084, dPer: 0.621371 },
  };
  let units = UNITS[store.units] ? store.units
    : /^en-(US|LR|MM)\b/i.test(navigator.language || "") ? "imperial" : "metric";
  const U = () => UNITS[units];
  const fmtH = (m) => `${fmt(m * U().hPer)} ${U().h}`;
  const fmtD = (km) => `${fmt(km * U().dPer)} ${U().d}`;
  // Generated facts carry {h:metres} and {d:km} so they read in the player's units.
  const renderFact = (t) => t.replace(/\{h:(-?[\d.]+)\}/g, (_, v) => fmtH(+v)).replace(/\{d:(-?[\d.]+)\}/g, (_, v) => fmtD(+v));
  const shortH = (v) => (Math.abs(v) >= 1000 ? `${v / 1000}k ${U().h}` : `${v} ${U().h}`);

  // ---------- State ----------
  const today = dayNumber(new Date());
  let puzzleNo, route, axis, drawn, revealed, lastCol, revealProgress = 0, justScored = null;

  // Testing mode (for the owner): previews any of the routes, including future days, without touching
  // results, stats, streaks or share cards. Turned on by tapping the build stamp in the footer five times, or
  // by opening the page with #test. Previews use #t12; normal puzzle links use #p12.
  let testMode = !!store.testMode, preview = false;
  const saved = () => (preview ? store.previews : store.results);
  function puzzleFromHash() {
    if (location.hash === "#test") { setTestMode(true); return { n: today, preview: false }; }
    const t = /^#t(\d+)$/.exec(location.hash);
    if (t && testMode) return { n: Math.min(ROUTES.length, Math.max(1, +t[1])), preview: true };
    const m = /^#p(\d+)$/.exec(location.hash);
    return { n: m ? Math.min(today, Math.max(1, +m[1])) : today, preview: false };
  }
  function setTestMode(on) {
    testMode = on; store.testMode = on; save(store);
    $("test-chip").hidden = !on;
    if (!on && preview) loadPuzzle(today);
  }

  // ---------- Axis ----------
  // Coarse tiers so the axis gives away little about the answer.
  function axisFor(elev) {
    const max = Math.max(...elev), min = Math.min(...elev);
    const hi = [1000, 2500, 5000, 9000].find((t) => t >= max * 1.05) || 9000;
    const lo = min < -50 ? -500 : 0;
    return { lo, hi };
  }
  // Tick spacing in the units on screen, so gridlines land on round numbers of m or ft.
  function tickStep(span) {
    return units === "imperial"
      ? (span <= 4000 ? 1000 : span <= 10000 ? 2000 : span <= 18000 ? 4000 : 5000)
      : (span <= 1500 ? 250 : span <= 3000 ? 500 : span <= 5500 ? 1000 : 1500);
  }

  // ---------- Helpers ----------
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const FONT_BODY = () => css("--font-body");
  const FONT_MONO = () => css("--font-mono");
  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: rect.width, h: rect.height };
  }

  // ---------- Map ----------
  function tracePolys(ctx, polys, s) {
    ctx.beginPath();
    for (const poly of polys) for (const ring of poly) {
      ctx.moveTo(ring[0] * s, ring[1] * s);
      for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i] * s, ring[i + 1] * s);
      ctx.closePath();
    }
  }
  function drawMap() {
    const canvas = $("map");
    const { ctx, w, h } = fitCanvas(canvas);
    const m = MAPS[route.id];
    ctx.fillStyle = css("--water"); ctx.fillRect(0, 0, w, h);
    if (!m) {
      ctx.font = `600 13px ${FONT_BODY()}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      haloText(ctx, mapFailed[route.id] ? "The map didn't load. Reload the page to try again." : "Loading map…", w / 2, h / 2, "center");
      locator(ctx, w);
      return;
    }
    const s = w / m.w;
    const relief = mapMode === "relief" ? reliefImg[route.id] : null;

    tracePolys(ctx, m.land, s);
    ctx.fillStyle = css(mapMode === "relief" ? "--relief-land" : "--land"); ctx.fill("evenodd");
    if (relief) {
      // Hillshade blended over the land colour (mid-grey = no change), clipped to the coastline.
      ctx.save(); ctx.clip("evenodd");
      ctx.globalCompositeOperation = "soft-light";
      ctx.drawImage(relief, 0, 0, w, h); ctx.drawImage(relief, 0, 0, w, h);
      ctx.restore();
    }
    ctx.strokeStyle = css("--border"); ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.stroke();
    tracePolys(ctx, m.water, s);
    ctx.fillStyle = css("--water"); ctx.fill("evenodd");
    ctx.strokeStyle = css("--water-edge"); ctx.lineWidth = 1; ctx.stroke();

    // Labels are placed so they never overlap: endpoint names first, then towns where they fit.
    const [ax, ay] = m.a.map((v) => v * s), [bx, by] = m.b.map((v) => v * s);
    const taken = [
      box(ax - 15, ay - 15, ax + 15, ay + 15), box(bx - 15, by - 15, bx + 15, by + 15),
      box(w - 116, 0, w, 68),          // world locator
      box(0, h - 40, 130, h),          // scale bar
    ];
    const free = (b) => b.x0 >= 2 && b.x1 <= w - 2 && b.y0 >= 2 && b.y1 <= h - 2 &&
      !taken.some((t) => b.x0 < t.x1 && b.x1 > t.x0 && b.y0 < t.y1 && b.y1 > t.y0);
    const clearOfRoute = (b) => {
      for (let t = 0; t <= 1; t += 0.02) {
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        if (x > b.x0 - 3 && x < b.x1 + 3 && y > b.y0 - 3 && y < b.y1 + 3) return false;
      }
      return true;
    };
    // Candidate spots for a label of width tw next to a point: right, left, below, above.
    const spots = (x, y, tw, gap, th) => [
      { x: x + gap, y, align: "left", b: box(x + gap - 2, y - th / 2, x + gap + tw + 2, y + th / 2) },
      { x: x - gap, y, align: "right", b: box(x - gap - tw - 2, y - th / 2, x - gap + 2, y + th / 2) },
      { x, y: y + gap + 4, align: "center", b: box(x - tw / 2 - 2, y + gap + 4 - th / 2, x + tw / 2 + 2, y + gap + 4 + th / 2) },
      { x, y: y - gap - 4, align: "center", b: box(x - tw / 2 - 2, y - gap - 4 - th / 2, x + tw / 2 + 2, y - gap - 4 + th / 2) },
    ];
    const labels = [];
    ctx.font = `700 13px ${FONT_BODY()}`;
    for (const [x, y, ox, oy, text] of [[ax, ay, bx, by, route.from], [bx, by, ax, ay, route.to]]) {
      const c = spots(x, y, ctx.measureText(text).width, 19, 16);
      // Prefer the side facing away from the other end of the line.
      const order = Math.abs(x - ox) >= Math.abs(y - oy) ? (x >= ox ? [0, 2, 3, 1] : [1, 2, 3, 0]) : (y >= oy ? [2, 0, 1, 3] : [3, 0, 1, 2]);
      const pick = order.map((i) => c[i]).find((o) => free(o.b) && clearOfRoute(o.b)) || order.map((i) => c[i]).find((o) => free(o.b)) || c[order[0]];
      taken.push(pick.b); labels.push({ ...pick, text, font: `700 13px ${FONT_BODY()}` });
    }
    ctx.font = `600 12px ${FONT_BODY()}`;
    const dots = [];
    for (const [name, x, y] of m.places) {
      const px = x * s, py = y * s;
      const dot = box(px - 4, py - 4, px + 4, py + 4);
      if (!free(dot)) continue;
      const pick = spots(px, py, ctx.measureText(name).width, 7, 15).slice(0, 2).find((o) => free(o.b) && clearOfRoute(o.b));
      if (!pick) continue;
      taken.push(dot, pick.b); dots.push([px, py]); labels.push({ ...pick, text: name, font: `600 12px ${FONT_BODY()}` });
    }

    for (const [px, py] of dots) {
      ctx.fillStyle = css("--map-ink"); ctx.strokeStyle = css("--halo"); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    // Route line (with a halo so it stands out) and pins
    ctx.lineCap = "round";
    ctx.strokeStyle = css("--halo"); ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.strokeStyle = css("--route"); ctx.lineWidth = 3.5; ctx.setLineDash([9, 7]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
    pin(ctx, ax, ay, "A", css("--pin-a"));
    pin(ctx, bx, by, "B", css("--pin-b"));

    ctx.textBaseline = "middle";
    for (const l of labels) { ctx.font = l.font; haloText(ctx, l.text, l.x, l.y, l.align); }

    scaleBar(ctx, m, s, h);
    locator(ctx, w);
    if (mapMode === "relief") {
      ctx.font = `600 11px ${FONT_BODY()}`; ctx.textBaseline = "bottom";
      haloText(ctx, relief ? "Shaded relief · interim" : reliefFailed[route.id] ? "Relief didn't load" : "Loading relief…", w - 8, h - 6, "right");
    }
  }
  // Which map layer to show: the plain vector map, or the interim shaded relief on top of it.
  let mapMode = store.mapMode === "plain" ? "plain" : "relief";
  const reliefImg = {}, reliefFailed = {}, mapFailed = {};
  function fetchMapData(r) {
    if (!MAPS[r.id]) loadMap(r).then(() => { if (route === r) drawMap(); }, () => { mapFailed[r.id] = true; if (route === r) drawMap(); });
    if (mapMode === "relief" && !reliefImg[r.id]) afterLoad(() => {
      loadRelief(r).then((img) => { reliefImg[r.id] = img; if (route === r) drawMap(); }, () => { reliefFailed[r.id] = true; if (route === r) drawMap(); });
    });
  }
  function setMapMode(mode) {
    mapMode = mode; store.mapMode = mode; save(store);
    document.querySelectorAll("#map-mode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    $("map-note").hidden = mode !== "relief";
    if (route) { fetchMapData(route); drawMap(); }
  }
  function box(x0, y0, x1, y1) { return { x0, y0, x1, y1 }; }
  function haloText(ctx, text, x, y, align) {
    ctx.textAlign = align; ctx.lineJoin = "round";
    ctx.strokeStyle = css("--halo"); ctx.lineWidth = 3.5; ctx.strokeText(text, x, y);
    ctx.fillStyle = css("--map-ink"); ctx.fillText(text, x, y);
  }
  function pin(ctx, x, y, label, color) {
    ctx.fillStyle = color; ctx.strokeStyle = css("--halo"); ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = css("--pin-ink"); ctx.font = `700 13px ${FONT_BODY()}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + 0.5);
  }
  function scaleBar(ctx, m, s, h) {
    const perPx = (m.kmPerUnit / s) * U().dPer;   // km or miles per pixel
    const target = 100 * perPx;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].reduce((best, v) => (v <= target ? v : best), 1);
    const px = nice / perPx, x = 12, y = h - 14;
    ctx.lineCap = "butt";
    ctx.strokeStyle = css("--halo"); ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5); ctx.stroke();
    ctx.strokeStyle = css("--map-ink"); ctx.lineWidth = 2.5; ctx.stroke();
    ctx.font = `700 12px ${FONT_MONO()}`; ctx.textBaseline = "bottom";
    haloText(ctx, `${nice} ${U().d}`, x + 4, y - 6, "left");
  }
  function locator(ctx, w) {
    const iw = 104, ih = 52, x0 = w - iw - 8, y0 = 8, s = iw / 360;
    ctx.fillStyle = css("--surface"); ctx.strokeStyle = css("--line"); ctx.lineWidth = 1;
    ctx.fillRect(x0, y0, iw, ih); ctx.strokeRect(x0 + 0.5, y0 + 0.5, iw - 1, ih - 1);
    ctx.save(); ctx.translate(x0, y0);
    ctx.beginPath();
    for (const ring of WORLD) {
      ctx.moveTo(ring[0] * s, ring[1] * s * (ih / iw) * 2);
      for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i] * s, ring[i + 1] * s * (ih / iw) * 2);
      ctx.closePath();
    }
    ctx.fillStyle = css("--border"); ctx.fill();
    const lon = (route.a[1] + route.b[1]) / 2, lat = (route.a[0] + route.b[0]) / 2;
    ctx.fillStyle = css("--pin-b"); ctx.strokeStyle = css("--surface"); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc((lon + 180) * s, (90 - lat) * s * (ih / iw) * 2, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // ---------- Chart geometry ----------
  const chart = $("chart");
  let cctx, W = 0, H = 0;
  function resize() {
    ({ ctx: cctx, w: W, h: H } = fitCanvas(chart));
    render();
    if (route) drawMap();
  }
  const plotW = () => W - PAD.l - PAD.r;
  const plotH = () => H - PAD.t - PAD.b;
  const xOf = (col) => PAD.l + (col / (COLS - 1)) * plotW();
  const yOf = (m) => PAD.t + (1 - (m - axis.lo) / (axis.hi - axis.lo)) * plotH();
  const colAt = (x) => Math.round(((x - PAD.l) / plotW()) * (COLS - 1));
  const elevAt = (y) => axis.lo + (1 - (y - PAD.t) / plotH()) * (axis.hi - axis.lo);

  // ---------- Chart rendering ----------
  function render() {
    if (!route || !W) return;
    const ctx = cctx;
    const c = { grid: css("--grid"), muted: css("--muted"), user: css("--user"), real: css("--real"),
      diff: css("--diff"), sea: css("--sea-line"), pinA: css("--pin-a"), pinB: css("--pin-b") };
    ctx.clearRect(0, 0, W, H);

    // Grid and y labels
    ctx.font = `500 11px ${FONT_MONO()}`; ctx.textBaseline = "middle";
    const k = U().hPer, step = tickStep((axis.hi - axis.lo) * k);
    for (let v = Math.ceil((axis.lo * k) / step) * step; v <= axis.hi * k; v += step) {
      const y = yOf(v / k);
      ctx.strokeStyle = v === 0 ? c.sea : c.grid; ctx.lineWidth = 1;
      ctx.setLineDash(v === 0 && axis.lo < 0 ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = c.muted; ctx.textAlign = "right";
      ctx.fillText(v === 0 && axis.lo < 0 ? "sea" : shortH(v), PAD.l - 6, y);
    }
    // x labels
    ctx.textBaseline = "top";
    for (let i = 0; i <= 4; i++) {
      const x = xOf((i / 4) * (COLS - 1));
      const end = i === 0 || i === 4;
      ctx.fillStyle = i === 0 ? c.pinA : i === 4 ? c.pinB : c.muted;
      ctx.font = `${end ? 700 : 500} 11px ${end ? FONT_BODY() : FONT_MONO()}`;
      ctx.textAlign = i === 0 ? "left" : i === 4 ? "right" : "center";
      ctx.fillText(i === 0 ? "A" : i === 4 ? "B" : fmtD((route.distanceKm * i) / 4), x, H - PAD.b + 9);
    }

    const real = route.elev;
    const upto = Math.floor(revealProgress * (COLS - 1));
    const user = revealed ? filled() : null;

    // Open sea under the line, once the answer is showing.
    if (revealProgress > 0 && route.sea) {
      ctx.fillStyle = css("--water");
      for (const [s0, s1] of route.sea) {
        if (s0 > upto) continue;
        const x0 = xOf(Math.max(0, s0 - 0.5)), x1 = xOf(Math.min(COLS - 1, Math.min(s1, upto) + 0.5));
        ctx.fillRect(x0, yOf(0), x1 - x0, Math.max(4, yOf(axis.lo) - yOf(0)));
      }
    }
    if (revealProgress > 0) {
      ctx.fillStyle = c.diff;
      ctx.beginPath();
      for (let i = 0; i <= upto; i++) ctx.lineTo(xOf(i), yOf(user[i]));
      for (let i = upto; i >= 0; i--) ctx.lineTo(xOf(i), yOf(real[i]));
      ctx.closePath(); ctx.fill();
    }

    // Your line (gaps stay open until you submit)
    ctx.strokeStyle = c.user; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.lineCap = "round";
    const series = user || drawn;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < COLS; i++) {
      const v = series[i];
      if (v == null) { pen = false; continue; }
      if (!pen) { ctx.moveTo(xOf(i), yOf(v)); pen = true; } else ctx.lineTo(xOf(i), yOf(v));
    }
    ctx.stroke();

    // The real ground
    if (revealProgress > 0) {
      ctx.strokeStyle = c.real; ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i <= upto; i++) ctx.lineTo(xOf(i), yOf(real[i]));
      ctx.stroke();
    }

    if (revealProgress >= 1) {
      const hi = Math.max(...real), lo = Math.min(...real);
      markPoint(real.indexOf(hi), "▲", c.real, -1);
      if (lo < 0) markPoint(real.indexOf(lo), "▼", c.sea, 1);
      ctx.font = `600 11px ${FONT_BODY()}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      legend(PAD.l + 8, PAD.t + 8, c.real, "Real");
      legend(PAD.l + 62, PAD.t + 8, c.user, "Yours");
    }
  }
  function legend(x, y, color, text) {
    cctx.fillStyle = color; cctx.fillRect(x, y - 1.5, 14, 3);
    cctx.fillStyle = css("--ink"); cctx.fillText(text, x + 19, y);
  }
  function markPoint(i, sym, color, dir) {
    const x = xOf(i), y = yOf(route.elev[i]);
    cctx.fillStyle = color; cctx.font = `700 12px ${FONT_MONO()}`;
    cctx.textBaseline = dir < 0 ? "bottom" : "top";
    cctx.textAlign = x > W - 80 ? "right" : x < PAD.l + 50 ? "left" : "center";
    cctx.fillText(`${sym} ${fmtH(route.elev[i])}`, x, clamp(y + dir * 6, PAD.t + 14, H - PAD.b - 2));
  }

  // ---------- Drawing input ----------
  function pointerPos(e) {
    const r = chart.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function paint(e) {
    const p = pointerPos(e);
    const col = clamp(colAt(p.x), 0, COLS - 1);
    const m = clamp(elevAt(p.y), axis.lo, axis.hi);
    if (lastCol && lastCol.col !== col) {
      const a = lastCol, dir = Math.sign(col - a.col);
      for (let i = a.col + dir; i !== col; i += dir) drawn[i] = a.m + ((m - a.m) * (i - a.col)) / (col - a.col);
    }
    drawn[col] = m;
    lastCol = { col, m };
    $("hint").style.opacity = 0;
    showCoverage();
    // Your finger hides the line, so show where it is.
    $("readout").textContent = `${fmtH(m)} · ${fmtD((route.distanceKm * col) / (COLS - 1))}`;
    render();
  }
  chart.addEventListener("pointerdown", (e) => {
    if (revealed) return;
    e.preventDefault();
    chart.setPointerCapture(e.pointerId);
    lastCol = null;
    paint(e);
  });
  chart.addEventListener("pointermove", (e) => { if (!revealed && chart.hasPointerCapture(e.pointerId)) paint(e); });
  const endStroke = () => { lastCol = null; $("readout").textContent = ""; };
  chart.addEventListener("pointerup", endStroke);
  chart.addEventListener("pointercancel", endStroke);

  // How much of the route is drawn; Submit needs 60%.
  function showCoverage() {
    const cov = revealed ? 1 : drawn.filter((v) => v != null).length / COLS;
    const bar = $("coverage-bar");
    bar.style.width = `${Math.round(cov * 100)}%`;
    bar.classList.toggle("ready", cov >= 0.6);
    $("submit").classList.toggle("ready", !revealed && cov >= 0.6);
  }

  // Fill gaps by linear interpolation; extend the ends flat.
  function filled() {
    const out = drawn.slice();
    const known = [];
    out.forEach((v, i) => { if (v != null) known.push(i); });
    if (!known.length) return out.fill(0);
    for (let i = 0; i < COLS; i++) {
      if (out[i] != null) continue;
      const next = known.find((k) => k > i);
      let prev; for (const k of known) if (k < i) prev = k;
      if (prev == null) out[i] = out[next];
      else if (next == null) out[i] = out[prev];
      else out[i] = out[prev] + ((out[next] - out[prev]) * (i - prev)) / (next - prev);
    }
    return out;
  }

  // ---------- Scoring ----------
  // Scoring v2. For each of the 120 columns we measure how far your line is from the real ground, as a share
  // of the chart height, in a way that forgives what nobody can draw:
  //  - Rugged ground: 60% of the error is measured against the real ground's range a few columns either side
  //    (about ±3% of the route), so a line through the middle of quick ups and downs isn't punished for
  //    missing every ridge and gully. The other 40% is the plain distance, so detail still pays.
  //  - Small misses: the first 1% of the chart height in each column is free.
  // The mean of that is turned into a score on a gentle S-curve: 100 / (1 + (error / 0.09)^1.8). Close
  // sketches land in the 90s, a rough but sensible shape in the 70s, and a flat guess still gets a few points
  // instead of zero. Real terrain is never smoothed; only the scoring adapts to it.
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const curve = (e) => 100 / (1 + Math.pow(e / SCORE.e50, SCORE.p));
  function columnErrors(user, r, ax) {
    const real = r.elev, span = ax.hi - ax.lo, w = SCORE.win;
    return user.map((v, i) => {
      let lo = Infinity, hi = -Infinity;
      for (let j = Math.max(0, i - w); j <= Math.min(COLS - 1, i + w); j++) { lo = Math.min(lo, real[j]); hi = Math.max(hi, real[j]); }
      const outside = v < lo ? lo - v : v > hi ? v - hi : 0;
      return Math.max(0, (SCORE.mix * Math.abs(v - real[i]) + (1 - SCORE.mix) * outside) / span - SCORE.tol);
    });
  }
  const fifth = (a, k) => a.slice(Math.floor((k * COLS) / 5), Math.floor(((k + 1) * COLS) / 5));
  function scoreOf(user, r = route, ax = axis) {
    const err = columnErrors(user, r, ax);
    const score = Math.round(curve(mean(err)));
    const fifthScores = [0, 1, 2, 3, 4].map((k) => curve(mean(fifth(err, k))));
    const squares = fifthScores.map((v) => (v >= 85 ? "🟩" : v >= 65 ? "🟨" : v >= 40 ? "🟧" : "🟥")).join("");
    // Plain average miss per fifth in metres, for the details panel.
    const miss = [0, 1, 2, 3, 4].map((k) => mean(fifth(user.map((v, i) => Math.abs(v - r.elev[i])), k)));
    return { score, squares, miss };
  }
  // Rescore results saved under scoring v1 from their saved drawings, so averages stay comparable.
  if (store.scoring !== SCORING) {
    for (const [n, res] of Object.entries(store.results)) {
      const r = routeFor(+n);
      if (!r || !res.drawing || res.drawing.length !== COLS) continue;
      const s2 = scoreOf(res.drawing, r, axisFor(r.elev));
      res.v1 = res.v1 || res.score; res.score = s2.score; res.squares = s2.squares;
    }
    store.scoring = SCORING; save(store);
  }

  const NAMES = ["the start", "the second fifth", "the middle", "the fourth fifth", "the finish"];
  function signedFifths(user) {
    return [0, 1, 2, 3, 4].map((k) => mean(fifth(user.map((v, i) => v - route.elev[i]), k)));
  }
  // The one line under the score.
  function takeaway(user, score) {
    const span = axis.hi - axis.lo, signed = signedFifths(user), abs = signed.map(Math.abs);
    const worst = abs.indexOf(Math.max(...abs));
    if (score >= 92 || abs[worst] < 0.05 * span) return "Close all the way along. Nicely read.";
    return `Biggest miss: ${NAMES[worst]}, ${fmtH(abs[worst])} too ${signed[worst] > 0 ? "high" : "low"} on average.`;
  }
  // More notes, for the details panel.
  function insights(user) {
    const real = route.elev, span = axis.hi - axis.lo, out = [];
    const realMax = Math.max(...real), iR = real.indexOf(realMax);
    const userMax = Math.max(...user), iU = user.indexOf(userMax);
    const dPeak = userMax - realMax;
    if (Math.abs(dPeak) < 0.06 * span) out.push(["good", `High point within ${fmtH(Math.abs(dPeak))} of the real ${fmtH(realMax)}.`]);
    else out.push(["off", `Your high point was ${fmtH(Math.abs(dPeak))} too ${dPeak > 0 ? "high" : "low"} (real: ${fmtH(realMax)}).`]);
    if (Math.abs(iU - iR) > COLS * 0.2 && realMax - Math.min(...real) > 0.15 * span) {
      out.push(["off", `The real top is ${fmtD((Math.abs(iU - iR) / (COLS - 1)) * route.distanceKm)} ${iR > iU ? "later" : "sooner"} than yours.`]);
    }
    const abs = signedFifths(user).map(Math.abs), best = abs.indexOf(Math.min(...abs));
    out.push(["good", `Closest stretch: ${NAMES[best]}.`]);
    return out;
  }

  // ---------- Submit / reveal ----------
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
  }
  function submit() {
    if (revealed) return;
    const coverage = drawn.filter((v) => v != null).length / COLS;
    if (coverage < 0.6) { toast("Draw across more of the route first"); return; }
    const user = filled();
    const { score, squares } = scoreOf(user);
    const before = stats();
    justScored = { prevBest: before.played ? before.best : null };
    if (preview) justScored = { prevBest: null };
    saved()[puzzleNo] = { score, squares, drawing: user.map(Math.round), daily: !preview && puzzleNo === today, at: Date.now() };
    save(store);
    drawn = user;
    reveal(true);
  }
  function reveal(animate) {
    revealed = true;
    $("submit").disabled = true; $("clear").disabled = true;
    $("hint").style.opacity = 0;
    showCoverage();
    $("prompt").textContent = "Here's the real ground.";
    chart.style.cursor = "default";
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      revealProgress = 1; render(); showResult(); return;
    }
    const t0 = performance.now(), dur = 1400, n = puzzleNo;
    const tick = (t) => {
      if (n !== puzzleNo) return; // switched puzzles mid-animation
      const p = Math.min(1, (t - t0) / dur);
      revealProgress = 1 - Math.pow(1 - p, 2);
      render();
      if (p < 1) requestAnimationFrame(tick); else showResult();
    };
    requestAnimationFrame(tick);
  }

  // ---------- Results ----------
  // The streak counts daily puzzles finished on their own day, in a row. It survives until the end of
  // today, so a streak from yesterday still shows before you've played today.
  function stats() {
    const all = Object.entries(store.results);
    const scores = all.map(([, r]) => r.score);
    const dailies = new Set(all.filter(([, r]) => r.daily).map(([n]) => +n));
    let streak = 0;
    for (let n = dailies.has(today) ? today : today - 1; dailies.has(n); n--) streak++;
    let maxStreak = 0, run = 0, prev = null;
    for (const n of [...dailies].sort((x, y) => x - y)) { run = prev === n - 1 ? run + 1 : 1; maxStreak = Math.max(maxStreak, run); prev = n; }
    return {
      played: scores.length,
      avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      best: scores.length ? Math.max(...scores) : 0,
      streak, maxStreak,
    };
  }
  function showStreakChip() {
    const { streak } = stats(), chip = $("streak-chip");
    chip.hidden = streak < 1;
    chip.textContent = `🔥 ${streak}`;
    chip.setAttribute("aria-label", `${streak}-day streak`);
  }
  function showResult() {
    const r = saved()[puzzleNo];
    if (!r) return;
    $("share-box").hidden = preview; $("preview-note").hidden = !preview;
    const fresh = justScored; justScored = null;
    $("result").hidden = false;
    $("share-text").hidden = true;
    $("rank").textContent = RANKS.find(([min]) => r.score >= min)[1];
    // Count the score up on a fresh result; show it straight away when revisiting.
    const el = $("score");
    if (fresh && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const t0 = performance.now();
      const tick = (t) => { const p = Math.min(1, (t - t0) / 700); el.textContent = Math.round(r.score * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    } else el.textContent = r.score;

    const badge = $("badge");
    const badgeText = !fresh ? "" : r.score >= 95 ? "Near perfect!" : fresh.prevBest != null && r.score > fresh.prevBest ? "New personal best" : "";
    badge.hidden = !badgeText; badge.textContent = badgeText;

    const user = r.drawing, { miss } = scoreOf(user);
    const LABEL = ["Start", "", "Middle", "", "Finish"];
    $("takeaway").textContent = takeaway(user, r.score);
    $("breakdown").innerHTML = [...r.squares].filter((ch) => ch.trim()).map((sq, k) =>
      `<div class="seg"><span class="seg-sq">${sq}</span><span class="seg-l">${LABEL[k]}</span></div>`).join("");
    $("miss").innerHTML = miss.map((v, k) => `<div><b class="mono">${fmt(v * U().hPer)}</b><span>${LABEL[k] || "·"}</span></div>`).join("");
    $("miss-unit").textContent = U().h;
    $("insights").innerHTML = insights(user).map(([k, t]) => `<li class="${k}">${t}</li>`).join("");
    $("fact").textContent = renderFact(route.fact);
    $("share-preview").textContent = shareText();
    const s = stats();
    $("st-played").textContent = s.played; $("st-avg").textContent = s.avg;
    $("st-streak").textContent = s.streak; $("st-max").textContent = s.maxStreak;
    showStreakChip();
    if (fresh) setTimeout(() => $("result").scrollIntoView({ behavior: "smooth", block: "start" }), 250);
  }
  function shareText() {
    const r = store.results[puzzleNo];
    if (preview || !r) return "";
    const replay = !r.daily;
    const { streak } = stats();
    const lines = [
      `Elevation #${puzzleNo} · ${fmtDate(puzzleNo)} ⛰️${replay ? " (replay)" : ""}`,
      `${r.squares} ${r.score}/100`,
      `${DIFF[route.difficulty] || ""}${route.difficulty ? " · " : ""}${fmtD(route.distanceKm)}`,
    ];
    if (!replay && streak >= 2) lines.push(`🔥 ${streak}-day streak`);
    return lines.join("\n");
  }
  $("share").addEventListener("click", () => {
    const text = shareText();
    const fallback = () => {
      const box = $("share-text");
      box.value = text; box.hidden = false; box.focus(); box.select();
      toast("Select the text and copy it");
    };
    try {
      if (!navigator.clipboard) return fallback();
      navigator.clipboard.writeText(text).then(() => { toast("Copied! Paste it anywhere"); $("share").textContent = "Copied ✓"; setTimeout(() => ($("share").textContent = "Copy result"), 2000); }, fallback);
    } catch { fallback(); }
  });

  // ---------- Archive ----------
  let archiveTab = "past";
  function openArchive() {
    $("archive-tabs").hidden = !testMode;
    if (!testMode) archiveTab = "past";
    document.querySelectorAll("#archive-tabs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === archiveTab)));
    $("route-search").hidden = archiveTab !== "all";
    $("test-off").hidden = archiveTab !== "all";
    const list = $("archive-list"), s = stats();
    const rows = [];
    if (archiveTab === "all") {
      $("archive-title").textContent = "All routes";
      $("archive-summary").textContent = `Testing: preview any of the ${ROUTES.length} routes. Previews don't count towards your stats, streak or share card.`;
      for (let n = 1; n <= ROUTES.length; n++) {
        const r = routeFor(n), res = store.previews[n];
        const when = n === today ? " · Today" : n > today ? " · upcoming" : "";
        rows.push(`<li><button class="arch-row${preview && n === puzzleNo ? " current" : ""}" data-t="${n}" data-q="${esc((r.from + " " + r.to + " " + r.country + " " + r.region + " " + r.id).toLowerCase())}">
        <span class="arch-no mono">#${n}</span>
        <span class="arch-main"><span class="arch-date">${fmtDate(n, { weekday: "short", month: "short", day: "numeric" })}${when} · ${esc(r.region)}</span>
          <span class="arch-route">${esc(r.from)} → ${esc(r.to)}</span></span>
        <span class="arch-res">${res ? `<b class="mono">${res.score}</b><span class="arch-sq">${res.squares}</span>` : `<span class="arch-play">Preview</span><span class="arch-diff">${DIFF[r.difficulty] || ""} · ${r.kind}</span>`}</span>
      </button></li>`);
      }
    } else {
      $("archive-title").textContent = "Past puzzles";
      const done = Object.keys(store.results).filter((n) => +n <= today).length;
      $("archive-summary").textContent = `${done} of ${today} played${s.played ? ` · average ${s.avg}` : ""}`;
      for (let n = today; n >= 1; n--) {
        const r = routeFor(n), res = store.results[n];
        rows.push(`<li><button class="arch-row${!preview && n === puzzleNo ? " current" : ""}" data-n="${n}">
        <span class="arch-no mono">#${n}</span>
        <span class="arch-main"><span class="arch-date">${fmtDate(n, { weekday: "short", month: "short", day: "numeric" })}${n === today ? " · Today" : ""}</span>
          <span class="arch-route">${esc(r.from)} → ${esc(r.to)}</span></span>
        <span class="arch-res">${res ? `<b class="mono">${res.score}</b><span class="arch-sq">${res.squares}</span>` : `<span class="arch-play">Play</span><span class="arch-diff">${DIFF[r.difficulty] || ""}</span>`}</span>
      </button></li>`);
      }
    }
    list.innerHTML = rows.join("");
    filterRoutes();
    if (!$("archive").open) $("archive").showModal();
    const cur = list.querySelector(".current");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }
  function filterRoutes() {
    const q = archiveTab === "all" ? $("route-search").value.trim().toLowerCase() : "";
    for (const b of $("archive-list").querySelectorAll("[data-q]")) b.parentElement.hidden = !!q && !b.dataset.q.includes(q) && b.dataset.t !== q.replace(/^#/, "");
  }
  $("route-search").addEventListener("input", filterRoutes);
  document.querySelectorAll("#archive-tabs button").forEach((b) => b.addEventListener("click", () => { archiveTab = b.dataset.tab; openArchive(); }));
  $("test-off").addEventListener("click", () => { $("archive").close(); setTestMode(false); toast("Testing mode is off"); });
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  $("archive-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-n],[data-t]");
    if (!b) return;
    $("archive").close();
    if (b.dataset.t) loadPuzzle(+b.dataset.t, null, true); else loadPuzzle(+b.dataset.n);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  // Five taps on the build stamp toggle testing mode.
  let stampTaps = [];
  $("build-tag").addEventListener("click", () => {
    const now = Date.now();
    stampTaps = stampTaps.filter((t) => now - t < 3000).concat(now);
    if (stampTaps.length >= 5) {
      stampTaps = []; setTestMode(!testMode);
      toast(testMode ? "Testing mode on: Past puzzles → All routes" : "Testing mode is off");
    }
  });
  $("redo").addEventListener("click", () => { delete store.previews[puzzleNo]; save(store); loadPuzzle(puzzleNo, null, true); });
  $("archive-btn").addEventListener("click", openArchive);
  $("archive-btn-2").addEventListener("click", openArchive);
  $("archive-close").addEventListener("click", () => $("archive").close());
  // Tapping the dark area around a dialog closes it.
  for (const d of [$("archive"), $("help")]) d.addEventListener("click", (e) => { if (e.target === d) d.close(); });

  function countdown() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const s = Math.max(0, Math.floor((next - now) / 1000));
    const pad = (v) => String(v).padStart(2, "0");
    $("countdown").textContent = `Next route in ${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
    if (dayNumber(new Date()) !== today) $("countdown").textContent = "A new route is out. Reload to play it.";
  }

  // ---------- Puzzle setup ----------
  function loadPuzzle(n, draft, asPreview = false) {
    puzzleNo = n; preview = asPreview;
    route = routeFor(n);
    axis = axisFor(route.elev);
    drawn = draft && draft.length === COLS ? draft.slice() : new Array(COLS).fill(null);
    revealed = false; revealProgress = 0; lastCol = null;

    $("puzzle-no").textContent = preview ? `Preview #${n}` : `#${n}`;
    document.body.classList.toggle("previewing", preview);
    $("today-btn").textContent = preview ? "Exit preview" : "Back to today";
    $("puzzle-date").textContent = fmtDate(n, { weekday: "short", month: "short", day: "numeric" });
    const d = route.difficulty || 0;
    $("difficulty").innerHTML = d ? `<span class="pips d${d}" aria-hidden="true"><i></i><i></i><i></i></span>${DIFF[d]}` : "";
    $("today-btn").hidden = !preview && n === today;
    $("prev").disabled = n <= 1;
    $("next").disabled = n >= (preview ? ROUTES.length : today);
    $("from").textContent = route.from; $("to").textContent = route.to;
    $("country").textContent = route.country ? `${route.country} · ` : "";
    showDistance();
    $("prompt").textContent = "Sketch how high the ground is along the line, from A to B.";
    $("submit").disabled = false; $("clear").disabled = false;
    $("hint").style.opacity = drawn.some((v) => v != null) ? 0 : 1;
    $("result").hidden = true;
    chart.style.cursor = "crosshair";

    const hash = preview ? `#t${n}` : n === today ? "" : `#p${n}`;
    if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname + location.search);

    fetchMapData(route);
    resize();
    showCoverage();
    const prior = saved()[n];
    if (prior) { drawn = prior.drawing.slice(); reveal(false); }
  }

  $("clear").addEventListener("click", () => { drawn.fill(null); $("hint").style.opacity = 1; showCoverage(); render(); });
  $("today-btn").addEventListener("click", () => loadPuzzle(today));
  $("submit").addEventListener("click", submit);
  $("prev").addEventListener("click", () => puzzleNo > 1 && loadPuzzle(puzzleNo - 1, null, preview));
  $("next").addEventListener("click", () => puzzleNo < (preview ? ROUTES.length : today) && loadPuzzle(puzzleNo + 1, null, preview));
  $("help-btn").addEventListener("click", () => $("help").showModal());
  $("help-close").addEventListener("click", () => $("help").close());
  // Two-tap reset (confirm() dialogs don't work inside artifacts).
  $("reset").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.armed) {
      store = { results: {}, seenHelp: true }; save(store);
      btn.textContent = "Progress cleared"; delete btn.dataset.armed;
      loadPuzzle(puzzleNo);
      return;
    }
    btn.dataset.armed = "1"; btn.textContent = "Tap again to erase everything";
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = "Reset my progress"; }, 4000);
  });
  function showDistance() { $("distance").textContent = fmtD(route.distanceKm); }
  function setUnits(u) {
    units = u; store.units = u; save(store);
    document.querySelectorAll("#units button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.u === u)));
    if (route) { showDistance(); resize(); }
  }
  document.querySelectorAll("#units button").forEach((b) => b.addEventListener("click", () => setUnits(b.dataset.u)));
  setUnits(units);
  window.addEventListener("hashchange", () => { const h = puzzleFromHash(); if (h.n !== puzzleNo || h.preview !== preview) loadPuzzle(h.n, null, h.preview); });
  document.querySelectorAll("#map-mode button").forEach((b) => b.addEventListener("click", () => setMapMode(b.dataset.mode)));
  window.addEventListener("resize", resize);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", resize);
  new MutationObserver(resize).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  if (document.fonts) document.fonts.ready.then(resize);

  function loadFonts() {
    if (document.querySelector("link[data-fonts]")) return;
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.dataset.fonts = "1";
    l.href = "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap";
    (document.head || document.documentElement).appendChild(l);
  }
  function start(data) {
    if (!ROUTES.length) { $("prompt").textContent = "Route data failed to load."; return; }
    const h = puzzleFromHash();
    setTestMode(testMode);
    setMapMode(mapMode);
    loadPuzzle(h.n, data && data.draft, h.preview);
    afterLoad(loadFonts);
    showStreakChip();
    countdown(); setInterval(countdown, 1000);
    if (!store.seenHelp) { store.seenHelp = true; save(store); $("help").showModal(); }
  }
  start({});
})();
