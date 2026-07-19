import * as M from "./metrics.js";
import * as S from "./storage.js";
import * as SF from "./scryfall.js";
import * as SYNC from "./sync.js";

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const pct = x => x == null ? "–" : Math.round(x * 100) + "%";
/* finish rating on a 0–10 scale: avgNorm 0..1 -> "0.0".."10.0" (5.0 = mid-table average) */
const rate = norm => norm == null ? "–" : (norm * 10).toFixed(1);
const rateVs = vsAvg => vsAvg == null ? "–" : rate(vsAvg + 0.5);   // from centred finishVsAvg
const shortName = c => (c || "").split(" + ")[0];   // full commander name; drop only the partner half
const euDate = iso => { const p = String(iso).split("-"); return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : iso; };

/* commander identity display */
const deckCI = d => d?.ci || [];
const ciPips = ci => ci?.length ? `<span class="pips-ci">${ci.map(c => `<span class="ci ${c}"></span>`).join("")}</span>` : "";
const artImg = (url, cls = "art", pos) => url ? `<img class="${cls}" src="${esc(url)}" ${pos ? `style="object-position:50% ${pos}%"` : ""} alt="" loading="lazy" />` : "";
const artPosOf = d => d?.artPos ?? null;   // vertical focal %, null = CSS default

/* ---- colour-identity ring: a CI-coloured border around the commander art, replacing the
   inline pips so it conveys identity without eating horizontal space. Square thumbnails get a
   conic ring (equal wedges); wide banners get a left→right linear band. ---- */
const CI_COLOR = { W:"#f6f0da", U:"#2f7dc0", B:"#414048", R:"#d0473e", G:"#3f9d5c", C:"#9aa0a8" };
const ciGrad = (ci, kind = "conic") => {
  if (!ci?.length) return "";
  if (ci.length === 1) return CI_COLOR[ci[0]];
  const span = kind === "linear" ? 100 : 360, u = kind === "linear" ? "%" : "deg", step = span / ci.length;
  const stops = ci.map((c, i) => `${CI_COLOR[c]} ${(i * step).toFixed(1)}${u} ${((i + 1) * step).toFixed(1)}${u}`).join(",");
  return kind === "linear" ? `linear-gradient(90deg,${stops})` : `conic-gradient(from 0deg,${stops})`;
};
/* wrap an already-built art <img> in a CI ring; returns the bare art when there's no art or no CI.
   `extra` adds a frame modifier class ("field" for form-field-height art). */
const frameArt = (artHtml, ci, extra = "") => {
  const g = artHtml && ciGrad(ci);
  return g ? `<span class="ci-frame${extra ? " " + extra : ""}" style="background:${g}">${artHtml}</span>` : (artHtml || "");
};
const frameWide = (artHtml, ci, variant) => {   // variant: "banner"
  const g = artHtml && ciGrad(ci, "linear");
  return g ? `<span class="ci-frame ${variant}" style="background:${g}">${artHtml}</span>` : (artHtml || "");
};
const artCI = (d, cls = "art", pos) => frameArt(artImg(d?.art, cls, pos), deckCI(d), /\bfield\b/.test(cls) ? "field" : "");
/* big square commander art for the left of a participant / rival row (fixed width via CSS). Always
   renders a box — placeholder when there's no art — wrapped in a CI ring when known. A partner /
   background deck (art2) shows two stacked squares rather than one stretched image. */
const rowArt = (art, ci, art2 = null) => {
  const cell = a => a ? `<img class="rowfill" src="${esc(a)}" alt="" loading="lazy" />` : `<span class="rowfill ph"></span>`;
  const inner = art2 ? `${cell(art)}${cell(art2)}` : cell(art);
  const g = ciGrad(ci);
  return `<span class="ci-frame rowfill${g ? "" : " noring"}"${g ? ` style="background:${g}"` : ""}>${inner}</span>`;
};
const deckTitle = d => d.commander2 ? `${esc(d.commander)} <span style="color:var(--muted)">+</span> ${esc(d.commander2)}` : esc(d.commander);
const CI_LABEL = { W:"White", U:"Blue", B:"Black", R:"Red", G:"Green", C:"Colourless" };
/* full commander name for an opponent seat (handles partner pairs) */
const seatCards = s => {
  const d = s.deckId ? S.deckById(s.deckId) : null;
  const c1 = s.commander || d?.commander || "?";
  const c2 = s.commander2 || d?.commander2;
  return c2 ? `${c1} + ${c2}` : c1;
};

let MIN_GAMES = 2;
let podFilter = 0; // 0=all, 4, 5

/* derived collections */
const allGames = () => S.games();
const myGamesForDeck = id => allGames().filter(g => M.mySeat(g)?.deckId === id);
const deckRows = (filter = 0) => S.myDecks().map(d => {
  let gs = myGamesForDeck(d.id);
  if (filter) gs = gs.filter(g => g.seats.length === filter);
  return { ...d, ...M.aggregateDeck(gs) };
});
/* deck rows for any player (same shape as deckRows), derived from the decks they've actually
   played — so the shared deck-list renderer works for a rival too. */
const subjectDecks = pid => {
  const map = {};
  for (const g of allGames()) {
    const s = M.seatOf(g, pid); if (!s) continue;
    const key = s.deckId || s.commander; if (!key) continue;
    if (!map[key]) {
      const d = s.deckId ? S.deckById(s.deckId) : null;
      map[key] = { id: s.deckId || null, commander: d?.commander || s.commander, commander2: d?.commander2 || s.commander2 || null,
        art: d?.art || s.art || null, art2: d?.art2 || s.art2 || null, ci: d?.ci || s.ci || [], theme: d?.theme || "", artPos: d?.artPos ?? null, _gs: [] };
    }
    map[key]._gs.push(g);
  }
  return Object.values(map).map(({ _gs, ...d }) => ({ ...d, ...M.aggregateDeck(_gs, pid) }));
};

/* ---------- toast ---------- */
let toastEl;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "toast"; document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 1600);
}

/* ---------- Overview hero visuals ---------- */
const heroCol = v => v >= 0 ? "var(--good)" : "var(--bad)";
const HERO_MAX = 0.5;   // gauge spans the full finish scale: -0.5 (=0/10) .. 0 (=5/10) .. +0.5 (=10/10)

function heroGauge(v, scale = 1) {
  const c = Math.max(-HERO_MAX, Math.min(HERO_MAX, v || 0));
  const ang = (90 - (c / HERO_MAX) * 90) * Math.PI / 180;
  const cx = 100, cy = 100, R = 78;
  const nx = (cx + R * Math.cos(ang)).toFixed(1), ny = (cy - R * Math.sin(ang)).toFixed(1);
  return `<svg viewBox="0 0 200 112" width="${200 * scale}" height="${112 * scale}" style="display:block">
    <path d="M20 100 A80 80 0 0 1 100 20" fill="none" stroke="var(--bad)" stroke-width="12" stroke-linecap="round" opacity=".3"/>
    <path d="M100 20 A80 80 0 0 1 180 100" fill="none" stroke="var(--good)" stroke-width="12" stroke-linecap="round" opacity=".3"/>
    <line x1="100" y1="22" x2="100" y2="36" stroke="var(--muted)" stroke-width="2"/>
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${heroCol(v)}" stroke-width="4" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="6" fill="${heroCol(v)}"/>
  </svg>`;
}

/* points = [{date, v}]. Baseline at 0 (= mid-table, an average finish): line + area are green when
   you're finishing above average, red below, split exactly at 0 via SVG clips. The SVG is stretched
   horizontally (preserveAspectRatio="none"), so two things that must stay crisp live as HTML
   overlays instead: the round dots (one per game, also the tap/hold targets) and the dotted zero
   baseline (an SVG dash pattern would smear under the stretch). Interactivity wired in renderDash. */
let sparkSeq = 0;
function heroSpark(points, w = 150, h = 40) {
  if (points.length < 2) return "";
  const data = points.map(p => p.v);
  const lo = Math.min(0, ...data), hi = Math.max(0, ...data), span = (hi - lo) || 1;
  const X = i => i / (data.length - 1) * w, Y = v => h - ((v - lo) / span) * (h - 6) - 3;
  const line = data.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const tY = Y(0).toFixed(1);
  const id = "sp" + (++sparkSeq);
  const dots = points.map((p, i) =>
    `<span class="spark-dot${i === points.length - 1 ? " end" : ""}"
       style="left:${(i / (data.length - 1) * 100).toFixed(2)}%;top:${(Y(p.v) / h * 100).toFixed(2)}%;background:${heroCol(p.v)}"
       data-i="${i}" data-date="${p.date}" data-val="${p.v}"></span>`).join("");
  // current form as a direct end-label above the last dot — or below it when the dot is
  // near the top of the box. Right-aligned to the wrap so it can never widen the page.
  const last = points.at(-1), lastY = Y(last.v);
  const labelY = lastY >= 19 ? lastY - 13 : lastY + 13;   // 13px clears the dot + label half-height inside h=40
  const now = `<span class="spark-now" style="top:${(labelY / h * 100).toFixed(2)}%;color:${heroCol(last.v)}">${rateVs(last.v)}</span>`;
  return `<div class="spark-wrap" style="height:${h}px">
    <div class="spark-chip"></div>
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
      <defs>
        <clipPath id="up${id}"><rect x="0" y="0" width="${w}" height="${tY}"/></clipPath>
        <clipPath id="dn${id}"><rect x="0" y="${tY}" width="${w}" height="${(h - tY).toFixed(1)}"/></clipPath>
      </defs>
      <polygon points="0,${tY} ${line} ${w},${tY}" fill="var(--good)" opacity=".2" clip-path="url(#up${id})"/>
      <polygon points="0,${tY} ${line} ${w},${tY}" fill="var(--bad)"  opacity=".2" clip-path="url(#dn${id})"/>
      <polyline points="${line}" fill="none" stroke="var(--good)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#up${id})"/>
      <polyline points="${line}" fill="none" stroke="var(--bad)"  stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#dn${id})"/>
    </svg>
    <div class="spark-zero" style="top:${(Y(0) / h * 100).toFixed(2)}%"></div>${dots}${now}</div>`;
}

/* Sparkline = recent *form*, not the all-time average: each point is WR-vs-expected over the
   trailing FORM_WINDOW games. A cumulative average flattens (each game moves it ~1/n), so it
   eventually carries no signal; a rolling window stays responsive and shows hot/cold streaks.
   With fewer than FORM_WINDOW games it's just the cumulative line. The headline number/gauge
   stay all-time. */
const FORM_WINDOW = 6;
function heroSeries(games, pid = "me") {
  const sorted = games.filter(g => M.seatOf(g, pid)?.placement != null)   // only games with a recorded finish
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return sorted.map((_, i) => ({
    date: sorted[i].date,
    v: M.pilotOverall(sorted.slice(Math.max(0, i - FORM_WINDOW + 1), i + 1), pid).finishVsAvg,
  }));
}
/* Recent-form label from the latest rolling finish rating. Thresholds are in finishVsAvg (= rating
   on a 0–10 scale, centred so 0 = 5.0). Tight 1.5-point outer bands so 👑/💀 mean "almost always
   top / almost always last": 👑 ≥ 8.5 · 🗡️ 6.0–8.5 · ➖ 4.0–6.0 · 🛡️ 1.5–4.0 · 💀 < 1.5. */
const FORM_TIERS = [
  { min: 0.35,      label: "Ruling the table", cls: "pos", icon: "👑" },
  { min: 0.10,      label: "Ahead",            cls: "pos", icon: "🗡️" },
  { min: -0.10,     label: "Even",             cls: "",    icon: "➖" },
  { min: -0.35,     label: "Behind",           cls: "neg", icon: "🛡️" },
  { min: -Infinity, label: "First one out",    cls: "neg", icon: "💀" },
];
const tierFor = v => v == null ? null : (FORM_TIERS.find(t => v >= t.min) || null);
function heroForm(series) {
  if (series.length < 3) return null;   // too few games for a meaningful form read
  return tierFor(series.at(-1).v);
}

/* Shared hero tile (gauge + finish rating + form tier + sparkline) for any subject — the dashboard
   uses it for "me", the rival page for an opponent. Returns the markup + the series for wireSpark. */
function heroBlock(games, pid, label) {
  const a = M.pilotOverall(games, pid);
  const series = heroSeries(games, pid);
  const wrCls = (a.finishVsAvg ?? 0) >= 0 ? "pos" : "neg";
  const body = a.scored === 0
    ? `<div class="value" style="color:var(--muted)">–</div><div class="sub">${a.games === 0 ? "Log a game to get started" : "No finishing order recorded yet"}</div>`
    : `<div style="display:flex;align-items:center;gap:13px;margin-top:8px">
        <div style="flex:0 0 auto">${heroGauge(a.finishVsAvg, 0.66)}</div>
        <div style="flex:1;min-width:0">
          <div class="value ${wrCls}" style="font-size:32px">${rate(a.avgNorm)}</div>
          <div class="sub" style="margin:3px 0 ${series.length > 1 ? "9px" : "0"}">
            ${(() => { const f = heroForm(series); return f ? `<div class="${f.cls}" style="font-weight:600">${f.icon} ${f.label}</div>` : ""; })()}
            <div>${a.scored} game${a.scored === 1 ? "" : "s"} · Won ${pct(a.actualWR)}</div>
          </div>
          ${heroSpark(series)}
        </div>
      </div>`;
  return { series, html: `<div class="tiles"><div class="tile hero"><div class="label">${label}</div>
    <details class="hero-info"><summary aria-label="What does this score mean?">?</summary>
      <div class="info-pop">Where ${pid === "me" ? "you" : "they"} tend to finish, from 0 to 10.
        Winning every game is a <b>10</b>, going out first every game is a <b>0</b> — <b>5</b> is mid-pack.
        Every finish counts, not just wins, and pod size is factored in.</div>
    </details>${body}</div></div>` };
}

/* <details> only toggles on its own summary — close an open info pop on any outside tap */
document.addEventListener("click", e => {
  document.querySelectorAll(".hero-info[open]").forEach(d => { if (!d.contains(e.target)) d.removeAttribute("open"); });
});

/* wire the tap/hold date chip on a freshly-rendered sparkline inside `view` */
function wireSpark(view, series) {
  const wrap = view.querySelector(".spark-wrap");
  if (!wrap) return;
  const chip = wrap.querySelector(".spark-chip"), n = series.length;
  const show = el => {
    chip.textContent = `${euDate(el.dataset.date)} · ${rateVs(+el.dataset.val)}`;
    // clamp so the (translateX(-50%)-centred) chip never pokes past the wrap: an
    // overflowing chip widened the page and shifted the tab bar off-screen
    const half = chip.offsetWidth / 2 / wrap.clientWidth * 100;
    const pct = n > 1 ? (+el.dataset.i) / (n - 1) * 100 : 50;
    chip.style.left = Math.min(Math.max(pct, half), 100 - half) + "%";
    chip.classList.add("show");
  };
  const hide = () => chip.classList.remove("show");
  wrap.querySelectorAll(".spark-dot").forEach(c => {
    c.addEventListener("pointerenter", () => show(c));
    c.addEventListener("pointerdown", () => show(c));
  });
  wrap.addEventListener("pointerup", hide);
  wrap.addEventListener("pointerleave", hide);
  wrap.addEventListener("pointercancel", hide);
}

/* Shared ranked deck list (the "Finish rating" leaderboard). `clickable` opens the deck detail
   (only meaningful for my own decks). */
function deckLbHtml(rows, clickable = true) {
  return rows.slice().sort((x, y) => {
    if (!x.games) return 1; if (!y.games) return -1;
    return (y.finishVsAvg ?? -9) - (x.finishVsAvg ?? -9);
  }).map((d, i) => {
    const nav = clickable && d.id ? ` data-deck="${d.id}"` : ` style="cursor:default"`;
    const idCell = `<div style="display:flex;align-items:center;gap:9px;min-width:0">${artCI(d, "art", artPosOf(d))}
      <div style="min-width:0"><div class="name">${esc(shortName(d.commander))}</div>
        <div class="theme" style="display:flex;align-items:center;gap:6px;min-width:0"><span class="theme-txt">${esc(d.theme || "")}</span></div></div></div>`;
    if (!d.games) return `<div class="lb-row low"${nav}><div class="rank">–</div>${idCell}<div class="metric" style="color:var(--muted)">—<small>Not played</small></div></div>`;
    const low = d.games < MIN_GAMES;
    const cls = d.finishVsAvg >= 0 ? "pos" : "neg";
    return `<div class="lb-row ${low ? "low" : ""}"${nav}>
      <div class="rank">${i + 1}</div>
      ${idCell.replace('class="name">', `class="name">${low ? '<span class="flag" title="few games — still noisy">⚠</span> ' : ""}`)}
      <div class="metric ${cls}">${rate(d.avgNorm)}<small>${d.games} game${d.games === 1 ? "" : "s"}</small></div>
    </div>`;
  }).join("");
}

/* "Recently played" — a subject's last 3 games (one card per game, so back-to-back
   games with the same deck each get their own card). */
function recentBlock(games, pid, clickable) {
  const recent = [];
  for (const g of games.slice().sort((x, y) => y.date.localeCompare(x.date) || y.id.localeCompare(x.id))) {
    const s = M.seatOf(g, pid); const id = s?.deckId;
    if (id && S.deckById(id)) recent.push({ id, date: g.date, pi: M.placeInfo(g, pid), pod: g.seats.length });
    if (recent.length === 3) break;
  }
  if (!recent.length) return "";
  const cards = recent.map(r => {
    const d = S.deckById(r.id);
    const nav = clickable ? ` data-deck="${r.id}"` : ` style="cursor:default"`;
    return `<div class="leader"${nav}>
      ${d.art ? `<img class="recent-art" src="${esc(d.art)}" ${artPosOf(d) != null ? `style="object-position:50% ${artPosOf(d)}%"` : ""} alt="" loading="lazy" />` : ""}
      <div class="lt">${relDate(r.date)}</div>
      <div class="ln">${esc(shortName(d.commander))}</div>
      <div class="lr"><span class="lv" style="color:${placeColor(r.pi.start, r.pod)}">${placeLabel(r.pi)}</span><span class="lp">${r.pod}P</span></div></div>`;
  }).join("");
  return `<div class="section-head"><h2>Recently played</h2></div><div class="recent-grid">${cards}</div>`;
}

/* The whole overview (hero + recently played + ranked deck list) for any subject. The dashboard is
   this for "me"; a rival page is the same thing for an opponent. Returns markup + series. */
function overviewBlock(games, pid, label, clickable) {
  const hero = heroBlock(games, pid, label);
  const decks = pid === "me" ? deckRows(0) : subjectDecks(pid);
  return { series: hero.series, html: hero.html + recentBlock(games, pid, clickable) + `
    <div class="section-head"><h2>Decks · Finish rating</h2></div>
    <div class="lb">${deckLbHtml(decks, clickable)}</div>` };
}

/* ---------- Overview ---------- */
const relDate = iso => {                       // "Today" / "3d ago" / "2 weeks ago"
  const d = Math.round((Date.parse(today()) - Date.parse(iso)) / 864e5);
  if (d <= 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  return `${Math.round(d / 30)} months ago`;
};

function renderDash() {
  const ov = overviewBlock(allGames(), "me", "My finish rating", true);
  $("#view-dash").innerHTML = ov.html;
  $("#view-dash").querySelectorAll("[data-deck]").forEach(r =>
    r.addEventListener("click", () => openDeck(r.dataset.deck)));
  wireSpark($("#view-dash"), ov.series);
}

/* ---------- Compare ---------- */
/* avgNorm = pod-size-fair finish (1st=100%, last=0%); raw avg placement is intentionally
   omitted because it ignores pod size (3rd of 4 ≠ 3rd of 5). */
const METRICS = [
  { key:"finishVsAvg", label:"Finish rating", bar:"diverge", fmt:d=>rate(d.avgNorm) },
  { key:"actualWR",    label:"Win rate",            bar:"abs",     fmt:d=>pct(d.actualWR) },
  { key:"volatility",  label:"Swinginess",          bar:"relLow",  fmt:d=>d.volatility==null?"–":d.volatility.toFixed(2) },
  { key:"games",       label:"Games played",        bar:"relHigh", neutral:true, fmt:d=>String(d.games) },
];

/* goodness 0..1 -> red→gold→green, gold in the middle so it still reads MTG. Anchored on the
   same --bad/--warn/--good vars the diverge bars use, so greens match across the screen. */
const goodnessColor = f => f <= 0.5
  ? `color-mix(in srgb, var(--warn) ${(f * 200).toFixed(0)}%, var(--bad))`
  : `color-mix(in srgb, var(--good) ${((f - 0.5) * 200).toFixed(0)}%, var(--warn))`;

/* colour a finishing place relative to the pod: 1st = gold (the win), 2nd = green, then a pure
   orange → red gradient for 3rd…last. Green is never blended into the orange (that mix goes
   yellow, which reads like the gold), so every tier stays visually distinct. Shared by
   recently-played + history. */
/* tie-aware place text from placeInfo: "T‑3rd" when knocked out together
   (non-breaking hyphen U+2011 — a plain "-" lets narrow badges wrap to "T-" / "3RD") */
const placeLabel = pi => pi.start == null ? "—" : (pi.tied ? "T‑" : "") + ord(pi.start);

const placeColor = (p, pod) => {
  if (p == null) return "var(--muted)";
  if (p === 1) return "var(--accent)";          // gold — the win
  if (p === 2) return "var(--good)";            // green — runner-up
  if (p >= pod) return "var(--bad)";            // red — dead last
  const f = (pod - p) / (pod - 3);              // 3rd = orange (1) … toward last = red (0)
  return `color-mix(in srgb, #e0742e ${(f * 100).toFixed(0)}%, var(--bad))`;
};

function metricSection(m) {
  let rows = deckRows(podFilter).filter(d => d.games && d[m.key] != null);
  if (!rows.length) return "";
  rows.sort((a, b) => (a[m.key] - b[m.key]) * (m.bar === "relLow" ? 1 : -1));
  const vals = rows.map(d => d[m.key]);
  const maxAbs = Math.max(1e-9, ...vals.map(Math.abs));
  const min = Math.min(...vals), max = Math.max(...vals);
  const bestVal = m.bar === "relLow" ? min : max;

  const bar = v => {
    if (m.bar === "diverge") {
      const w = Math.abs(v) / maxAbs * 50;
      const side = v >= 0 ? `left:50%; width:${w}%; background:var(--good)` : `right:50%; width:${w}%; background:var(--bad)`;
      return `<div class="bar-track diverge"><span class="bar-axis"></span><span class="bar-fill" style="${side}"></span></div>`;
    }
    // frac = bar length; good = goodness 0..1 used for colour (best deck = green, worst = red)
    let frac, good;
    if (m.bar === "abs") { frac = v; good = max === min ? 1 : (v - min) / (max - min); }
    else if (m.bar === "relLow") { frac = max === min ? 1 : (max - v) / (max - min); good = frac; }
    else { frac = max ? v / max : 0; good = frac; }
    frac = Math.min(1, Math.max(0.03, frac));
    const color = m.neutral ? "var(--accent)" : goodnessColor(good);
    return `<div class="bar-track"><span class="bar-fill" style="left:0; width:${frac * 100}%; background:${color}"></span></div>`;
  };

  const list = rows.map((d, i) => {
    const low = d.games < MIN_GAMES;
    const isBest = d[m.key] === bestVal && rows.length > 1;
    const valCls = m.bar === "diverge" ? (d[m.key] >= 0 ? "pos" : "neg") : (isBest ? "best" : "");
    return `<div class="rank-row ${low ? "low" : ""}" data-deck="${d.id}">
      <div class="rank-head"><span class="rk">${i + 1}</span>
        <span class="rk-name">${esc(d.commander)}${low ? '<span class="flag">⚠</span>' : ""}</span>
        <span class="rk-val ${valCls}">${m.fmt(d)}</span></div>
      ${bar(d[m.key])}</div>`;
  }).join("");

  return `<div class="cmp-metric"><div class="cmp-h"><h3>${m.label}</h3></div>
    <div class="rank-list">${list}</div></div>`;
}

function renderLeaders() {
  const played = deckRows(0).filter(d => d.games);
  if (!played.length) return "";
  const extreme = (key, dir) => played.filter(d => d[key] != null).reduce((b, x) => b == null || (x[key] - b[key]) * dir > 0 ? x : b, null);
  const card = (icon, label, d, fmt) => d ? `<div class="leader"><div class="lt">${icon} ${label}</div><div class="ln">${esc(shortName(d.commander))}</div><div class="lv">${fmt(d)}</div></div>` : "";
  const html = [
    card("🎯","Best finisher",    extreme("avgNorm", +1),      d => rate(d.avgNorm)),
    card("🏆","Best win rate",    extreme("actualWR", +1),     d => pct(d.actualWR)),
    card("🔁","Most played",      extreme("games", +1),        d => `${d.games} games`),
    card("🛡","Steadiest",        extreme("volatility", -1),   d => d.volatility.toFixed(2)),
    card("🎲","Swingiest",        extreme("volatility", +1),   d => d.volatility.toFixed(2)),
  ].filter(Boolean).join("");
  return `<div class="section-head"><h2>Leaders</h2></div><div class="leaders">${html}</div>`;
}

/* shared: list of diverging finish-vs-average bars (items: {label, sub, value}) */
function divergingList(items) {
  const maxAbs = Math.max(1e-9, ...items.map(i => Math.abs(i.value)));
  return items.map(i => {
    const w = Math.abs(i.value) / maxAbs * 50;
    const side = i.value >= 0 ? `left:50%; width:${w}%; background:var(--good)` : `right:50%; width:${w}%; background:var(--bad)`;
    return `<div class="rank-row"><div class="rank-head">
      <span class="rk-name">${i.label}${i.sub ? ` <span style="color:var(--muted);font-size:12px;font-weight:500">${i.sub}</span>` : ""}</span>
      <span class="rk-val ${i.value >= 0 ? "pos" : "neg"}">${rateVs(i.value)}</span></div>
      <div class="bar-track diverge"><span class="bar-axis"></span><span class="bar-fill" style="${side}"></span></div></div>`;
  }).join("");
}

/* seat / turn-order breakdown */
function renderSeatSection() {
  const games = allGames();
  const sb = M.seatBreakdown(games);
  const maxSeat = Math.max(4, ...games.map(g => g.seats.length));
  const items = Array.from({ length: maxSeat }, (_, i) => ({ s: i + 1, ...(sb[i + 1] || { games: 0 }) }))
    .filter(s => s.games)
    .map(s => ({ label: `Seat ${s.s}`, sub: `${s.games} games · ${s.avgPlace.toFixed(1)} avg`, value: s.finishVsAvg }));
  if (!items.length) return "";
  return `<div class="section-head"><h2>By seat · turn order</h2></div><div class="cmp-metric"><div class="rank-list">${divergingList(items)}</div></div>`;
}

/* win rate by *base colour* — a 5-colour deck counts toward all of W U B R G */
function renderColorSection() {
  const items = SF.CI_ORDER.map(col => {
    const gs = allGames().filter(g => deckCI(S.deckById(M.mySeat(g)?.deckId)).includes(col));
    const a = M.aggregateDeck(gs);
    return { col, ...a };
  }).filter(x => x.games)
    .sort((a, b) => (b.finishVsAvg ?? -9) - (a.finishVsAvg ?? -9))
    .map(x => ({ label: `<span class="pips-ci"><span class="ci ${x.col}"></span></span> ${CI_LABEL[x.col]}`, sub: `${x.games} games`, value: x.finishVsAvg }));
  if (items.length < 2) return "";
  return `<div class="section-head"><h2>By colour</h2></div><div class="cmp-metric"><div class="rank-list">${divergingList(items)}</div></div>`;
}

function renderCompare() {
  const has3p = allGames().some(g => g.seats.length === 3);
  if (podFilter === 3 && !has3p) podFilter = 0;   // 3P filter is gone if its last game was removed
  $("#view-compare").innerHTML = renderLeaders() + `
    <div class="section-head"><h2>Compare decks</h2>
      <div class="seg" id="podseg">
        <button data-pod="0" class="${podFilter === 0 ? "on" : ""}">All</button>
        ${has3p ? `<button data-pod="3" class="${podFilter === 3 ? "on" : ""}">3P</button>` : ""}
        <button data-pod="4" class="${podFilter === 4 ? "on" : ""}">4P</button>
        <button data-pod="5" class="${podFilter === 5 ? "on" : ""}">5P</button>
      </div></div>
    ${METRICS.map(metricSection).join("") || '<div class="empty">No games yet</div>'}
    ${renderColorSection()}
    ${renderSeatSection()}`;

  $("#podseg").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    podFilter = +b.dataset.pod; renderCompare();
  });
  $("#view-compare").querySelectorAll(".rank-row[data-deck]").forEach(r =>
    r.addEventListener("click", () => openDeck(r.dataset.deck)));
}

/* ---------- Deck detail ---------- */
const ord = n => n + (["", "st", "nd", "rd", "th", "th", "th"][n] || "th");

function openDeck(deckId) {
  const d = S.deckById(deckId);
  if (!d) return;
  const gs = myGamesForDeck(deckId).sort((a, b) => a.date.localeCompare(b.date));
  const a = M.aggregateDeck(gs);

  const dist = [1, 2, 3, 4, 5].map(p => gs.filter(g => M.placeInfo(g).start === p).length);
  const maxD = Math.max(1, ...dist);
  const bars = dist.map((c, i) => `<div class="bar"><span class="n">${c || ""}</span>
    <div class="fill" style="height:${c / maxD * 100}%; ${c ? "" : "opacity:.25"}"></div>
    <span class="lab">${ord(i + 1)}</span></div>`).join("");

  const games = gs.slice().reverse().map(g => {
    const ms = M.mySeat(g); const pi = M.placeInfo(g);
    const opp = g.seats.filter(s => s.playerId !== "me")
      .map(s => esc((s.playerId ? (S.playerById(s.playerId)?.name + ": ") : "") + seatCards(s))).join(" · ");
    return `<div class="game-item"><div class="top">
      <strong>${euDate(g.date)} · ${g.seats.length}P · seat ${ms.seat ?? "?"}</strong>
      <span class="badge" style="color:${placeColor(pi.start, g.seats.length)}">${pi.start === 1 && !pi.tied ? "1st 🏆" : placeLabel(pi)}</span></div>
      <div class="note">vs ${opp}</div>${g.notes ? `<div class="note">📝 ${esc(g.notes)}</div>` : ""}</div>`;
  }).join("");

  const wrCls = (a.finishVsAvg ?? 0) >= 0 ? "pos" : "neg";
  $("#view-deck").innerHTML = `
    <button class="back" id="deck-back">‹ Back</button>
    ${frameWide(d.art ? `<img class="deck-hero-art" src="${esc(d.art)}" ${artPosOf(d) != null ? `style="object-position:50% ${artPosOf(d)}%"` : ""} alt="" />` : "", deckCI(d), "banner")}
    <div class="section-head" style="margin-top:4px"><div>
      <h2 style="color:var(--text);font-size:18px;text-transform:none;letter-spacing:0">${deckTitle(d)}</h2>
      <div class="theme" style="color:var(--muted);font-size:13px;margin-top:3px">${esc(d.theme)}</div></div></div>
    <div class="tiles" style="margin-top:12px">
      <div class="tile hero"><div class="label">Finish rating</div><div class="value ${wrCls}">${rate(a.avgNorm)}</div>
        <div class="sub">${a.games} games · won ${pct(a.actualWR)}</div></div>
      <div class="tile"><div class="label">Avg place</div><div class="value">${a.avgPlace == null ? "–" : a.avgPlace.toFixed(1)}</div></div>
      <div class="tile"><div class="label">Swinginess</div><div class="value">${a.volatility == null ? "–" : a.volatility.toFixed(2)}</div>${a.volatility == null ? '<div class="sub">Need 2+ games</div>' : ""}</div>
    </div>
    <div class="chart-card"><h3>Placement distribution</h3><div class="dist">${bars}</div></div>
    <div class="section-head"><h2>Games (${gs.length})</h2></div>
    ${games || '<div class="empty">No games logged</div>'}`;
  $("#deck-back").addEventListener("click", () => history.back());
  navForward(() => showView("view-deck"));
}

/* a player's most-played commander (for their Rivals avatar) */
function topCommander(games, playerId) {
  const tally = {};
  for (const g of games) for (const s of g.seats) {
    if (s.playerId !== playerId) continue;
    const key = s.deckId || s.commander; if (!key) continue;
    const d = s.deckId ? S.deckById(s.deckId) : null;
    (tally[key] ??= { name: d?.commander || s.commander, art: d?.art || s.art || null, art2: d?.art2 || s.art2 || null, ci: d?.ci || s.ci || [], n: 0 }).n++;
  }
  const top = Object.values(tally).sort((a, b) => b.n - a.n)[0];
  return top || null;
}

/* ---------- Rivals (head-to-head + bogeys) ---------- */
function renderRivals() {
  const games = allGames();
  const h2h = M.headToHead(games);
  const ids = Object.keys(h2h).sort((a, b) => h2h[b].together - h2h[a].together);

  const cards = ids.map(id => {
    const h = h2h[id]; const name = S.playerById(id)?.name || id;
    const tot = h.together || 1;
    const w = h.iAboveThem, l = h.theyAboveMe, t = h.ties, u = h.unknown;
    const seg = (n, color) => n ? `<span style="width:${n / tot * 100}%;background:${color}"></span>` : "";
    const leg = (color, label, n, always = false) => (n || always) ? `<i><span class="dot" style="background:${color}"></span>${label} ${n}</i>` : "";
    const top = topCommander(games, id);
    return `<div class="h2h" data-rival="${id}">
      <div class="h2h-art">${rowArt(top?.art, top?.ci)}</div>
      <div class="h2h-body">
        <div class="top"><span class="who">${esc(name)} ›</span><span class="rec">${h.together} games</span></div>
        ${top?.name ? `<div class="rec">${esc(shortName(top.name))}</div>` : ""}
        <div class="wld">${seg(w, "var(--good)")}${seg(t, "var(--warn)")}${seg(l, "var(--bad)")}${seg(u, "var(--surface-2)")}</div>
        <div class="legend">${leg("var(--good)", "Beat", w)}${leg("var(--warn)", "Tied", t, true)}${leg("var(--bad)", "Lost", l)}${leg("var(--surface-2)", "Unknown", u)}</div>
      </div></div>`;
  }).join("");

  // bogey decks — opponent decks with at least 2 *recorded* finishes vs me, worst first
  const bog = M.bogeyDecks(games);
  const bogRows = Object.entries(bog)
    .map(([k, b]) => { const d = S.deckById(k); return { name: d?.commander || k, name2: d?.commander2 || null, art: d?.art || null, ci: d?.ci || [], decided: b.aboveMe + b.belowMe, ...b }; })
    .filter(b => b.decided >= 2)
    .sort((a, b) => (b.aboveMe / b.decided) - (a.aboveMe / a.decided) || b.decided - a.decided)
    .map(b => {
      const p = Math.round(b.aboveMe / b.decided * 100);
      const label = esc(shortName(b.name)) + (b.name2 ? ` <span style="color:var(--muted)">+</span> ${esc(shortName(b.name2))}` : "");
      return `<div class="lb-row"><div class="rank">${b.faced}×</div>
        <div style="display:flex;align-items:center;gap:9px;min-width:0">${frameArt(artImg(b.art), b.ci)}<div style="min-width:0"><div class="name">${label}</div><div class="theme">Beat me ${b.aboveMe} of ${b.decided} recorded${b.ties ? ` · ${b.ties} tied` : ""}${b.unknown ? ` · ${b.unknown} not recorded` : ""}</div></div></div>
        <div class="metric ${p >= 50 ? "neg" : "pos"}">${p}%<small>Beat me</small></div></div>`;
    }).join("");

  $("#view-rivals").innerHTML = `
    <div class="section-head"><h2>Head-to-head</h2></div>
    ${cards || '<div class="empty">No games with named players yet.<br>Tag friends when you log a game.</div>'}
    <div class="section-head"><h2>Nemesis decks</h2></div>
    ${bogRows ? `<div class="lb">${bogRows}</div>` : '<div class="empty">Play a few games with finishing order to see which decks beat you.</div>'}`;

  $("#view-rivals").querySelectorAll(".h2h[data-rival]").forEach(c =>
    c.addEventListener("click", () => openRival(c.dataset.rival)));
}

/* ---------- Rival overview (one opponent) — the same overview as the dashboard, for them ---------- */
function openRival(pid) {
  const name = S.playerById(pid)?.name || pid;
  const theirGames = allGames().filter(g => M.seatOf(g, pid));
  const ov = overviewBlock(theirGames, pid, `${esc(name)}'s finish rating`, false);
  $("#view-rival").innerHTML = `<button class="back" id="rival-back">‹ Rivals</button>${ov.html}`;
  $("#rival-back").addEventListener("click", () => history.back());
  wireSpark($("#view-rival"), ov.series);
  navForward(() => showView("view-rival"));
}

/* ---------- Log (fast entry) ---------- */
const today = () => new Date().toISOString().slice(0, 10);
let draft = null;
const blankOpp = () => ({ playerId: "", commander: "", commander2: null, art: null, art2: null, ci: [], second: null, placement: null });
function freshDraft() {
  return { date: today(), deckId: S.myDecks()[0]?.id || "", podSize: 4, mySeat: 1, myPlacement: null,
    opponents: Array.from({ length: 3 }, blankOpp), notes: "" };
}
function syncDraftFromDom() {
  const v = $("#view-log"); if (!v.querySelector("#log-deck")) return;
  draft.date = v.querySelector("#log-date").value;
  draft.deckId = v.querySelector("#log-deck").value;
  draft.notes = v.querySelector("#log-notes").value;
  v.querySelectorAll(".opp-block").forEach((b, i) => {
    draft.opponents[i].playerId = b.querySelector(".opp-player").value;   // commander persisted by its picker
  });
}
function setPodSize(n) {
  syncDraftFromDom();
  draft.podSize = n;
  const need = n - 1;
  while (draft.opponents.length < need) draft.opponents.push(blankOpp());
  draft.opponents.length = need;
  if (draft.mySeat > n) draft.mySeat = n;
  renderLog();
}
function repeatLastPod() {
  syncDraftFromDom();
  const last = allGames().at(-1); if (!last) return toast("No previous pod");
  const opps = last.seats.filter(s => s.playerId !== "me");
  draft.podSize = last.seats.length;
  draft.opponents = opps.map(s => { const d = s.deckId ? S.deckById(s.deckId) : null;
    return { ...blankOpp(), playerId: s.playerId || "", commander: s.commander || d?.commander || "",
      commander2: s.commander2 || d?.commander2 || null, art: s.art || d?.art || null, ci: s.ci || d?.ci || [] }; });
  renderLog();
}

function renderLog() {
  const active = S.getActive();
  if (active) { $("#view-log").innerHTML = renderLiveGame(active); bindLive(); return; }
  renderQuickLog();
}

function renderQuickLog() {
  if (!draft) draft = freshDraft();
  const myDeck = S.deckById(draft.deckId);
  const deckOpts = S.myDecks().map(d => `<option value="${d.id}" ${d.id === draft.deckId ? "selected" : ""}>${esc(d.commander)}</option>`).join("");
  const roster = S.players().filter(p => !p.self);
  const chips = (cur, n, attr) => Array.from({ length: n }, (_, i) =>
    `<div class="chip ${cur === i + 1 ? "on" : ""}" data-${attr}="${i + 1}">${i + 1}</div>`).join("");
  const placeSel = (cur) => `<select class="opp-place">${["<option value=''>Place…</option>",
    ...Array.from({ length: draft.podSize }, (_, i) => `<option value="${i + 1}" ${cur === i + 1 ? "selected" : ""}>${ord(i + 1)}</option>`)].join("")}</select>`;

  const oppBlocks = draft.opponents.map((o, i) => `
    <div class="opp-block part-row" data-i="${i}">
      <div class="part-art">${rowArt(o.art, o.ci, o.art2)}</div>
      <div class="part-body">
        <div class="opp-row">
          <select class="opp-player">
            <option value="">Unknown</option>
            ${roster.map(p => `<option value="${p.id}" ${p.id === o.playerId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
          </select>
          ${placeSel(o.placement)}
        </div>
        <div class="opp-picker" data-i="${i}"></div>
      </div>
    </div>`).join("");

  $("#view-log").innerHTML = `
    <button class="btn-primary" id="start-live" style="margin-bottom:6px">▶ Start a live game</button>
    <p class="hint" style="margin-top:0">Set up the pod now, fill in finishing order at the end.</p>
    <div class="section-head"><h2>Or quick-log a finished game</h2></div>
    <div class="field"><label>Date</label><input id="log-date" type="date" value="${draft.date}" /></div>
    <div class="field"><label>My deck</label>
      <div class="part-row me">
        <div class="part-art" id="my-art">${rowArt(myDeck?.art, myDeck?.ci, myDeck?.art2)}</div>
        <div class="part-body"><select id="log-deck" style="width:100%">${deckOpts}</select></div>
      </div></div>
    <div class="field"><label>Pod size</label><div class="choices" id="pod-choice">
      <div class="chip ${draft.podSize === 3 ? "on" : ""}" data-pod="3">3</div>
      <div class="chip ${draft.podSize === 4 ? "on" : ""}" data-pod="4">4</div>
      <div class="chip ${draft.podSize === 5 ? "on" : ""}" data-pod="5">5</div></div></div>
    <button class="btn-ghost" id="repeat-pod">↻ Repeat last pod</button>
    <div class="field" style="margin-top:15px"><label>My seat (turn order)</label>
      <div class="placement-grid" id="seat-choice">${chips(draft.mySeat, draft.podSize, "seat")}</div></div>
    <div class="field"><label>My placement</label>
      <div class="placement-grid" id="place-choice">${chips(draft.myPlacement, draft.podSize, "place")}</div></div>
    <div class="field"><label>Opponents &amp; their finish</label>${oppBlocks}</div>
    <div class="field"><label>Notes</label><textarea id="log-notes" placeholder="What decided the game?">${esc(draft.notes)}</textarea></div>
    <button class="btn-primary" id="save-game">Save game</button>
    <p class="hint">Pick known friends to unlock head-to-head. Finishing places are optional but power the Rivals tab.</p>`;

  const v = $("#view-log");
  v.querySelector("#start-live").addEventListener("click", startLive);
  v.querySelector("#log-deck").addEventListener("change", e => {
    draft.deckId = e.target.value;
    const d = S.deckById(draft.deckId);
    v.querySelector("#my-art").innerHTML = rowArt(d?.art, d?.ci || [], d?.art2);
  });
  v.querySelector("#pod-choice").addEventListener("click", e => { const c = e.target.closest(".chip"); if (c) setPodSize(+c.dataset.pod); });
  v.querySelector("#repeat-pod").addEventListener("click", repeatLastPod);
  v.querySelector("#seat-choice").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return; draft.mySeat = +c.dataset.seat; v.querySelectorAll("#seat-choice .chip").forEach(x => x.classList.toggle("on", x === c)); });
  v.querySelector("#place-choice").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return; draft.myPlacement = +c.dataset.place; v.querySelectorAll("#place-choice .chip").forEach(x => x.classList.toggle("on", x === c)); });
  v.querySelectorAll(".opp-place").forEach((sel, i) => sel.addEventListener("change", () => draft.opponents[i].placement = sel.value ? +sel.value : null));
  v.querySelectorAll(".opp-picker").forEach(mount => {
    const i = +mount.dataset.i;
    makePicker(mount, draft.opponents[i], upd => {
      Object.assign(draft.opponents[i], { commander: upd.commander, commander2: upd.commander2, art: upd.art, art2: upd.art2, ci: upd.ci, second: upd.second });
      const box = mount.closest(".part-row")?.querySelector(".part-art");   // refresh the big left art live
      if (box) box.innerHTML = rowArt(upd.art, upd.ci, upd.art2);
    }, { pips: false, art: false });
  });
  v.querySelector("#save-game").addEventListener("click", saveGame);
}

function saveGame() {
  syncDraftFromDom();
  if (!draft.deckId) return toast("Pick a deck");
  if (!draft.myPlacement) return toast("Set your placement");
  const seats = [{ playerId: "me", deckId: draft.deckId, seat: draft.mySeat, placement: draft.myPlacement }];
  for (const o of draft.opponents) {
    const cmd = (o.commander || "").trim();
    if (!cmd && !o.playerId) continue;
    const extra = { commander2: o.commander2 || null, art: o.art || null, art2: o.art2 || null, ci: o.ci || [] };
    const deckId = (o.playerId && cmd) ? S.ensureDeck(o.playerId, cmd, extra) : null;
    seats.push({ playerId: o.playerId || null, deckId, commander: cmd || null, commander2: o.commander2 || null, art: o.art || null, ci: o.ci || [], seat: null, placement: o.placement });
  }
  S.addGame({ id: S.newId("g"), date: draft.date, seats, notes: draft.notes.trim() });
  markDirty();
  draft = freshDraft();
  toast("Game saved");
  switchTab("dash");
}

/* ---------- Settings / sync ---------- */
let dirty = false, syncing = false, pushTimer = null;
function updateSyncBadge() {
  const b = $("#sync-btn");
  b.classList.toggle("dirty", dirty && SYNC.isConfigured());
  b.classList.toggle("syncing", syncing);
  b.textContent = syncing ? "⟳" : "☁︎";
}
function markDirty() {
  dirty = true; updateSyncBadge();
  if (!SYNC.isConfigured()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushNow(), 700);   // debounce auto-push
}
async function pushNow() {
  if (!SYNC.isConfigured() || syncing) return;
  syncing = true; updateSyncBadge();
  try { await SYNC.push(S.exportJson()); dirty = false; }
  catch (e) { toast(e.message); }                 // keep dirty so it retries on next trigger
  finally { syncing = false; updateSyncBadge(); }
}

/* union by id; on an id-collision the record from the newer state wins */
function mergeById(winner, loser) {
  const m = new Map();
  for (const x of loser) m.set(x.id, x);
  for (const x of winner) m.set(x.id, x);
  return [...m.values()];
}
function mergeStates(local, remote) {
  const localNewer = (local.updatedAt || "") >= (remote.updatedAt || "");
  const w = localNewer ? local : remote, l = localNewer ? remote : local;
  const deleted = [...new Set([...(local.deleted || []), ...(remote.deleted || [])])];
  const del = new Set(deleted);
  return {
    players: mergeById(w.players || [], l.players || []),
    decks:   mergeById(w.decks   || [], l.decks   || []),
    games:   mergeById(w.games   || [], l.games   || []).filter(g => !del.has(g.id)),  // tombstoned deletes win
    deleted,
    settings: w.settings || l.settings,
  };
}

/* signature of what's worth syncing — game ids, deck ids, and tombstones */
const syncSig = s => JSON.stringify([
  (s.games || []).map(g => g.id).sort(),
  (s.decks || []).map(d => d.id).sort(),
  (s.deleted || []).slice().sort(),
]);

/* pull → MERGE (never drops the other device's games, deletes propagate via tombstones) → push back */
async function syncNow() {
  if (!SYNC.isConfigured()) return;
  syncing = true; updateSyncBadge();
  try {
    const remote = await SYNC.pull();
    let changed = dirty;
    if (remote) {
      const remoteSig = syncSig(remote);
      const beforeIds = allGames().map(g => g.id).sort().join();
      S.replaceAll(mergeStates(S.getState(), remote));
      MIN_GAMES = S.settings().minGames ?? MIN_GAMES;
      if (allGames().map(g => g.id).sort().join() !== beforeIds) switchTab(lastTab);  // re-render if game set changed
      changed = changed || syncSig(S.getState()) !== remoteSig;     // our merged set differs from the gist
    }
    if (changed || !remote) await SYNC.push(S.exportJson());        // push union back; skip if identical → no ping-pong
    dirty = false;
  } catch (e) { toast(e.message); }
  finally { syncing = false; updateSyncBadge(); }
}

function renderSettings() {
  const st = S.settings();
  const sc = SYNC.getConfig();
  const syncCard = sc.hasToken
    ? `<p>Connected${sc.gistId ? ` · gist <code>${esc(sc.gistId.slice(0, 8))}…</code>` : ""}${sc.lastSync ? ` · last sync ${relDate(sc.lastSync.slice(0, 10))}` : ""}.</p>
       <div class="row-actions"><button class="btn-ghost" id="sync-now" style="margin-top:0">Sync now</button>
         <button class="btn-ghost" id="sync-disconnect" style="margin-top:0;color:var(--bad)">Disconnect</button></div>`
    : `<p>Sync across phone &amp; laptop via a private gist. Create a <b>fine-grained token</b> with only the <b>Gist</b> permission, paste it below. The same token finds your data on any device.</p>
       <input id="gist-token" type="password" placeholder="github_pat_… or ghp_…" autocomplete="off" />
       <button class="btn-primary" id="sync-connect" style="margin-top:8px">Connect</button>`;

  $("#view-settings").innerHTML = `
    <button class="back" id="set-back">‹ Back</button>
    <div class="section-head" style="margin-top:4px"><h2 style="color:var(--text);text-transform:none;font-size:18px">Settings</h2></div>
    <div class="set-card"><h3>My decks</h3>
      <p>Add, rename or remove the commanders you play.</p>
      <button class="btn-ghost" id="manage-decks" style="margin-top:0">Manage decks</button></div>
    <div class="set-card"><h3>Cloud sync (GitHub Gist)</h3>${syncCard}</div>
    <div class="set-card"><h3>Confidence threshold</h3>
      <p>Decks with fewer than this many games are flagged as too-noisy-to-trust.</p>
      <div class="placement-grid" id="min-choice">${[1,2,3,5,8].map(n => `<div class="chip ${st.minGames===n?"on":""}" data-min="${n}">${n}</div>`).join("")}</div></div>
    <div class="set-card"><h3>Backup</h3>
      <p>Your data lives in this browser. Export a JSON copy, or import one to restore / move devices.</p>
      <div class="row-actions"><button class="btn-ghost" id="export-btn">Export</button><button class="btn-ghost" id="import-btn">Import</button></div>
      <textarea id="io-box" placeholder="Paste JSON here to import…" style="margin-top:10px;min-height:90px"></textarea></div>
    <p class="hint" id="app-version" style="text-align:center"></p>`;
  const v = $("#view-settings");
  // shell version, asked from the controlling service worker — shows which deploy this device runs
  const swc = navigator.serviceWorker?.controller;
  if (swc) {
    const ch = new MessageChannel();
    ch.port1.onmessage = e => { v.querySelector("#app-version").textContent = `App shell ${e.data}`; };
    swc.postMessage("version", [ch.port2]);
  }
  v.querySelector("#set-back").addEventListener("click", () => history.back());
  v.querySelector("#min-choice").addEventListener("click", e => {
    const c = e.target.closest(".chip"); if (!c) return;
    MIN_GAMES = +c.dataset.min; S.setSetting("minGames", MIN_GAMES); markDirty(); renderSettings();
  });
  v.querySelector("#manage-decks").addEventListener("click", openDecks);
  v.querySelector("#export-btn").addEventListener("click", () => { v.querySelector("#io-box").value = S.exportJson(); toast("Exported below"); });
  v.querySelector("#import-btn").addEventListener("click", () => {
    try { S.importJson(v.querySelector("#io-box").value); MIN_GAMES = S.settings().minGames ?? MIN_GAMES; markDirty(); toast("Imported"); switchTab("dash"); }
    catch { toast("Invalid JSON"); }
  });
  v.querySelector("#sync-connect")?.addEventListener("click", async () => {
    const tok = v.querySelector("#gist-token").value.trim();
    if (!tok) return toast("Paste a token");
    SYNC.setToken(tok); syncing = true; updateSyncBadge();
    try { await SYNC.connect(S.exportJson()); await syncNow(); toast("Connected"); renderSettings(); }
    catch (e) { SYNC.disconnect(); toast(e.message); }
    finally { syncing = false; updateSyncBadge(); }
  });
  v.querySelector("#sync-now")?.addEventListener("click", async () => { await syncNow(); toast("Synced"); renderSettings(); });
  v.querySelector("#sync-disconnect")?.addEventListener("click", () => { SYNC.disconnect(); dirty = false; updateSyncBadge(); toast("Disconnected"); renderSettings(); });
}

/* ---------- nav ---------- */
let lastTab = "dash";
const VIEW = { dash: "view-dash", compare: "view-compare", rivals: "view-rivals", history: "view-history", log: "view-log", settings: "view-settings" };
function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === id));
  window.scrollTo(0, 0);   // a new view always starts at the top, not the previous tab's scroll
}
function switchTab(tab) {
  document.querySelectorAll("nav.tabbar button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  if (VIEW[tab]) showView(VIEW[tab]);
  lastTab = tab;
  if (tab === "dash") renderDash();
  if (tab === "compare") renderCompare();
  if (tab === "rivals") renderRivals();
  if (tab === "history") renderHistory();
  if (tab === "log") renderLog();
  if (tab === "settings") renderSettings();
}

/* ---------- hardware Back button (Android / iOS standalone PWA) ----------
   Each forward navigation pushes a history entry and remembers how to restore the
   screen we left. The phone's Back button — and our own ‹ Back buttons, which just
   call history.back() — fire popstate, which pops one entry and restores it. So Back
   walks back through screens instead of closing the app. At the root stack it exits. */
const navStack = [];
let navLock = false;   // true while restoring, so a restore doesn't re-push

function snapshotScreen() {
  const viewId = document.querySelector(".view.active")?.id;
  const tab = lastTab, isTab = VIEW[tab] === viewId;
  return () => {   // restore this exact screen
    navLock = true;
    if (isTab) switchTab(tab);   // re-render the tab fresh (data may have changed)
    else {                       // detail view: its content still lives in the DOM
      document.querySelectorAll("nav.tabbar button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
      showView(viewId);
    }
    navLock = false;
  };
}
function navForward(apply) {   // wrap any navigation that opens a new screen
  if (navLock) return apply();
  navStack.push(snapshotScreen());
  history.pushState({ d: navStack.length }, "");
  apply();
}
window.addEventListener("popstate", () => {
  const restore = navStack.pop();
  if (restore) restore();   // empty stack → browser exits the app (correct at the root)
});

document.querySelector("nav.tabbar").addEventListener("click", e => {
  const b = e.target.closest("button"); if (b) navForward(() => switchTab(b.dataset.tab));
});
$("#sync-btn").addEventListener("click", () => navForward(() => { renderSettings(); showView("view-settings"); }));

/* flush a pending push when the app is backgrounded/closed (mobile freezes JS on lock, so the
   debounced push otherwise never fires). We deliberately do NOT auto-pull on focus or on a timer —
   remote data is only pulled on a real page refresh (see init), so the view never reloads under you. */
document.addEventListener("visibilitychange", () => {
  if (document.hidden && SYNC.isConfigured() && dirty) pushNow();
});
window.addEventListener("pagehide", () => { if (SYNC.isConfigured() && dirty) pushNow(); });

/* ---------- boot ---------- */
(async function init() {
  await S.load();
  MIN_GAMES = S.settings().minGames ?? 2;
  renderDash();
  updateSyncBadge();
  if (SYNC.isConfigured()) syncNow();   // pull newer data from other devices, non-blocking
})();

/* ---------- Live (active) game ---------- */
const uid = () => "p_" + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
const saveActive = g => { S.setActive(g); };

function startLive() {
  const myDeck = S.myDecks()[0];
  saveActive({ status: "setup", date: today(), notes: "",
    participants: [{ uid: uid(), playerId: "me", name: "Me", commander: myDeck?.commander || "", deckId: myDeck?.id || "" }] });
  renderLog();
}
function liveAdd(playerId) {
  const g = S.getActive();
  const p = playerId ? S.playerById(playerId) : null;
  g.participants.push({ uid: uid(), playerId: playerId || null, name: p ? p.name : "Guest", commander: "", commander2: null, art: null, art2: null, ci: [], second: null, deckId: null });
  saveActive(g); renderLog();
}
function liveRemove(u) { const g = S.getActive(); g.participants = g.participants.filter(p => p.uid !== u); saveActive(g); renderLog(); }

/* pointer-based drag reordering (works on touch + mouse, no library).
   With onCombine, hovering the middle of another row targets a tie-combine (highlighted)
   instead of reordering; the top/bottom thirds of each row still reorder as before. */
function makeSortable(list, onReorder, onCombine = null) {
  if (!list) return;
  let drag = null, target = null;
  const clearTarget = () => { target?.classList.remove("tie-target"); target = null; };
  const onMove = e => {
    if (!drag) return;
    e.preventDefault();
    const others = [...list.querySelectorAll(".part-row:not(.dragging)")];
    if (onCombine) {
      const over = others.find(r => { const b = r.getBoundingClientRect(); return e.clientY > b.top + b.height * 0.35 && e.clientY < b.top + b.height * 0.65; });
      if (over !== target) { clearTarget(); if (over) { target = over; target.classList.add("tie-target"); } }
      if (target) return;   // hovering a combine target — freeze reordering under it
    }
    const after = others.find(r => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
    if (after) list.insertBefore(drag, after); else list.appendChild(drag);
  };
  const onUp = () => {
    if (!drag) return;
    drag.classList.remove("dragging");
    const dragUid = drag.dataset.uid, targetUid = target?.dataset.uid;
    clearTarget();
    const order = [...list.querySelectorAll(".part-row")].map(r => r.dataset.uid);
    drag = null;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    if (targetUid != null) onCombine(dragUid, targetUid); else onReorder(order);
  };
  list.querySelectorAll(".part-drag").forEach(handle => handle.addEventListener("pointerdown", e => {
    e.preventDefault();
    drag = handle.closest(".part-row");
    drag.classList.add("dragging");
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
  }));
}
/* Ties on the finishing-order screen: participants sharing a tieUid in *adjacent* rows form
   a tie group. Anyone whose run shrinks to one row (dragged out, or a row dropped in between)
   loses the mark — so "drag away to split" needs no special handling. */
function normalizeTies(g) {
  const runs = [];
  g.participants.forEach((p, i) => {
    const prev = g.participants[i - 1];
    if (i && p.tieUid && p.tieUid === prev.tieUid) runs.at(-1).push(p);
    else runs.push([p]);
  });
  for (const r of runs) if (r.length === 1) r[0].tieUid = null;
}

/* index of the first row of each participant's tie group -> placement = that index + 1
   (competition style: two tied after 1st are both 2nd, the next player is 4th) */
function tieStarts(participants) {
  const starts = [];
  participants.forEach((p, i) => {
    const prev = participants[i - 1];
    starts[i] = (i && p.tieUid && p.tieUid === prev.tieUid) ? starts[i - 1] : i;
  });
  return starts;
}

function liveCombine(dragUid, targetUid) {
  liveSyncDom();
  const g = S.getActive();
  const d = g.participants.find(p => p.uid === dragUid);
  const t = g.participants.find(p => p.uid === targetUid);
  if (!d || !t || d === t) return;
  if (d.tieUid != null && d.tieUid === t.tieUid) {   // dropped onto their own tie partner -> toggle off
    d.tieUid = null;                                 // (a bottom tie group can't be split by dragging away)
    normalizeTies(g);
    saveActive(g); renderLog();
    return;
  }
  t.tieUid ??= t.uid;
  d.tieUid = t.tieUid;
  // park the dragged player right below the target's group so the run is adjacent
  g.participants = g.participants.filter(p => p !== d);
  const last = g.participants.reduce((acc, p, i) => (p.tieUid === t.tieUid ? i : acc), -1);
  g.participants.splice(last + 1, 0, d);
  normalizeTies(g);
  saveActive(g); renderLog();
}

function liveSyncDom() {
  const g = S.getActive(); if (!g) return;
  const v = $("#view-log");
  if (v.querySelector("#live-date")) g.date = v.querySelector("#live-date").value;
  if (v.querySelector("#live-notes")) g.notes = v.querySelector("#live-notes").value;
  v.querySelectorAll(".part-row").forEach(row => {
    const p = g.participants.find(x => x.uid === row.dataset.uid); if (!p) return;
    const dk = row.querySelector(".part-deck"); if (dk) { p.deckId = dk.value; p.commander = S.deckById(dk.value)?.commander || p.commander; }
  });
  saveActive(g);   // opponent commanders are persisted by their picker's onChange
}
function liveToFinish() {
  liveSyncDom();
  const g = S.getActive();
  const opps = g.participants.filter(p => p.playerId !== "me");
  const empty = opps.filter(p => !(p.commander || "").trim());
  if (empty.length) return toast(`Add a commander for ${empty.map(p => p.name).join(", ")}`);
  // typed but never matched to a real card (no art / no colour identity)
  const unmatched = opps.filter(p => !p.art && !(p.ci || []).length);
  if (unmatched.length && !confirm(`Not matched to a card: ${unmatched.map(p => p.commander).join(", ")}.\nPick from the suggestions for stats to line up. Continue anyway?`)) return;
  g.participants.forEach((p, i) => { p.turn = i + 1; p.tieUid = null; });   // freeze turn order; ties are set on the finish screen
  g.status = "finish"; saveActive(g); renderLog();
}
function liveBackToSetup() { liveSyncDom(); const g = S.getActive(); g.participants.sort((a, b) => a.turn - b.turn); g.status = "setup"; saveActive(g); renderLog(); }
function liveCancel() { if (confirm("Discard this live game?")) { S.clearActive(); renderLog(); } }

function liveSave() {
  liveSyncDom();
  const g = S.getActive();
  const me = g.participants.find(p => p.playerId === "me");
  if (!me?.deckId) return toast("Pick your deck");
  const starts = tieStarts(g.participants);
  const seats = g.participants.map((p, i) => {
    if (p.playerId === "me") return { playerId: "me", deckId: p.deckId, seat: p.turn ?? null, placement: starts[i] + 1 };
    const cmd = (p.commander || "").trim();
    const extra = { commander2: p.commander2 || null, art: p.art || null, art2: p.art2 || null, ci: p.ci || [] };
    const deckId = (p.playerId && cmd) ? S.ensureDeck(p.playerId, cmd, extra) : null;
    return { playerId: p.playerId || null, deckId, commander: cmd || null, commander2: p.commander2 || null, art: p.art || null, ci: p.ci || [], seat: p.turn ?? null, placement: starts[i] + 1 };
  });
  S.addGame({ id: S.newId("g"), date: g.date, seats, notes: (g.notes || "").trim() });
  S.clearActive(); markDirty(); toast("Game saved"); switchTab("dash");
}

function renderLiveGame(g) {
  const setup = g.status === "setup";
  const addable = S.players().filter(p => !p.self && !g.participants.some(x => x.playerId === p.id));
  const myDeckOpts = S.myDecks().map(d => `<option value="${d.id}">${esc(d.commander)}</option>`).join("");

  const starts = tieStarts(g.participants);
  const rows = g.participants.map((p, i) => {
    const isMe = p.playerId === "me";
    const tied = !setup && (starts[i] !== i || starts[i + 1] === i);   // in a group of 2+ (continuation, or head with a follower)
    const lead = setup ? `${i + 1}.` : (tied ? "T‑" : "") + ord(starts[i] + 1);   // U+2011: keep "T‑2nd" on one line
    const myDeck = isMe ? S.deckById(p.deckId) : null;
    const art = isMe ? myDeck?.art : p.art;
    const art2 = isMe ? (myDeck?.art2 || null) : (p.art2 || null);
    const ci = isMe ? (myDeck?.ci || []) : (p.ci || []);
    let cmdField;
    if (isMe) {
      cmdField = setup
        ? `<select class="part-deck" style="width:100%">${myDeckOpts.replace(`value="${p.deckId}"`, `value="${p.deckId}" selected`)}</select>`
        : `<div class="part-static">${esc(myDeck?.commander || "—")}</div>`;
    } else {
      cmdField = setup
        ? `<div class="part-picker" data-uid="${p.uid}"></div>`
        : `<div class="part-static">${esc(p.commander || "—")}${p.commander2 ? ` <span style="color:var(--muted)">+</span> ${esc(p.commander2)}` : ""}</div>`;
    }
    const rm = !setup ? "" : (isMe ? `<span class="part-rm-spacer"></span>` : `<button class="part-rm" data-rm="${p.uid}">✕</button>`);
    const name = `<div class="part-name"><span class="lead">${lead}</span>${esc(p.name)}${setup ? "" : ` <span class="sub">· Turn ${p.turn}</span>`}</div>`;
    return `<div class="part-row ${isMe ? "me" : ""} ${tied ? "tied" : ""} ${tied && starts[i] !== i ? "tied-cont" : ""}" data-uid="${p.uid}">
      <div class="part-art">${rowArt(art, ci, art2)}</div>
      <div class="part-body">${name}${cmdField}</div>
      <span class="part-drag" title="Drag to reorder">⠿</span>${rm}</div>`;
  }).join("");

  const addBtns = setup ? `<div class="add-players">
    ${addable.map(p => `<button class="chip-add" data-add="${p.id}">+ ${esc(p.name)}</button>`).join("")}
    <button class="chip-add" data-add="">+ Guest</button></div>` : "";

  return `
    <div class="live-head"><h2>${setup ? "Live game · setup" : "Finishing order"}</h2>
      <button class="back" id="live-cancel">Discard</button></div>
    ${setup ? `<div class="field" style="margin-top:10px"><label>Date</label><input id="live-date" type="date" value="${g.date}" /></div>` : ""}
    <div class="part-list">${rows}</div>
    ${addBtns}
    ${setup
      ? `<button class="btn-primary" id="live-finish" style="margin-top:16px">Finish game →</button>`
      : `<div class="field" style="margin-top:14px"><label>Notes</label><textarea id="live-notes" placeholder="What decided the game?">${esc(g.notes || "")}</textarea></div>
         <div class="row-actions"><button class="btn-ghost" id="live-back">‹ Back to setup</button><button class="btn-primary" id="live-save" style="margin-top:0">Save result</button></div>`}`;
}

function bindLive() {
  const v = $("#view-log");
  v.querySelector("#live-cancel")?.addEventListener("click", liveCancel);
  v.querySelector("#live-finish")?.addEventListener("click", liveToFinish);
  v.querySelector("#live-back")?.addEventListener("click", liveBackToSetup);
  v.querySelector("#live-save")?.addEventListener("click", liveSave);
  v.querySelectorAll(".add-players .chip-add").forEach(b => b.addEventListener("click", () => { liveSyncDom(); liveAdd(b.dataset.add); }));
  v.querySelectorAll("[data-rm]").forEach(b => b.addEventListener("click", () => { liveSyncDom(); liveRemove(b.dataset.rm); }));
  makeSortable(v.querySelector(".part-list"), order => {
    liveSyncDom();
    const g = S.getActive();
    g.participants.sort((a, b) => order.indexOf(a.uid) - order.indexOf(b.uid));
    normalizeTies(g);   // a reorder that splits a tie group dissolves the tie
    saveActive(g); renderLog();
  }, S.getActive()?.status === "finish" ? liveCombine : null);
  // mount a Scryfall picker per opponent; it persists straight to the active game
  v.querySelectorAll(".part-picker").forEach(mount => {
    const uid = mount.dataset.uid;
    const p = S.getActive().participants.find(x => x.uid === uid);
    makePicker(mount, p, upd => {
      const g = S.getActive(); const pp = g.participants.find(x => x.uid === uid); if (!pp) return;
      Object.assign(pp, { commander: upd.commander, commander2: upd.commander2, art: upd.art, art2: upd.art2, ci: upd.ci, second: upd.second });
      saveActive(g);
      const box = mount.closest(".part-row")?.querySelector(".part-art");   // refresh the big left art live
      if (box) box.innerHTML = rowArt(upd.art, upd.ci, upd.art2);
    }, { pips: false, art: false });
  });
  v.querySelectorAll("#live-notes, #live-date").forEach(el => el.addEventListener("change", liveSyncDom));
  v.querySelector(".part-deck")?.addEventListener("change", () => { liveSyncDom(); renderLog(); });  // refresh my art
}

/* ---------- History (all games) + edit/delete ---------- */
function gameSummary(g) {
  const ms = M.mySeat(g);
  const myDeck = S.deckById(ms?.deckId)?.commander || "—";
  const opp = g.seats.filter(s => s.playerId !== "me")
    .map(s => (s.playerId ? S.playerById(s.playerId)?.name : null) || shortName(seatCards(s))).join(", ");
  return { ms, myDeck, opp };
}

function renderHistory() {
  const games = allGames().slice().sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const rows = games.map(g => {
    const { ms, myDeck, opp } = gameSummary(g);
    const badge = ms?.placement ? (pi => `<span class="badge" style="color:${placeColor(pi.start, g.seats.length)}">${placeLabel(pi)}</span>`)(M.placeInfo(g)) : "";
    return `<div class="game-item tap" data-game="${g.id}"><div class="top">
      <strong>${euDate(g.date)} · ${esc(myDeck)}</strong>${badge}</div>
      <div class="note">${g.seats.length}P · vs ${esc(opp)}</div></div>`;
  }).join("");
  $("#view-history").innerHTML = `
    <div class="section-head"><h2>All games (${games.length})</h2></div>
    ${rows || '<div class="empty">No games logged yet</div>'}`;
  $("#view-history").querySelectorAll("[data-game]").forEach(r =>
    r.addEventListener("click", () => openEdit(r.dataset.game)));
}

let editDraft = null;
function openEdit(gameId) {
  const g = allGames().find(x => x.id === gameId); if (!g) return;
  editDraft = JSON.parse(JSON.stringify(g));
  renderEdit();
  navForward(() => showView("view-edit"));
}
let editPickers = {};
function renderEdit() {
  const g = editDraft;
  const n = g.seats.length;
  editPickers = {};
  const roster = S.players().filter(p => !p.self);
  const myDeckOpts = S.myDecks().map(d => `<option value="${d.id}">${esc(d.commander)}</option>`).join("");
  const numSel = (cls, cur, label) => `<select class="${cls}"><option value="">${label}</option>${Array.from({ length: n }, (_, i) =>
    `<option value="${i + 1}" ${cur === i + 1 ? "selected" : ""}>${i + 1}</option>`).join("")}</select>`;

  const seatRows = g.seats.map((s, i) => {
    const isMe = s.playerId === "me";
    const myDeck = isMe ? S.deckById(s.deckId) : null;
    const oppDeck = !isMe && s.deckId ? S.deckById(s.deckId) : null;
    const art = isMe ? myDeck?.art : (s.art || oppDeck?.art);
    const art2 = isMe ? (myDeck?.art2 || null) : (s.art2 || oppDeck?.art2 || null);
    const ci = isMe ? (myDeck?.ci || []) : (s.ci || oppDeck?.ci || []);
    const who = isMe
      ? `<div class="part-name">Me</div><select class="ed-deck" style="width:100%">${myDeckOpts.replace(`value="${s.deckId}"`, `value="${s.deckId}" selected`)}</select>`
      : `<select class="ed-player"><option value="">Guest</option>${roster.map(p => `<option value="${p.id}" ${p.id === s.playerId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
         <div class="ed-picker" data-i="${i}"></div>`;
    return `<div class="part-row ${isMe ? "me" : ""}" data-i="${i}">
      <div class="part-art">${rowArt(art, ci, art2)}</div>
      <div class="part-body">${who}</div>
      <div class="ed-nums"><label><span class="lbl">Place</span>${numSel("ed-place", s.placement, "?")}</label><label><span class="lbl">Turn</span>${numSel("ed-turn", s.seat, "?")}</label></div>
    </div>`;
  }).join("");

  $("#view-edit").innerHTML = `
    <div class="live-head"><h2>Edit game</h2><button class="back" id="edit-close">‹ Back</button></div>
    <div class="field"><label>Date</label><input id="ed-date" type="date" value="${g.date}" /></div>
    <div class="part-list">${seatRows}</div>
    <div class="field" style="margin-top:14px"><label>Notes</label><textarea id="ed-notes" placeholder="Notes">${esc(g.notes || "")}</textarea></div>
    <div class="row-actions"><button class="btn-ghost" id="edit-delete" style="color:var(--bad)">Delete game</button><button class="btn-primary" id="edit-save" style="margin-top:0">Save changes</button></div>`;

  const v = $("#view-edit");
  v.querySelectorAll(".ed-picker").forEach(mount => {
    const i = +mount.dataset.i; const s = g.seats[i]; const d = s.deckId ? S.deckById(s.deckId) : null;
    editPickers[i] = makePicker(mount, { commander: s.commander || d?.commander || "", commander2: s.commander2 || d?.commander2 || null, art: s.art || d?.art || null, art2: s.art2 || d?.art2 || null, ci: s.ci || d?.ci || [] }, upd => {
      const box = mount.closest(".part-row")?.querySelector(".part-art");   // refresh the big left art live
      if (box) box.innerHTML = rowArt(upd.art, upd.ci, upd.art2);
    }, { pips: false, art: false });
  });
  v.querySelector(".ed-deck")?.addEventListener("change", e => {
    const d = S.deckById(e.target.value);
    e.target.closest(".part-row").querySelector(".part-art").innerHTML = rowArt(d?.art, d?.ci || [], d?.art2);
  });
  v.querySelector("#edit-close").addEventListener("click", () => history.back());
  v.querySelector("#edit-save").addEventListener("click", saveEdit);
  v.querySelector("#edit-delete").addEventListener("click", () => {
    if (confirm("Delete this game permanently?")) { S.deleteGame(g.id); markDirty(); toast("Deleted"); switchTab("history"); }
  });
}
function saveEdit() {
  const v = $("#view-edit");
  const g = editDraft;
  g.date = v.querySelector("#ed-date").value;
  g.notes = v.querySelector("#ed-notes").value.trim();
  v.querySelectorAll(".part-row").forEach(row => {
    const i = +row.dataset.i; const s = g.seats[i];
    s.placement = row.querySelector(".ed-place").value ? +row.querySelector(".ed-place").value : null;
    s.seat = row.querySelector(".ed-turn").value ? +row.querySelector(".ed-turn").value : null;
    if (s.playerId === "me") { s.deckId = row.querySelector(".ed-deck").value; return; }
    const pid = row.querySelector(".ed-player").value || null;
    const val = editPickers[i]?.getValue() || {};
    const cmd = (val.commander || "").trim();
    s.playerId = pid;
    s.commander = cmd || null; s.commander2 = val.commander2 || null; s.art = val.art || null; s.ci = val.ci || [];
    s.deckId = (pid && cmd) ? S.ensureDeck(pid, cmd, { commander2: s.commander2, art: s.art, art2: val.art2 || null, ci: s.ci }) : null;
  });
  S.updateGame(g.id, { date: g.date, notes: g.notes, seats: g.seats });
  markDirty(); toast("Saved"); switchTab("history");
}

/* ---------- Deck manager (my decks: add / rename / delete) ---------- */
let editingDeck = null;     // deck id currently being edited, or "new"
let deckPicker = null;      // active picker instance while editing
function renderDecks() {
  const decks = S.myDecks();
  const rows = decks.map(d => {
    const n = S.gamesForDeck(d.id).length;
    if (editingDeck === d.id) return `<div data-editrow="${d.id}">${deckEditShell(d)}</div>`;
    return `<div class="deck-row" data-deck="${d.id}">
      ${artCI(d, "art", artPosOf(d))}
      <div class="deck-info"><div class="name">${deckTitle(d)}</div><div class="theme">${esc(d.theme || "—")} · ${n} games</div></div>
      <div class="deck-acts"><button class="icon-btn" data-edit="${d.id}">✎</button>
        <button class="icon-btn" data-del="${d.id}" ${n ? "disabled title='Has games — cannot delete'" : ""}>🗑</button></div>
    </div>`;
  }).join("");

  $("#view-decks").innerHTML = `
    <button class="back" id="decks-back">‹ Back</button>
    <div class="section-head" style="margin-top:4px"><h2 style="color:var(--text);text-transform:none;font-size:18px">My decks</h2></div>
    ${editingDeck === "new" ? deckEditShell(null) : '<button class="btn-primary" id="deck-add">+ Add deck</button>'}
    <div class="deck-list" style="margin-top:14px">${rows}</div>`;

  const v = $("#view-decks");
  // mount the Scryfall picker into the edit shell, if editing
  const mount = v.querySelector(".deck-picker-mount");
  if (mount) {
    const d = editingDeck === "new" ? null : S.deckById(editingDeck);
    editArtPos = d?.artPos ?? 28;
    deckPicker = makePicker(mount, d || {}, val => renderArtTune(val.art));
    renderArtTune(deckPicker.getValue().art);
  }
  v.querySelector("#decks-back").addEventListener("click", () => history.back());
  v.querySelector("#deck-add")?.addEventListener("click", () => { editingDeck = "new"; renderDecks(); });
  v.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => { editingDeck = b.dataset.edit; renderDecks(); }));
  v.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    if (b.disabled) return;
    if (confirm("Delete this deck?")) { S.deleteDeck(b.dataset.del); markDirty(); renderDecks(); }
  }));
  v.querySelector("#deck-save")?.addEventListener("click", saveDeckEdit);
  v.querySelector("#deck-cancel")?.addEventListener("click", () => { editingDeck = null; deckPicker = null; renderDecks(); });
}
function deckEditShell(d) {
  return `<div class="deck-edit">
    <div class="deck-picker-mount"></div>
    <div class="art-tune" id="art-tune"></div>
    <input id="deck-theme" type="text" placeholder="Theme / archetype (optional)" value="${esc(d?.theme || "")}" />
    <div class="row-actions"><button class="btn-ghost" id="deck-cancel" style="margin-top:0">Cancel</button>
      <button class="btn-primary" id="deck-save" style="margin-top:0">Save</button></div></div>`;
}
let editArtPos = 28;
function renderArtTune(art) {
  const el = $("#art-tune"); if (!el) return;
  if (!art) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="tune-label">Art position — drag to centre the banner</div>
    <img class="tune-preview" src="${esc(art)}" style="object-position:50% ${editArtPos}%" alt="" />
    <input type="range" id="art-range" class="tune-range" min="0" max="100" value="${editArtPos}" />`;
  const range = el.querySelector("#art-range"); const prev = el.querySelector(".tune-preview");
  range.addEventListener("input", () => { editArtPos = +range.value; prev.style.objectPosition = `50% ${editArtPos}%`; });
}
function saveDeckEdit() {
  const val = deckPicker?.getValue() || {};
  const cmd = (val.commander || "").trim();
  const theme = $("#deck-theme").value.trim();
  if (!cmd) return toast("Commander name required");
  const fields = { commander: cmd, commander2: val.commander2 || null, art: val.art || null, art2: val.art2 || null, ci: val.ci || [], theme, artPos: editArtPos };
  if (editingDeck === "new") {
    const id = "d_" + cmd.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) + "_" + S.decks().length;
    S.addDeck({ id, ownerId: "me", ...fields });
  } else {
    S.updateDeck(editingDeck, fields);
  }
  markDirty(); editingDeck = null; deckPicker = null; renderDecks();
}
function openDecks() {
  editingDeck = null; renderDecks(); navForward(() => showView("view-decks"));
}

/* ---------- commander picker (Scryfall autocomplete + partner/background) ---------- */
let pickerSeq = 0;
const SECOND_LABEL = { partner:"Partner", partnerWith:"Partner with", background:"Background", friends:"Friends forever", companion:"Doctor", doctor:"Companion" };

function makePicker(mount, initial = {}, onChange = () => {}, opts = {}) {
  const showPips = opts.pips !== false;
  const showArt = opts.art !== false;   // false when the art is shown elsewhere (e.g. big row art)
  const v = {
    commander: initial.commander || "", commander2: initial.commander2 || null,
    art: initial.art || null, art2: initial.art2 || null, ci: (initial.ci || []).slice(),
    baseCi: (initial.ci || []).slice(), ci2: [], second: initial.second || null,
  };
  const id = "pk" + (++pickerSeq);
  let tPrim, tSec;

  mount.innerHTML = `
    <div class="ac-wrap">
      <div class="primary-head" style="display:flex;align-items:center;gap:8px">
        <input class="primary-input" type="text" placeholder="Commander…" value="${esc(v.commander)}" autocomplete="off" style="flex:1" />
        ${showArt ? `<span class="art-slot">${frameArt(artImg(v.art, "art field"), v.ci, "field")}</span>` : ""}
        ${showPips ? `<span class="pips-slot">${ciPips(v.ci)}</span>` : ""}
      </div>
      <div class="ac-list primary-list" hidden></div>
    </div>
    <div class="second-slot"></div>`;

  const primary = mount.querySelector(".primary-input");
  const primaryList = mount.querySelector(".primary-list");
  const artSlot = mount.querySelector(".art-slot");
  const pipsSlot = mount.querySelector(".pips-slot");
  const secondSlot = mount.querySelector(".second-slot");

  const emit = () => onChange({ ...v, ci: v.ci.slice() });
  // re-frame the primary art with the current merged CI (ring replaces the old inline pips)
  const renderArtSlot = () => { if (artSlot) artSlot.innerHTML = v.art ? frameArt(artImg(v.art, "art field"), v.ci, "field") : ""; };
  const refreshPips = () => { v.ci = SF.mergeCI(v.baseCi, v.ci2); if (pipsSlot) pipsSlot.innerHTML = ciPips(v.ci); renderArtSlot(); };

  function renderList(el, names, onPick) {
    if (!names.length) { el.hidden = true; el.innerHTML = ""; return; }
    el.innerHTML = names.map(n => `<div class="ac-item" data-name="${esc(n)}">${esc(n)}</div>`).join("");
    el.hidden = false;
    el.querySelectorAll(".ac-item").forEach(it => it.addEventListener("mousedown", e => {
      e.preventDefault(); el.hidden = true; onPick(it.dataset.name);
    }));
  }

  async function pickPrimary(name) {
    primary.value = name; v.commander = name; primaryList.hidden = true;
    const c = await SF.getCard(name);
    if (c) { v.art = c.art; v.baseCi = c.ci; v.second = c.second; }
    if (!v.second) { v.commander2 = null; v.art2 = null; v.ci2 = []; }   // new primary can't pair → drop any old partner
    refreshPips(); renderSecond(); emit();   // refreshPips re-frames the art slot
  }
  async function pickSecond(name) {
    v.commander2 = name;
    const c = await SF.getCard(name);
    v.art2 = c?.art || null; v.ci2 = c?.ci || [];
    refreshPips(); renderSecond(); emit();
  }

  function renderSecond() {
    if (!v.second) { secondSlot.innerHTML = ""; return; }   // keep commander2 — primary just hasn't resolved yet
    if (v.second.type === "partnerWith" && !v.commander2) { pickSecond(v.second.name); return; }
    secondSlot.innerHTML = `
      <div class="second-pick"><div class="second-label">${SECOND_LABEL[v.second.type] || "Second"}</div>
        <div class="ac-wrap" style="display:flex;align-items:center;gap:8px">
          <input class="second-input" type="text" placeholder="${SECOND_LABEL[v.second.type] || "Second card"}…" value="${esc(v.commander2 || "")}" autocomplete="off" style="flex:1" />
          ${showArt ? `<span class="art-slot2">${frameArt(artImg(v.art2, "art field"), v.ci2, "field")}</span>` : ""}
          <div class="ac-list second-list" hidden></div>
        </div></div>`;
    const sec = secondSlot.querySelector(".second-input");
    const secList = secondSlot.querySelector(".second-list");
    sec.addEventListener("input", () => {
      v.commander2 = sec.value || null; emit();
      clearTimeout(tSec); tSec = setTimeout(async () => renderList(secList, await SF.searchSecond(sec.value, v.second), pickSecond), 250);
    });
    sec.addEventListener("blur", () => setTimeout(() => secList.hidden = true, 150));
  }

  primary.addEventListener("input", () => {
    v.commander = primary.value; v.art = null; if (artSlot) artSlot.innerHTML = ""; emit();
    clearTimeout(tPrim); tPrim = setTimeout(async () => renderList(primaryList, await SF.commanderAutocomplete(primary.value), pickPrimary), 250);
  });
  primary.addEventListener("blur", () => setTimeout(() => primaryList.hidden = true, 150));

  // pre-filled commander (edit/reopen): re-derive partner-ability so the second field shows again
  if (v.commander && !v.second) {
    SF.getCard(v.commander).then(async c => {
      if (!c) return;
      v.second = c.second; v.baseCi = c.ci;
      if (!v.art) v.art = c.art;   // refreshPips() below re-frames the art slot
      if (v.commander2) { const c2 = await SF.getCard(v.commander2); v.ci2 = c2?.ci || []; if (!v.art2) v.art2 = c2?.art || null; }
      refreshPips(); renderSecond();
    });
  }
  renderSecond();
  return { getValue: () => ({ ...v, ci: v.ci.slice() }) };
}
