(() => {
  "use strict";

  // ---------- Config ----------
  const LAUNCH = [2026, 10, 9]; // 9 Nov 2026 (month is 0-based) = puzzle #1
  const COLS = 120;            // must match SAMPLES in scripts/bake_profiles.py
  const STORE_KEY = "elevation:v1";
  const PAD = { l: 52, r: 14, t: 14, b: 28 };
  const RANKS = [
    [90, "Mountain goat 🐐"], [75, "Trail guide 🧭"], [55, "Day hiker 🥾"],
    [35, "Tourist 📸"], [0, "Lost in the fog 🌫️"],
  ];

  const $ = (id) => document.getElementById(id);
  const ROUTES = window.ROUTES || [];

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
  // Shuffle the route list once per full cycle, so the order differs each time around.
  function routeFor(n) {
    const cycle = Math.floor((n - 1) / ROUTES.length);
    const rand = mulberry32(20261109 + cycle * 7919);
    const order = ROUTES.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return ROUTES[order[(n - 1) % ROUTES.length]];
  }

  // ---------- Storage (best effort) ----------
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { results: {} }; }
    catch { return { results: {} }; }
  }
  function save(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {} }
  let store = load();

  // ---------- State ----------
  const today = dayNumber(new Date());
  const params = new URLSearchParams(location.search);
  let puzzleNo = Math.min(today, Math.max(1, parseInt(params.get("n"), 10) || today));
  let route, axis, drawn, revealed, lastCol, revealProgress = 0, map;

  // ---------- Axis ----------
  // Coarse tiers so the axis gives away little about the answer.
  function axisFor(elev) {
    const max = Math.max(...elev), min = Math.min(...elev);
    const hi = [1000, 2500, 5000, 9000].find((t) => t >= max * 1.05) || 9000;
    const lo = min < -50 ? -500 : 0;
    return { lo, hi };
  }
  function tickStep(span) { return span <= 1500 ? 250 : span <= 3000 ? 500 : span <= 5500 ? 1000 : 1500; }

  // ---------- Canvas geometry ----------
  const canvas = $("chart");
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }
  const plotW = () => W - PAD.l - PAD.r;
  const plotH = () => H - PAD.t - PAD.b;
  const xOf = (col) => PAD.l + (col / (COLS - 1)) * plotW();
  const yOf = (m) => PAD.t + (1 - (m - axis.lo) / (axis.hi - axis.lo)) * plotH();
  const colAt = (x) => Math.round(((x - PAD.l) / plotW()) * (COLS - 1));
  const elevAt = (y) => axis.lo + (1 - (y - PAD.t) / plotH()) * (axis.hi - axis.lo);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  const fmt = (n) => Math.round(n).toLocaleString("en-US");

  // ---------- Rendering ----------
  function render() {
    if (!route || !W) return;
    const c = { grid: cssVar("--grid"), muted: cssVar("--muted"), line: cssVar("--line"), user: cssVar("--user"),
      real: cssVar("--real"), diff: cssVar("--diff"), sea: cssVar("--sea"), ink: cssVar("--ink"),
      pinA: cssVar("--pin-a"), pinB: cssVar("--pin-b") };
    ctx.clearRect(0, 0, W, H);

    // Grid and y labels
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const step = tickStep(axis.hi - axis.lo);
    for (let m = Math.ceil(axis.lo / step) * step; m <= axis.hi; m += step) {
      const y = yOf(m);
      ctx.strokeStyle = m === 0 ? c.sea : c.grid;
      ctx.lineWidth = 1;
      ctx.setLineDash(m === 0 && axis.lo < 0 ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = c.muted; ctx.textAlign = "right";
      ctx.fillText(m === 0 && axis.lo < 0 ? "sea" : `${fmt(m)} m`, PAD.l - 6, y);
    }
    // x labels
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let i = 0; i <= 4; i++) {
      const col = (i / 4) * (COLS - 1);
      const label = i === 0 ? "A" : i === 4 ? "B" : `${fmt((route.distanceKm * i) / 4)} km`;
      ctx.fillStyle = i === 0 ? c.pinA : i === 4 ? c.pinB : c.muted;
      ctx.font = (i === 0 || i === 4 ? "bold " : "") + "12px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(label, xOf(col), H - PAD.b + 8);
    }

    const real = route.elev;
    const upto = Math.floor(revealProgress * (COLS - 1));

    // Difference shading during/after reveal
    if (revealProgress > 0) {
      const user = filled();
      ctx.fillStyle = c.diff;
      ctx.beginPath();
      for (let i = 0; i <= upto; i++) ctx.lineTo(xOf(i), yOf(user[i]));
      for (let i = upto; i >= 0; i--) ctx.lineTo(xOf(i), yOf(real[i]));
      ctx.closePath(); ctx.fill();
    }

    // User line (breaks at gaps before submit)
    ctx.strokeStyle = c.user; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.lineCap = "round";
    const series = revealed ? filled() : drawn;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < COLS; i++) {
      const v = series[i];
      if (v == null) { pen = false; continue; }
      if (!pen) { ctx.moveTo(xOf(i), yOf(v)); pen = true; } else ctx.lineTo(xOf(i), yOf(v));
    }
    ctx.stroke();

    // Real line
    if (revealProgress > 0) {
      ctx.strokeStyle = c.real; ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i <= upto; i++) ctx.lineTo(xOf(i), yOf(real[i]));
      ctx.stroke();
    }

    // Peak and low markers after full reveal
    if (revealProgress >= 1) {
      markPoint(real.indexOf(Math.max(...real)), "▲", c.real, -1);
      const minI = real.indexOf(Math.min(...real));
      if (Math.min(...real) < 0) markPoint(minI, "▼", c.sea, 1);
      // Legend
      ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
      legend(PAD.l + 8, PAD.t + 4, c.real, "Real");
      legend(PAD.l + 62, PAD.t + 4, c.user, "Yours");
    }
  }
  function legend(x, y, color, text) {
    ctx.fillStyle = color; ctx.fillRect(x, y + 5, 14, 3);
    ctx.fillStyle = cssVar("--ink"); ctx.fillText(text, x + 19, y);
  }
  function markPoint(i, sym, color, dir) {
    const x = xOf(i), y = yOf(route.elev[i]);
    ctx.fillStyle = color; ctx.font = "bold 12px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = dir < 0 ? "bottom" : "top";
    ctx.textAlign = x > W - 90 ? "right" : x < PAD.l + 60 ? "left" : "center";
    ctx.fillText(`${sym} ${fmt(route.elev[i])} m`, x, y + dir * 6);
  }

  // ---------- Drawing input ----------
  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function paint(e) {
    const p = pointerPos(e);
    const col = clamp(colAt(p.x), 0, COLS - 1);
    const m = clamp(elevAt(p.y), axis.lo, axis.hi);
    if (lastCol != null && lastCol.col !== col) {
      const [a, b] = [lastCol, { col, m }];
      const dir = Math.sign(b.col - a.col);
      for (let i = a.col + dir; i !== b.col; i += dir) {
        drawn[i] = a.m + ((b.m - a.m) * (i - a.col)) / (b.col - a.col);
      }
    }
    drawn[col] = m;
    lastCol = { col, m };
    $("hint").style.opacity = 0;
    render();
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (revealed) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    lastCol = null;
    paint(e);
  });
  canvas.addEventListener("pointermove", (e) => { if (!revealed && canvas.hasPointerCapture(e.pointerId)) paint(e); });
  const endStroke = () => { lastCol = null; };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  // Fill gaps by linear interpolation; extend ends flat.
  function filled() {
    const out = drawn.slice();
    const known = [];
    out.forEach((v, i) => { if (v != null) known.push(i); });
    if (!known.length) return out.fill(0);
    for (let i = 0; i < COLS; i++) {
      if (out[i] != null) continue;
      const next = known.find((k) => k > i), prev = [...known].reverse().find((k) => k < i);
      if (prev == null) out[i] = out[next];
      else if (next == null) out[i] = out[prev];
      else out[i] = out[prev] + ((out[next] - out[prev]) * (i - prev)) / (next - prev);
    }
    return out;
  }

  // ---------- Scoring ----------
  function scoreOf(user) {
    const span = axis.hi - axis.lo;
    const err = user.map((v, i) => Math.abs(v - route.elev[i]) / span);
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const score = Math.round(100 * Math.max(0, 1 - mean(err) / 0.25));
    const squares = [0, 1, 2, 3, 4].map((k) => {
      const seg = err.slice(Math.floor((k * COLS) / 5), Math.floor(((k + 1) * COLS) / 5));
      const e = mean(seg);
      return e < 0.04 ? "🟩" : e < 0.09 ? "🟨" : e < 0.16 ? "🟧" : "🟥";
    }).join("");
    return { score, squares };
  }

  // ---------- Submit / reveal ----------
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), 2000);
  }
  function submit() {
    if (revealed) return;
    const coverage = drawn.filter((v) => v != null).length / COLS;
    if (coverage < 0.6) { toast("Draw across more of the route first"); return; }
    const user = filled();
    const { score, squares } = scoreOf(user);
    store.results[puzzleNo] = {
      score, squares, drawing: user.map(Math.round),
      daily: puzzleNo === today, at: Date.now(),
    };
    save(store);
    drawn = user;
    reveal(true);
  }
  function reveal(animate) {
    revealed = true;
    $("submit").disabled = true; $("clear").disabled = true;
    $("hint").style.opacity = 0;
    $("prompt").textContent = "Here's the real profile.";
    canvas.style.cursor = "default";
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      revealProgress = 1; render(); showResult(); return;
    }
    const t0 = performance.now(), dur = 1400;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      revealProgress = 1 - Math.pow(1 - p, 2);
      render();
      if (p < 1) requestAnimationFrame(tick); else showResult();
    };
    requestAnimationFrame(tick);
  }

  // ---------- Results ----------
  function stats() {
    const all = Object.entries(store.results);
    const scores = all.map(([, r]) => r.score);
    const dailies = new Set(all.filter(([, r]) => r.daily).map(([n]) => +n));
    let streak = 0;
    for (let n = dailies.has(today) ? today : today - 1; dailies.has(n); n--) streak++;
    return {
      played: scores.length,
      avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      best: scores.length ? Math.max(...scores) : 0,
      streak,
    };
  }
  function showResult() {
    const r = store.results[puzzleNo];
    $("result").hidden = false;
    $("score").textContent = r.score;
    $("rank").textContent = RANKS.find(([min]) => r.score >= min)[1];
    $("squares").textContent = r.squares;
    $("fact").textContent = route.fact;
    const s = stats();
    $("st-played").textContent = s.played; $("st-avg").textContent = s.avg;
    $("st-best").textContent = s.best; $("st-streak").textContent = s.streak;
  }
  function shareText() {
    const r = store.results[puzzleNo];
    const url = location.origin + location.pathname + (puzzleNo !== today ? `?n=${puzzleNo}` : "");
    return `Elevation #${puzzleNo} ⛰️ ${r.score}/100\n${route.from} → ${route.to}\n${r.squares}\n${url}`;
  }
  $("share").addEventListener("click", async () => {
    const text = shareText();
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      window.prompt("Copy your result:", text);
    }
  });
  function countdown() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const s = Math.max(0, Math.floor((next - now) / 1000));
    const hh = String(Math.floor(s / 3600)).padStart(2, "0");
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    $("countdown").textContent = `Next route in ${hh}:${mm}:${ss}`;
  }

  // ---------- Map ----------
  function drawMap() {
    const el = $("map");
    if (!window.L) { el.innerHTML = '<div class="map-fallback">Map unavailable offline</div>'; return; }
    if (map) map.remove();
    map = L.map(el, { scrollWheelZoom: false, zoomControl: true, attributionControl: false });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd", maxZoom: 18,
    }).addTo(map);
    const a = route.a, b = route.b;
    const accent = cssVar("--ink");
    L.polyline([a, b], { color: accent, weight: 3, dashArray: "6 6" }).addTo(map);
    const pin = (latlng, label, color) => L.marker(latlng, {
      icon: L.divIcon({ className: "", html: `<span class="pin" style="background:${color}">${label}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).addTo(map);
    pin(a, "A", cssVar("--pin-a")); pin(b, "B", cssVar("--pin-b"));
    map.fitBounds([a, b], { padding: [36, 36] });
  }

  // ---------- Setup ----------
  function loadPuzzle(n) {
    puzzleNo = n;
    route = routeFor(n);
    axis = axisFor(route.elev);
    drawn = new Array(COLS).fill(null);
    revealed = false; revealProgress = 0; lastCol = null;

    $("puzzle-no").textContent = `#${n}`;
    $("prev").disabled = n <= 1;
    $("next").disabled = n >= today;
    $("from").textContent = route.from; $("to").textContent = route.to;
    $("distance").textContent = `${fmt(route.distanceKm)} km`;
    $("prompt").textContent = "Sketch the ground's height along the line, from A to B.";
    $("submit").disabled = false; $("clear").disabled = false;
    $("hint").style.opacity = 1;
    $("result").hidden = true;
    canvas.style.cursor = "crosshair";

    const url = new URL(location.href);
    if (n === today) url.searchParams.delete("n"); else url.searchParams.set("n", n);
    history.replaceState(null, "", url);

    drawMap();
    resize();
    const prior = store.results[n];
    if (prior) { drawn = prior.drawing.slice(); reveal(false); }
  }

  $("clear").addEventListener("click", () => { drawn.fill(null); $("hint").style.opacity = 1; render(); });
  $("submit").addEventListener("click", submit);
  $("prev").addEventListener("click", () => puzzleNo > 1 && loadPuzzle(puzzleNo - 1));
  $("next").addEventListener("click", () => puzzleNo < today && loadPuzzle(puzzleNo + 1));
  $("help-btn").addEventListener("click", () => $("help").showModal());
  window.addEventListener("resize", resize);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { render(); });

  if (!ROUTES.length) { $("prompt").textContent = "Route data failed to load."; return; }
  loadPuzzle(puzzleNo);
  countdown(); setInterval(countdown, 1000);
  if (!store.seenHelp) { store.seenHelp = true; save(store); $("help").showModal(); }
})();
