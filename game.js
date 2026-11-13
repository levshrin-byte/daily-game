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
  // Three puzzles a day: DAYS[n - 1] is [easy, medium, hard] as indices into ROUTES (scripts/plan_days.mjs).
  // After the plan runs out the days repeat, reshuffled once per cycle. Without a plan (an old data file),
  // day n falls back to the old one-a-day order.
  const DAYS = window.DAYS || [];
  const TIERS = ["Easy", "Medium", "Hard"], TK = "emh";
  function dayIndices(n) {
    if (!DAYS.length) { const i = (n - 1) % ROUTES.length; return [i, i, i]; }
    const cycle = Math.floor((n - 1) / DAYS.length);
    if (cycle === 0) return DAYS[n - 1];
    const rand = mulberry32(20261109 + cycle * 7919);
    const order = DAYS.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return DAYS[order[(n - 1) % DAYS.length]];
  }
  const routeOf = (n, t) => ROUTES[dayIndices(n)[t]];
  // Where a route (1-based route number) plays in the first cycle: { n, t }.
  const slotOf = (no) => { for (let d = 0; d < DAYS.length; d++) { const t = DAYS[d].indexOf(no - 1); if (t >= 0) return { n: d + 1, t }; } return null; };

  function puzzleDate(n) { return new Date(LAUNCH[0], LAUNCH[1], LAUNCH[2] + n - 1); }
  const fmtDate = (n, opts = { month: "short", day: "numeric" }) => puzzleDate(n).toLocaleDateString("en-US", opts);

  // ---------- Storage (best effort: may be blocked or empty) ----------
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { results: {} }; }
    catch { return { results: {} }; }
  }
  function save(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {} }
  let store = load();
  store.previews = store.previews || {};
  store.days = store.days || {};       // results by day and difficulty: { "12e": {...}, "12m": {...}, "12h": {...} }
  store.drafts = store.drafts || {};   // unfinished drawings, so switching routes never loses one
  const keyOf = (n, t) => `${n}${TK[t]}`;

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
  // day and tier (0 easy, 1 medium, 2 hard) of the puzzle on screen; in a preview, `preview` is the route number.
  let day, tier, route, axis, drawn, revealed, revealProgress = 0, justScored = null;

  // Route previews (for testing): any route, including future days, from the calendar's "All routes" tab.
  // Previews are saved apart, in store.previews by route number, and never touch results, stats, streaks or
  // share cards. Links: #t57 previews route 57; #p12m is day 12's medium route.
  let preview = 0;
  const curKey = () => (preview ? `t${preview}` : keyOf(day, tier));
  const savedResult = () => (preview ? store.previews[preview] : store.days[keyOf(day, tier)]);
  const firstOpen = (n) => { const t = [0, 1, 2].find((k) => !store.days[keyOf(n, k)]); return t == null ? 0 : t; };
  function puzzleFromHash() {
    const t = /^#t(\d+)$/.exec(location.hash);
    if (t) return { preview: Math.min(ROUTES.length, Math.max(1, +t[1])) };
    const m = /^#p(\d+)([emh])?$/.exec(location.hash);
    const n = m ? Math.min(today, Math.max(1, +m[1])) : today;
    return { n, t: m && m[2] ? TK.indexOf(m[2]) : firstOpen(n), openAll: location.hash === "#test" };
  }
  // The page may run where the history API is blocked (a sandboxed frame): links are a nice-to-have, never
  // a reason for a puzzle to fail to load.
  function setHash(hash) {
    try { if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname + location.search); } catch {}
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
  // Drawing has to be deliberate, so stray touches can't spoil a sketch:
  //  - Nothing is drawn when a finger lands. A stroke only counts once it has moved at least INPUT.travel px
  //    and INPUT.across px sideways; taps, dots and tiny wobbles are ignored completely.
  //  - Once it counts, the stroke is drawn from where the finger first landed, so nothing is lost.
  //  - One finger at a time: a second finger (or a palm) never draws, and two fingers landing together cancel
  //    a stroke that hasn't started yet (that's a pinch or a scroll, not drawing).
  //  - Light smoothing of the finger's height (an exponential moving average, in screen pixels) keeps a shaky
  //    finger from making spikes. This is input handling only: the real terrain is never smoothed.
  //  - Every stroke (and Clear) can be undone, one step at a time.
  const INPUT = { travel: 14, across: 9, smooth: 0.45 };
  let stroke = null, undoStack = [];
  function pointerPos(e) {
    const r = chart.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function paintTo(x, y) {
    const col = clamp(colAt(x), 0, COLS - 1);
    const m = clamp(elevAt(y), axis.lo, axis.hi);
    const last = stroke.last;
    if (last && last.col !== col) {
      const dir = Math.sign(col - last.col);
      for (let i = last.col + dir; i !== col; i += dir) drawn[i] = last.m + ((m - last.m) * (i - last.col)) / (col - last.col);
    }
    drawn[col] = m;
    stroke.last = { col, m };
    // Your finger hides the line, so show where it is.
    $("readout").textContent = `${fmtH(m)} · ${fmtD((route.distanceKm * col) / (COLS - 1))}`;
  }
  function pushUndo() { undoStack.push(drawn.slice()); if (undoStack.length > 60) undoStack.shift(); }
  chart.addEventListener("pointerdown", (e) => {
    if (revealed || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    if (stroke) {                                   // a second finger
      if (!stroke.live) { try { chart.releasePointerCapture(stroke.id); } catch {} stroke = null; }
      return;
    }
    const p = pointerPos(e);
    try { chart.setPointerCapture(e.pointerId); } catch {}
    stroke = { id: e.pointerId, x0: p.x, y0: p.y, px: p.x, py: p.y, travel: 0, live: false, sy: p.y, last: null };
  });
  chart.addEventListener("pointermove", (e) => {
    if (!stroke || e.pointerId !== stroke.id || revealed) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [e]) {
      const p = pointerPos(ev);
      stroke.travel += Math.hypot(p.x - stroke.px, p.y - stroke.py);
      stroke.px = p.x; stroke.py = p.y;
      if (!stroke.live) {
        if (stroke.travel < INPUT.travel || Math.abs(p.x - stroke.x0) < INPUT.across) continue;
        // It's a real drag: start the stroke where the finger landed.
        stroke.live = true; pushUndo();
        paintTo(stroke.x0, stroke.y0);
        $("hint").style.opacity = 0;
      }
      stroke.sy += INPUT.smooth * (p.y - stroke.sy);
      paintTo(p.x, stroke.sy);
    }
    if (stroke.live) { showCoverage(); render(); }
  });
  function endStroke(e) {
    if (!stroke || e.pointerId !== stroke.id) return;
    const was = stroke; stroke = null;
    $("readout").textContent = "";
    if (was.live) { saveDraft(); showTools(); }
    else if (e.type === "pointerup" && !drawn.some((v) => v != null) && !revealed) toast("Drag across the chart to draw");
  }
  chart.addEventListener("pointerup", endStroke);
  chart.addEventListener("pointercancel", endStroke);
  chart.addEventListener("lostpointercapture", endStroke);

  function undo() {
    if (revealed || !undoStack.length) return;
    drawn = undoStack.pop();
    afterEdit();
  }
  function clearDrawing() {
    if (revealed || !drawn.some((v) => v != null)) return;
    pushUndo(); drawn.fill(null);
    afterEdit();
    toast("Cleared. Undo brings it back");
  }
  function afterEdit() {
    $("hint").style.opacity = drawn.some((v) => v != null) ? 0 : 1;
    saveDraft(); showCoverage(); showTools(); render();
  }
  function showTools() {
    const any = drawn.some((v) => v != null);
    $("undo").disabled = revealed || !undoStack.length;
    $("clear").disabled = revealed || !any;
  }
  // Unfinished drawings, kept per puzzle (and in storage for daily puzzles) so switching routes loses nothing.
  const drafts = {};
  function saveDraft() {
    if (revealed || !route) return;
    const k = curKey(), any = drawn.some((v) => v != null);
    drafts[k] = { drawn: drawn.slice(), undo: undoStack.slice() };
    if (!preview) { if (any) store.drafts[k] = drawn.map((v) => (v == null ? null : Math.round(v))); else delete store.drafts[k]; save(store); }
  }

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
  // (Old results are keyed by puzzle number, when puzzle n was ROUTES[n - 1].)
  store.results = store.results || {};
  if (store.scoring !== SCORING) {
    for (const [n, res] of Object.entries(store.results)) {
      const r = ROUTES[(+n - 1) % ROUTES.length];
      if (!r || !res.drawing || res.drawing.length !== COLS) continue;
      const s2 = scoreOf(res.drawing, r, axisFor(r.elev));
      res.v1 = res.v1 || res.score; res.score = s2.score; res.squares = s2.squares;
    }
    store.scoring = SCORING; save(store);
  }
  // Three a day (iteration 3): each one-a-day result moves to the day and difficulty where its route now
  // plays. Days 1-5 kept their original route in the slot matching its difficulty, so a result from day n
  // lands on day n. The old results stay in store.results as a backup and are not counted again.
  if (!store.threeADay) {
    for (const [n, res] of Object.entries(store.results)) {
      const slot = slotOf(+n);
      if (!slot || !res.drawing) continue;
      const k = keyOf(slot.n, slot.t);
      if (!store.days[k]) store.days[k] = { ...res, daily: !!res.daily && slot.n === +n, from: +n };
    }
    store.threeADay = true; delete store.testMode; save(store);
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
    stroke = null;
    const user = filled();
    const { score, squares } = scoreOf(user);
    const before = stats();
    justScored = { prevBest: !preview && before.played ? before.best : null };
    const res = { score, squares, drawing: user.map(Math.round), at: Date.now() };
    if (preview) store.previews[preview] = res;
    else store.days[keyOf(day, tier)] = { ...res, daily: day === today };
    delete store.drafts[curKey()]; delete drafts[curKey()];
    save(store);
    drawn = user;
    reveal(true);
  }
  function reveal(animate) {
    revealed = true; undoStack = [];
    $("submit").disabled = true; showTools();
    $("hint").style.opacity = 0;
    showCoverage();
    showTiers();
    $("prompt").textContent = "Here's the real ground.";
    chart.style.cursor = "default";
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      revealProgress = 1; render(); showResult(); return;
    }
    const t0 = performance.now(), dur = 1400, k = curKey();
    const tick = (t) => {
      if (k !== curKey()) return; // switched puzzles mid-animation
      const p = Math.min(1, (t - t0) / dur);
      revealProgress = 1 - Math.pow(1 - p, 2);
      render();
      if (p < 1) requestAnimationFrame(tick); else showResult();
    };
    requestAnimationFrame(tick);
  }

  // ---------- Results ----------
  // Three puzzles a day, one streak: a day counts towards the streak when you finish at least one of its
  // three routes on that day. The streak survives until the end of today, so yesterday's streak still shows
  // before you've played today. Played / Average / Best count every puzzle you've finished.
  const dayResults = (n) => [0, 1, 2].map((t) => store.days[keyOf(n, t)] || null);
  function stats() {
    const all = Object.entries(store.days);
    const scores = all.map(([, r]) => r.score);
    const dailies = new Set(all.filter(([, r]) => r.daily).map(([k]) => parseInt(k, 10)));
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
    const r = savedResult();
    if (!r) return;
    $("share-box").hidden = !!preview; $("preview-note").hidden = !preview;
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
    showDayNext();
    $("share-preview").textContent = shareText();
    const s = stats();
    $("st-played").textContent = s.played; $("st-avg").textContent = s.avg;
    $("st-streak").textContent = s.streak; $("st-max").textContent = s.maxStreak;
    showStreakChip();
    if (fresh) setTimeout(() => $("result").scrollIntoView({ behavior: "smooth", block: "start" }), 250);
  }
  // Under a daily result: a button to the next route of the day you haven't played, or the day's total.
  function showDayNext() {
    const box = $("day-next");
    if (preview) { box.innerHTML = ""; return; }
    const res = dayResults(day), next = [1, 2, 0].map((k) => (tier + k) % 3).find((t) => !res[t]);
    box.innerHTML = next != null
      ? `<button class="btn primary wide" data-go="${next}">Next: ${TIERS[next]} route →</button>`
      : `<p class="day-done">Day complete: <b class="mono">${res.reduce((a, r) => a + r.score, 0)}</b>/300 across all three routes.</p>`;
  }
  $("day-next").addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]");
    if (b) { loadPuzzle({ n: day, t: +b.dataset.go }); window.scrollTo({ top: 0, behavior: "smooth" }); }
  });
  // One card per day, covering its three routes. It shows only squares and scores (never heights or places),
  // so it gives nothing away. Previews have no card.
  function shareText() {
    if (preview) return "";
    const res = dayResults(day);
    if (!res.some(Boolean)) return "";
    const { streak } = stats();
    const lines = [`Elevation #${day} · ${fmtDate(day)} ⛰️`];
    res.forEach((r, t) => lines.push(`${TIERS[t].padEnd(6, " ")} ${r ? `${r.squares} ${r.score}${r.daily ? "" : " ↺"}` : "⬜⬜⬜⬜⬜ –"}`));
    const done = res.filter(Boolean);
    if (done.length === 3) lines.push(`Total ${done.reduce((a, r) => a + r.score, 0)}/300`);
    if (res.some((r) => r && r.daily) && streak >= 2) lines.push(`🔥 ${streak}-day streak`);
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

  // ---------- Calendar: past days, and all routes for previews ----------
  let archiveTab = "past";
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function openArchive(tab) {
    if (tab) archiveTab = tab;
    document.querySelectorAll("#archive-tabs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === archiveTab)));
    $("route-search").hidden = archiveTab !== "all";
    const list = $("archive-list"), s = stats();
    const rows = [];
    if (archiveTab === "all") {
      $("archive-title").textContent = "All routes";
      $("archive-summary").textContent = `Testing: preview any of the ${ROUTES.length} routes, including future days. Previews never count towards your stats, streak or share card.`;
      const days = DAYS.length || ROUTES.length;
      for (let n = 1; n <= days; n++) {
        dayIndices(n).forEach((i, t) => {
          if (!DAYS.length && t) return;
          const r = ROUTES[i], no = i + 1, res = store.previews[no];
          const when = n === today ? " · Today" : n > today ? "" : " · past";
          rows.push(`<li><button class="arch-row${preview === no ? " current" : ""}" data-t="${no}" data-q="${esc(`${r.from} ${r.to} ${r.country} ${r.region} ${r.id} ${TIERS[t]} day ${n}`.toLowerCase())}" data-day="${n}">
          <span class="arch-no mono">${n}${TK[t].toUpperCase()}</span>
          <span class="arch-main"><span class="arch-date">Day ${n} · ${fmtDate(n, { month: "short", day: "numeric" })}${when} · ${TIERS[t]}</span>
            <span class="arch-route">${esc(r.from)} → ${esc(r.to)}</span></span>
          <span class="arch-res">${res ? `<b class="mono">${res.score}</b><span class="arch-diff">tested</span>` : `<span class="arch-play">Preview</span>`}</span>
        </button></li>`);
        });
      }
    } else {
      $("archive-title").textContent = "Past days";
      const done = Object.keys(store.days).filter((k) => parseInt(k, 10) <= today).length;
      $("archive-summary").textContent = `${done} of ${today * 3} routes played${s.played ? ` · average ${s.avg}` : ""}`;
      for (let n = today; n >= 1; n--) {
        const res = dayResults(n);
        const cells = [0, 1, 2].map((t) => {
          const r = res[t], cur = !preview && n === day && t === tier;
          return `<button class="arch-cell${r ? " done" : ""}${cur ? " current" : ""}" data-n="${n}" data-tier="${t}" aria-label="Day ${n} ${TIERS[t]}${r ? `, scored ${r.score}` : ", not played"}">
            <span class="arch-diff">${TIERS[t]}</span>${r ? `<b class="mono">${r.score}</b>` : `<span class="arch-play">Play</span>`}</button>`;
        }).join("");
        rows.push(`<li class="arch-day${!preview && n === day ? " current" : ""}"><div class="arch-day-head"><span class="arch-no mono">#${n}</span>
          <span class="arch-date">${fmtDate(n, { weekday: "short", month: "short", day: "numeric" })}${n === today ? " · Today" : ""}</span></div>
          <div class="arch-cells">${cells}</div></li>`);
      }
    }
    list.innerHTML = rows.join("");
    filterRoutes();
    try { if (!$("archive").open) $("archive").showModal(); } catch { $("archive").setAttribute("open", ""); }
    const cur = list.querySelector(".current");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }
  function filterRoutes() {
    const q = archiveTab === "all" ? $("route-search").value.trim().toLowerCase().replace(/^#/, "") : "";
    for (const b of $("archive-list").querySelectorAll("[data-q]")) b.parentElement.hidden = !!q && !b.dataset.q.includes(q) && b.dataset.day !== q;
  }
  function closeDialog(d) { try { d.close(); } catch { d.removeAttribute("open"); } }
  $("route-search").addEventListener("input", filterRoutes);
  document.querySelectorAll("#archive-tabs button").forEach((b) => b.addEventListener("click", () => openArchive(b.dataset.tab)));
  $("archive-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-n],[data-t]");
    if (!b) return;
    closeDialog($("archive"));
    if (b.dataset.t) loadPuzzle({ preview: +b.dataset.t }); else loadPuzzle({ n: +b.dataset.n, t: +b.dataset.tier });
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  // The old hidden switch still works: five taps on the build stamp open the route list.
  let stampTaps = [];
  $("build-tag").addEventListener("click", () => {
    const now = Date.now();
    stampTaps = stampTaps.filter((t) => now - t < 4000).concat(now);
    if (stampTaps.length >= 5) { stampTaps = []; openArchive("all"); }
  });
  $("help-preview").addEventListener("click", () => { closeDialog($("help")); openArchive("all"); });
  $("redo").addEventListener("click", () => { delete store.previews[preview]; save(store); loadPuzzle({ preview }); });
  const exitPreview = () => { loadPuzzle({ n: today, t: firstOpen(today) }); window.scrollTo({ top: 0, behavior: "smooth" }); };
  $("exit-preview").addEventListener("click", exitPreview);
  $("exit-preview-2").addEventListener("click", exitPreview);
  $("archive-btn").addEventListener("click", () => openArchive());
  $("archive-btn-2").addEventListener("click", () => openArchive("past"));
  $("archive-close").addEventListener("click", () => closeDialog($("archive")));
  // Tapping the dark area around a dialog closes it.
  for (const d of [$("archive"), $("help")]) d.addEventListener("click", (e) => { if (e.target === d) closeDialog(d); });

  function countdown() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const s = Math.max(0, Math.floor((next - now) / 1000));
    const pad = (v) => String(v).padStart(2, "0");
    $("countdown").textContent = `New routes in ${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
    if (dayNumber(new Date()) !== today) $("countdown").textContent = "New routes are out. Reload to play them.";
  }

  // ---------- Puzzle setup ----------
  // The day's three difficulty tabs, each with its score once played.
  function showTiers() {
    $("tiers").hidden = !!preview; $("preview-bar").hidden = !preview;
    if (preview) return;
    const res = dayResults(day);
    document.querySelectorAll("#tiers button").forEach((b) => {
      const t = +b.dataset.tier, r = res[t];
      b.setAttribute("aria-pressed", String(t === tier));
      b.classList.toggle("done", !!r);
      b.querySelector(".t-state").textContent = r ? `✓ ${r.score}` : t === tier ? "Playing" : started(keyOf(day, t)) ? "Started" : "Play";
    });
    const n = res.filter(Boolean).length;
    $("day-sub").textContent = n === 3 ? `All three done · ${res.reduce((a, r) => a + r.score, 0)}/300` : `${n} of 3 routes played`;
  }
  const started = (k) => (drafts[k] ? drafts[k].drawn : store.drafts[k] || []).some((v) => v != null);
  // where: { n, t } for a daily puzzle, or { preview: routeNumber }.
  function loadPuzzle(where) {
    if (route && !revealed) saveDraft();
    stroke = null;
    preview = where.preview || 0;
    if (preview) {
      route = ROUTES[preview - 1];
      const slot = slotOf(preview);
      day = slot ? slot.n : today; tier = slot ? slot.t : 0;
    } else { day = where.n; tier = where.t; route = routeOf(day, tier); }
    axis = axisFor(route.elev);
    const k = curKey(), mem = drafts[k], kept = !preview && store.drafts[k];
    drawn = mem ? mem.drawn.slice() : kept && kept.length === COLS ? kept.slice() : new Array(COLS).fill(null);
    undoStack = mem ? mem.undo.slice() : [];
    revealed = false; revealProgress = 0;

    $("puzzle-no").textContent = `#${day}`;
    document.body.classList.toggle("previewing", !!preview);
    $("preview-what").textContent = preview ? `Route ${preview}: day ${day}, ${TIERS[tier]}${day > today ? " (upcoming)" : ""}` : "";
    $("puzzle-date").textContent = fmtDate(day, { weekday: "short", month: "short", day: "numeric" });
    $("today-btn").hidden = !!preview || day === today;
    $("prev").disabled = preview ? preview <= 1 : day <= 1;
    $("next").disabled = preview ? preview >= ROUTES.length : day >= today;
    $("prev").setAttribute("aria-label", preview ? "Previous route" : "Previous day");
    $("next").setAttribute("aria-label", preview ? "Next route" : "Next day");
    $("from").textContent = route.from; $("to").textContent = route.to;
    $("country").textContent = route.country ? `${route.country} · ` : "";
    showDistance();
    $("prompt").textContent = "Sketch how high the ground is along the line, from A to B.";
    $("submit").disabled = false;
    $("hint").style.opacity = drawn.some((v) => v != null) ? 0 : 1;
    $("result").hidden = true;
    chart.style.cursor = "crosshair";
    showTiers(); showTools();

    setHash(preview ? `#t${preview}` : day === today && tier === firstOpen(today) ? "" : `#p${day}${TK[tier]}`);
    fetchMapData(route);
    resize();
    showCoverage();
    const prior = savedResult();
    if (prior) { drawn = prior.drawing.slice(); reveal(false); }
  }

  document.querySelectorAll("#tiers button").forEach((b) => b.addEventListener("click", () => { if (+b.dataset.tier !== tier) loadPuzzle({ n: day, t: +b.dataset.tier }); }));
  $("undo").addEventListener("click", undo);
  $("clear").addEventListener("click", clearDrawing);
  $("today-btn").addEventListener("click", () => loadPuzzle({ n: today, t: firstOpen(today) }));
  $("submit").addEventListener("click", submit);
  const step = (d) => {
    if (preview) { const no = preview + d; if (no >= 1 && no <= ROUTES.length) loadPuzzle({ preview: no }); return; }
    const n = day + d; if (n >= 1 && n <= today) loadPuzzle({ n, t: tier });
  };
  $("prev").addEventListener("click", () => step(-1));
  $("next").addEventListener("click", () => step(1));
  $("help-btn").addEventListener("click", () => { try { $("help").showModal(); } catch { $("help").setAttribute("open", ""); } });
  $("help-close").addEventListener("click", () => closeDialog($("help")));
  // Two-tap reset (confirm() dialogs don't work inside artifacts).
  $("reset").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.armed) {
      store = { results: {}, days: {}, drafts: {}, previews: {}, seenHelp: true, scoring: SCORING, threeADay: true, units, mapMode }; save(store);
      for (const k of Object.keys(drafts)) delete drafts[k];
      btn.textContent = "Progress cleared"; delete btn.dataset.armed;
      loadPuzzle({ n: today, t: 0 }); showStreakChip();
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
  window.addEventListener("hashchange", () => {
    const h = puzzleFromHash();
    if (h.openAll) return openArchive("all");
    if (h.preview ? h.preview !== preview : preview || h.n !== day || h.t !== tier) loadPuzzle(h);
  });
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
  function start() {
    if (!ROUTES.length) { $("prompt").textContent = "Route data failed to load."; return; }
    const h = puzzleFromHash();
    setMapMode(mapMode);
    loadPuzzle(h);
    afterLoad(loadFonts);
    showStreakChip();
    countdown(); setInterval(countdown, 1000);
    if (h.openAll) openArchive("all");
    else if (!store.seenHelp) { store.seenHelp = true; save(store); try { $("help").showModal(); } catch {} }
  }
  start();
})();
