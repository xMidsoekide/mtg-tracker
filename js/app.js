import * as M from "./metrics.js";
import * as S from "./storage.js";
import * as SF from "./scryfall.js";
import * as SYNC from "./sync.js";

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const pct = x => x == null ? "–" : Math.round(x * 100) + "%";
const signed = x => x == null ? "–" : (x >= 0 ? "+" : "") + Math.round(x * 100) + "%";
const shortName = c => (c || "").split(",")[0].split(" + ")[0];

/* commander identity display */
const deckCI = d => d?.ci || [];
const ciPips = ci => ci?.length ? `<span class="pips-ci">${ci.map(c => `<span class="ci ${c}"></span>`).join("")}</span>` : "";
const artImg = (url, cls = "art", pos) => url ? `<img class="${cls}" src="${esc(url)}" ${pos ? `style="object-position:50% ${pos}%"` : ""} alt="" loading="lazy" />` : "";
const artPosOf = d => d?.artPos ?? null;   // vertical focal %, null = CSS default
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

/* ---------- toast ---------- */
let toastEl;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "toast"; document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 1600);
}

/* ---------- Overview hero visuals ---------- */
const heroCol = v => v >= 0 ? "var(--good)" : "var(--bad)";
const HERO_MAX = 0.25;   // gauge range ±25%, clamps beyond

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

function heroSpark(data, w = 150, h = 34) {
  if (data.length < 2) return "";
  const min = Math.min(...data), max = Math.max(...data), span = (max - min) || 1;
  const X = i => i / (data.length - 1) * w, Y = v => h - ((v - min) / span) * (h - 6) - 3;
  const line = data.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const end = data.at(-1);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${heroCol(end)}" stop-opacity=".32"/><stop offset="1" stop-color="${heroCol(end)}" stop-opacity="0"/></linearGradient></defs>
    <polygon points="0,${h} ${line} ${w},${h}" fill="url(#hg)"/>
    <polyline points="${line}" fill="none" stroke="${heroCol(end)}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${w}" cy="${Y(end).toFixed(1)}" r="3.5" fill="${heroCol(end)}"/></svg>`;
}

/* cumulative WR-vs-expected after each game, in date order */
function heroSeries(games) {
  const sorted = games.slice().sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return sorted.map((_, i) => M.pilotOverall(sorted.slice(0, i + 1)).wrVsExpected);
}
function heroTrend(series) {
  if (series.length < 4) return "";
  const d = series.at(-1) - series.at(-4);
  return d > 0.005 ? "↗ improving" : d < -0.005 ? "↘ slipping" : "→ steady";
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
  const games = allGames();
  const a = M.pilotOverall(games);
  const wrCls = (a.wrVsExpected ?? 0) >= 0 ? "pos" : "neg";

  const v = a.wrVsExpected;
  const series = heroSeries(games);
  const heroBody = a.games === 0
    ? `<div class="value" style="color:var(--muted)">–</div><div class="sub">Log a game to get started</div>`
    : `<div style="display:flex;align-items:center;gap:13px;margin-top:8px">
        <div style="flex:0 0 auto">${heroGauge(v, 0.66)}</div>
        <div style="flex:1;min-width:0">
          <div class="value ${wrCls}" style="font-size:32px">${signed(v)}</div>
          <div class="sub" style="margin:3px 0 ${series.length > 1 ? "9px" : "0"}">${[heroTrend(series), `${a.games} games`, `won ${pct(a.actualWR)}`].filter(Boolean).join(" · ")}</div>
          ${heroSpark(series)}
        </div>
      </div>`;
  const tiles = `
    <div class="tiles">
      <div class="tile hero">
        <div class="label">My win rate vs expected</div>
        ${heroBody}
      </div>
    </div>`;

  // Recently played — last 3 distinct decks of mine, for a quick "what do I bring tonight"
  const recent = [];
  for (const g of games.slice().sort((x, y) => y.date.localeCompare(x.date) || y.id.localeCompare(x.id))) {
    const id = M.mySeat(g)?.deckId;
    if (id && S.deckById(id) && !recent.some(r => r.id === id)) recent.push({ id, date: g.date });
    if (recent.length === 3) break;
  }
  const recentCards = recent.map(r => {
    const d = S.deckById(r.id); const ag = M.aggregateDeck(myGamesForDeck(r.id));
    const cls = (ag.wrVsExpected ?? 0) >= 0 ? "pos" : "neg";
    return `<div class="leader" data-deck="${r.id}">
      ${d.art ? `<img class="recent-art" src="${esc(d.art)}" ${artPosOf(d) != null ? `style="object-position:50% ${artPosOf(d)}%"` : ""} alt="" loading="lazy" />` : ""}
      <div class="lt">${relDate(r.date)}</div>
      <div class="ln">${esc(shortName(d.commander))}</div><div class="lv ${cls}">${signed(ag.wrVsExpected)}</div></div>`;
  }).join("");
  const recentBlock = recent.length
    ? `<div class="section-head"><h2>Recently played</h2></div><div class="recent-grid">${recentCards}</div>` : "";

  const rows = deckRows(0).sort((x, y) => {
    if (!x.games) return 1; if (!y.games) return -1;
    return (y.wrVsExpected ?? -9) - (x.wrVsExpected ?? -9);
  }).map((d, i) => {
    const idCell = `<div style="display:flex;align-items:center;gap:9px;min-width:0">${artImg(d.art, "art", artPosOf(d))}
      <div style="min-width:0"><div class="name">${esc(shortName(d.commander))}</div><div class="theme" style="display:flex;align-items:center;gap:6px">${ciPips(deckCI(d))} ${esc(d.theme)}</div></div></div>`;
    if (!d.games) return `<div class="lb-row low" data-deck="${d.id}"><div class="rank">–</div>
      ${idCell}<div class="metric" style="color:var(--muted)">—<small>Not played</small></div></div>`;
    const low = d.games < MIN_GAMES;
    const cls = d.wrVsExpected >= 0 ? "pos" : "neg";
    return `<div class="lb-row ${low ? "low" : ""}" data-deck="${d.id}">
      <div class="rank">${i + 1}</div>
      ${idCell.replace('class="name">', `class="name">${low ? '<span class="flag" title="few games — still noisy">⚠</span> ' : ""}`)}
      <div class="metric ${cls}">${signed(d.wrVsExpected)}<small>${d.games} games · ${pct(d.actualWR)} WR</small></div>
    </div>`;
  }).join("");

  $("#view-dash").innerHTML = tiles + recentBlock + `
    <div class="section-head"><h2>Decks · WR vs expected</h2></div>
    <div class="lb">${rows}</div>`;

  $("#view-dash").querySelectorAll("[data-deck]").forEach(r =>
    r.addEventListener("click", () => openDeck(r.dataset.deck)));
}

/* ---------- Compare ---------- */
/* avgNorm = pod-size-fair finish (1st=100%, last=0%); raw avg placement is intentionally
   omitted because it ignores pod size (3rd of 4 ≠ 3rd of 5). */
const METRICS = [
  { key:"wrVsExpected", label:"WR vs expected", bar:"diverge", fmt:d=>signed(d.wrVsExpected) },
  { key:"actualWR",     label:"Win rate",       bar:"abs",     fmt:d=>pct(d.actualWR) },
  { key:"avgNorm",      label:"Average finish", bar:"abs",     fmt:d=>pct(d.avgNorm) },
  { key:"volatility",   label:"Swinginess",     bar:"relLow",  fmt:d=>d.volatility==null?"–":d.volatility.toFixed(2) },
  { key:"games",        label:"Games played",   bar:"relHigh", neutral:true, fmt:d=>String(d.games) },
];

/* goodness 0..1 -> red→gold→green; keeps gold in the middle so it still reads MTG. */
const goodnessColor = f => `hsl(${Math.round(f * 125)} 60% 46%)`;

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
    card("🏆","Best vs expected", extreme("wrVsExpected", +1), d => signed(d.wrVsExpected)),
    card("🎯","Best finisher",    extreme("avgNorm", +1),      d => pct(d.avgNorm)),
    card("🔁","Most played",      extreme("games", +1),        d => `${d.games} games`),
    card("🛡","Steadiest",        extreme("volatility", -1),   d => d.volatility.toFixed(2)),
    card("🎲","Swingiest",        extreme("volatility", +1),   d => d.volatility.toFixed(2)),
  ].filter(Boolean).join("");
  return `<div class="section-head"><h2>Leaders</h2></div><div class="leaders">${html}</div>`;
}

/* shared: list of diverging WR-vs-expected bars (items: {label, sub, value}) */
function divergingList(items) {
  const maxAbs = Math.max(1e-9, ...items.map(i => Math.abs(i.value)));
  return items.map(i => {
    const w = Math.abs(i.value) / maxAbs * 50;
    const side = i.value >= 0 ? `left:50%; width:${w}%; background:var(--good)` : `right:50%; width:${w}%; background:var(--bad)`;
    return `<div class="rank-row"><div class="rank-head">
      <span class="rk-name">${i.label}${i.sub ? ` <span style="color:var(--muted);font-size:12px;font-weight:500">${i.sub}</span>` : ""}</span>
      <span class="rk-val ${i.value >= 0 ? "pos" : "neg"}">${signed(i.value)}</span></div>
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
    .map(s => ({ label: `Seat ${s.s}`, sub: `${s.games} games · ${s.avgPlace.toFixed(1)} avg`, value: s.wrVsExpected }));
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
    .sort((a, b) => (b.wrVsExpected ?? -9) - (a.wrVsExpected ?? -9))
    .map(x => ({ label: `<span class="pips-ci"><span class="ci ${x.col}"></span></span> ${CI_LABEL[x.col]}`, sub: `${x.games} games`, value: x.wrVsExpected }));
  if (items.length < 2) return "";
  return `<div class="section-head"><h2>By colour</h2></div><div class="cmp-metric"><div class="rank-list">${divergingList(items)}</div></div>`;
}

function renderCompare() {
  $("#view-compare").innerHTML = renderLeaders() + `
    <div class="section-head"><h2>Compare decks</h2>
      <div class="seg" id="podseg">
        <button data-pod="0" class="${podFilter === 0 ? "on" : ""}">All</button>
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

  const dist = [1, 2, 3, 4, 5].map(p => gs.filter(g => M.mySeat(g).placement === p).length);
  const maxD = Math.max(1, ...dist);
  const bars = dist.map((c, i) => `<div class="bar"><span class="n">${c || ""}</span>
    <div class="fill" style="height:${c / maxD * 100}%; ${c ? "" : "opacity:.25"}"></div>
    <span class="lab">${ord(i + 1)}</span></div>`).join("");

  const games = gs.slice().reverse().map(g => {
    const ms = M.mySeat(g); const w = M.won(ms.placement);
    const opp = g.seats.filter(s => s.playerId !== "me")
      .map(s => esc((s.playerId ? (S.playerById(s.playerId)?.name + ": ") : "") + seatCards(s))).join(" · ");
    return `<div class="game-item"><div class="top">
      <strong>${g.date} · ${g.seats.length}P · seat ${ms.seat ?? "?"}</strong>
      <span class="badge" style="background:${w ? "#16382c" : "#3a1f1d"};color:${w ? "var(--good)" : "var(--bad)"}">${w ? "1st 🏆" : ord(ms.placement)}</span></div>
      <div class="note">vs ${opp}</div>${g.notes ? `<div class="note">📝 ${esc(g.notes)}</div>` : ""}</div>`;
  }).join("");

  const wrCls = (a.wrVsExpected ?? 0) >= 0 ? "pos" : "neg";
  $("#view-deck").innerHTML = `
    <button class="back" id="deck-back">‹ Back</button>
    ${d.art ? `<img class="deck-hero-art" src="${esc(d.art)}" ${artPosOf(d) != null ? `style="object-position:50% ${artPosOf(d)}%"` : ""} alt="" />` : ""}
    <div class="section-head" style="margin-top:4px"><div>
      <h2 style="color:var(--text);font-size:18px;text-transform:none;letter-spacing:0">${deckTitle(d)}</h2>
      <div class="theme" style="color:var(--muted);font-size:13px;margin-top:3px;display:flex;align-items:center;gap:7px">${ciPips(deckCI(d))} ${esc(d.theme)}</div></div></div>
    <div class="tiles" style="margin-top:12px">
      <div class="tile hero"><div class="label">WR vs expected</div><div class="value ${wrCls}">${signed(a.wrVsExpected)}</div>
        <div class="sub">${a.games} games · won ${pct(a.actualWR)}</div></div>
      <div class="tile"><div class="label">Average finish</div><div class="value">${pct(a.avgNorm)}</div></div>
      <div class="tile"><div class="label">Swinginess</div><div class="value">${a.volatility == null ? "–" : a.volatility.toFixed(2)}</div>${a.volatility == null ? '<div class="sub">Need 2+ games</div>' : ""}</div>
    </div>
    <div class="chart-card"><h3>Placement distribution</h3><div class="dist">${bars}</div></div>
    <div class="section-head"><h2>Games (${gs.length})</h2></div>
    ${games || '<div class="empty">No games logged</div>'}`;
  $("#deck-back").addEventListener("click", () => switchTab(lastTab));
  showView("view-deck");
}

/* a player's most-played commander (for their Rivals avatar) */
function topCommander(games, playerId) {
  const tally = {};
  for (const g of games) for (const s of g.seats) {
    if (s.playerId !== playerId) continue;
    const key = s.deckId || s.commander; if (!key) continue;
    const d = s.deckId ? S.deckById(s.deckId) : null;
    (tally[key] ??= { name: d?.commander || s.commander, art: d?.art || s.art || null, n: 0 }).n++;
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
    const w = h.iAboveThem, l = h.theyAboveMe, u = h.unknown;
    const seg = (n, color) => n ? `<span style="width:${n / tot * 100}%;background:${color}"></span>` : "";
    const leg = (color, label, n) => n ? `<i><span class="dot" style="background:${color}"></span>${label} ${n}</i>` : "";
    const top = topCommander(games, id);
    return `<div class="h2h"><div class="top" style="gap:10px;align-items:center">
        ${top?.art ? artImg(top.art) : ""}
        <div style="flex:1;min-width:0"><span class="who">${esc(name)}</span>${top?.name ? `<div class="rec">${esc(shortName(top.name))}</div>` : ""}</div>
        <span class="rec">${h.together} games</span></div>
      <div class="wld">${seg(w, "var(--good)")}${seg(l, "var(--bad)")}${seg(u, "var(--surface-2)")}</div>
      <div class="legend">${leg("var(--good)", "Beat them", w)}${leg("var(--bad)", "Lost to them", l)}${leg("var(--surface-2)", "Not recorded", u)}</div></div>`;
  }).join("");

  // bogey decks — opponent decks with at least 2 *recorded* finishes vs me, worst first
  const bog = M.bogeyDecks(games);
  const bogRows = Object.entries(bog)
    .map(([k, b]) => { const d = S.deckById(k); return { name: d?.commander || k, art: d?.art || null, decided: b.aboveMe + b.belowMe, ...b }; })
    .filter(b => b.decided >= 2)
    .sort((a, b) => (b.aboveMe / b.decided) - (a.aboveMe / a.decided) || b.decided - a.decided)
    .map(b => {
      const p = Math.round(b.aboveMe / b.decided * 100);
      return `<div class="lb-row"><div class="rank">${b.faced}×</div>
        <div style="display:flex;align-items:center;gap:9px;min-width:0">${b.art ? artImg(b.art) : ""}<div style="min-width:0"><div class="name">${esc(shortName(b.name))}</div><div class="theme">Beat me ${b.aboveMe} of ${b.decided} recorded${b.unknown ? ` · ${b.unknown} not recorded` : ""}</div></div></div>
        <div class="metric ${p >= 50 ? "neg" : "pos"}">${p}%<small>Beat me</small></div></div>`;
    }).join("");

  $("#view-rivals").innerHTML = `
    <div class="section-head"><h2>Head-to-head</h2></div>
    ${cards || '<div class="empty">No games with named players yet.<br>Tag friends when you log a game.</div>'}
    <div class="section-head"><h2>Bogey decks</h2></div>
    ${bogRows ? `<div class="lb">${bogRows}</div>` : '<div class="empty">Play a few games with finishing order to see which decks beat you.</div>'}`;
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
  const deckOpts = S.myDecks().map(d => `<option value="${d.id}" ${d.id === draft.deckId ? "selected" : ""}>${esc(d.commander)}</option>`).join("");
  const roster = S.players().filter(p => !p.self);
  const chips = (cur, n, attr) => Array.from({ length: n }, (_, i) =>
    `<div class="chip ${cur === i + 1 ? "on" : ""}" data-${attr}="${i + 1}">${i + 1}</div>`).join("");
  const placeSel = (cur) => `<select class="opp-place">${["<option value=''>Place…</option>",
    ...Array.from({ length: draft.podSize }, (_, i) => `<option value="${i + 1}" ${cur === i + 1 ? "selected" : ""}>${ord(i + 1)}</option>`)].join("")}</select>`;

  const oppBlocks = draft.opponents.map((o, i) => `
    <div class="opp-block" data-i="${i}">
      <div class="opp-row">
        <select class="opp-player">
          <option value="">Unknown</option>
          ${roster.map(p => `<option value="${p.id}" ${p.id === o.playerId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        </select>
        ${placeSel(o.placement)}
      </div>
      <div class="opp-picker" data-i="${i}"></div>
    </div>`).join("");

  $("#view-log").innerHTML = `
    <button class="btn-primary" id="start-live" style="margin-bottom:6px">▶ Start a live game</button>
    <p class="hint" style="margin-top:0">Set up the pod now, fill in finishing order at the end.</p>
    <div class="section-head"><h2>Or quick-log a finished game</h2></div>
    <div class="field"><label>Date</label><input id="log-date" type="date" value="${draft.date}" /></div>
    <div class="field"><label>My deck</label><select id="log-deck">${deckOpts}</select></div>
    <div class="field"><label>Pod size</label><div class="choices" id="pod-choice">
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
  v.querySelector("#pod-choice").addEventListener("click", e => { const c = e.target.closest(".chip"); if (c) setPodSize(+c.dataset.pod); });
  v.querySelector("#repeat-pod").addEventListener("click", repeatLastPod);
  v.querySelector("#seat-choice").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return; draft.mySeat = +c.dataset.seat; v.querySelectorAll("#seat-choice .chip").forEach(x => x.classList.toggle("on", x === c)); });
  v.querySelector("#place-choice").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return; draft.myPlacement = +c.dataset.place; v.querySelectorAll("#place-choice .chip").forEach(x => x.classList.toggle("on", x === c)); });
  v.querySelectorAll(".opp-place").forEach((sel, i) => sel.addEventListener("change", () => draft.opponents[i].placement = sel.value ? +sel.value : null));
  v.querySelectorAll(".opp-picker").forEach(mount => {
    const i = +mount.dataset.i;
    makePicker(mount, draft.opponents[i], upd => Object.assign(draft.opponents[i],
      { commander: upd.commander, commander2: upd.commander2, art: upd.art, art2: upd.art2, ci: upd.ci, second: upd.second }));
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
  pushTimer = setTimeout(() => pushNow(), 1500);   // debounce auto-push
}
async function pushNow() {
  if (!SYNC.isConfigured() || syncing) return;
  syncing = true; updateSyncBadge();
  try { await SYNC.push(S.exportJson()); dirty = false; }
  catch (e) { toast(e.message); }
  finally { syncing = false; updateSyncBadge(); }
}
/* last-write-wins reconcile against the gist */
async function syncNow() {
  if (!SYNC.isConfigured()) return;
  syncing = true; updateSyncBadge();
  try {
    const remote = await SYNC.pull();
    const local = S.getState();
    if (remote && (remote.updatedAt || "") > (local.updatedAt || "")) {
      S.replaceAll(remote); MIN_GAMES = S.settings().minGames ?? MIN_GAMES; switchTab("dash");
    } else if ((local.updatedAt || "") > (remote?.updatedAt || "")) {
      await SYNC.push(S.exportJson());
    }
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
      <textarea id="io-box" placeholder="Paste JSON here to import…" style="margin-top:10px;min-height:90px"></textarea></div>`;
  const v = $("#view-settings");
  v.querySelector("#set-back").addEventListener("click", () => switchTab(lastTab === "settings" ? "dash" : lastTab));
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

document.querySelector("nav.tabbar").addEventListener("click", e => {
  const b = e.target.closest("button"); if (b) switchTab(b.dataset.tab);
});
$("#sync-btn").addEventListener("click", () => { renderSettings(); showView("view-settings"); });

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

/* pointer-based drag reordering (works on touch + mouse, no library) */
function makeSortable(list, onReorder) {
  if (!list) return;
  let drag = null;
  const onMove = e => {
    if (!drag) return;
    e.preventDefault();
    const others = [...list.querySelectorAll(".part-row:not(.dragging)")];
    const after = others.find(r => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
    if (after) list.insertBefore(drag, after); else list.appendChild(drag);
  };
  const onUp = () => {
    if (!drag) return;
    drag.classList.remove("dragging");
    const order = [...list.querySelectorAll(".part-row")].map(r => r.dataset.uid);
    drag = null;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    onReorder(order);
  };
  list.querySelectorAll(".part-drag").forEach(handle => handle.addEventListener("pointerdown", e => {
    e.preventDefault();
    drag = handle.closest(".part-row");
    drag.classList.add("dragging");
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
  }));
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
  g.participants.forEach((p, i) => { p.turn = i + 1; });   // freeze turn order from setup order
  g.status = "finish"; saveActive(g); renderLog();
}
function liveBackToSetup() { liveSyncDom(); const g = S.getActive(); g.participants.sort((a, b) => a.turn - b.turn); g.status = "setup"; saveActive(g); renderLog(); }
function liveCancel() { if (confirm("Discard this live game?")) { S.clearActive(); renderLog(); } }

function liveSave() {
  liveSyncDom();
  const g = S.getActive();
  const me = g.participants.find(p => p.playerId === "me");
  if (!me?.deckId) return toast("Pick your deck");
  const seats = g.participants.map((p, i) => {
    if (p.playerId === "me") return { playerId: "me", deckId: p.deckId, seat: p.turn ?? null, placement: i + 1 };
    const cmd = (p.commander || "").trim();
    const extra = { commander2: p.commander2 || null, art: p.art || null, art2: p.art2 || null, ci: p.ci || [] };
    const deckId = (p.playerId && cmd) ? S.ensureDeck(p.playerId, cmd, extra) : null;
    return { playerId: p.playerId || null, deckId, commander: cmd || null, commander2: p.commander2 || null, art: p.art || null, ci: p.ci || [], seat: p.turn ?? null, placement: i + 1 };
  });
  S.addGame({ id: S.newId("g"), date: g.date, seats, notes: (g.notes || "").trim() });
  S.clearActive(); markDirty(); toast("Game saved"); switchTab("dash");
}

function renderLiveGame(g) {
  const setup = g.status === "setup";
  const addable = S.players().filter(p => !p.self && !g.participants.some(x => x.playerId === p.id));
  const myDeckOpts = S.myDecks().map(d => `<option value="${d.id}">${esc(d.commander)}</option>`).join("");

  const rows = g.participants.map((p, i) => {
    const isMe = p.playerId === "me";
    const lead = setup ? `${i + 1}.` : `<strong>${ord(i + 1)}</strong>`;
    const ctrl = `<span class="part-drag" title="Drag to reorder">⠿</span>`;
    const myDeck = isMe ? S.deckById(p.deckId) : null;
    let cmdField;
    if (isMe) {
      cmdField = setup
        ? `<div style="display:flex;align-items:center;gap:8px">${artImg(myDeck?.art, "art art-sm")}<select class="part-deck" style="flex:1">${myDeckOpts.replace(`value="${p.deckId}"`, `value="${p.deckId}" selected`)}</select>${ciPips(deckCI(myDeck))}</div>`
        : `<div class="part-static" style="display:flex;align-items:center;gap:8px">${artImg(myDeck?.art, "art art-sm")}<span>${esc(myDeck?.commander || "—")}</span></div>`;
    } else {
      cmdField = setup
        ? `<div class="part-picker" data-uid="${p.uid}"></div>`
        : `<div class="part-static" style="display:flex;align-items:center;gap:8px">${artImg(p.art, "art art-sm")}<span>${esc(p.commander || "—")}${p.commander2 ? ` <span style="color:var(--muted)">+</span> ${esc(p.commander2)}` : ""}</span></div>`;
    }
    const rm = (setup && !isMe) ? `<button class="part-rm" data-rm="${p.uid}">✕</button>` : "";
    return `<div class="part-row ${isMe ? "me" : ""}" data-uid="${p.uid}">
      <span class="part-lead">${lead}</span>
      <div class="part-body"><div class="part-name">${esc(p.name)}${setup ? "" : ` <span class="sub">· turn ${p.turn}</span>`}</div>${cmdField}</div>
      ${ctrl}${rm}</div>`;
  }).join("");

  const addBtns = setup ? `<div class="add-players">
    ${addable.map(p => `<button class="chip-add" data-add="${p.id}">+ ${esc(p.name)}</button>`).join("")}
    <button class="chip-add" data-add="">+ Guest</button></div>` : "";

  return `
    <div class="live-head"><h2>${setup ? "Live game · setup" : "Finishing order"}</h2>
      <button class="back" id="live-cancel">Discard</button></div>
    <p class="hint" style="margin-top:0">${setup
      ? "Add everyone in <b>turn order</b> (1 = goes first) — drag ⠿ to reorder."
      : "Drag ⠿ into <b>finishing order</b> — top = winner. Turn order is kept from setup."}</p>
    ${setup ? `<div class="field"><label>Date</label><input id="live-date" type="date" value="${g.date}" /></div>` : ""}
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
    saveActive(g); renderLog();
  });
  // mount a Scryfall picker per opponent; it persists straight to the active game
  v.querySelectorAll(".part-picker").forEach(mount => {
    const uid = mount.dataset.uid;
    const p = S.getActive().participants.find(x => x.uid === uid);
    makePicker(mount, p, upd => {
      const g = S.getActive(); const pp = g.participants.find(x => x.uid === uid); if (!pp) return;
      Object.assign(pp, { commander: upd.commander, commander2: upd.commander2, art: upd.art, art2: upd.art2, ci: upd.ci, second: upd.second });
      saveActive(g);
    });
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
    const w = ms && M.won(ms.placement);
    const badge = ms ? `<span class="badge" style="background:${w ? "#16382c" : "#3a1f1d"};color:${w ? "var(--good)" : "var(--bad)"}">${w ? "1st" : ord(ms.placement)}</span>` : "";
    return `<div class="game-item tap" data-game="${g.id}"><div class="top">
      <strong>${g.date} · ${esc(myDeck)}</strong>${badge}</div>
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
  showView("view-edit");
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
    const who = isMe
      ? `<div class="part-name">Me</div><select class="ed-deck">${myDeckOpts.replace(`value="${s.deckId}"`, `value="${s.deckId}" selected`)}</select>`
      : `<select class="ed-player"><option value="">Guest</option>${roster.map(p => `<option value="${p.id}" ${p.id === s.playerId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
         <div class="ed-picker" data-i="${i}"></div>`;
    return `<div class="part-row ${isMe ? "me" : ""}" data-i="${i}">
      <div class="part-body">${who}</div>
      <div class="ed-nums"><label>place ${numSel("ed-place", s.placement, "?")}</label><label>turn ${numSel("ed-turn", s.seat, "?")}</label></div>
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
    editPickers[i] = makePicker(mount, { commander: s.commander || d?.commander || "", commander2: s.commander2 || d?.commander2 || null, art: s.art || d?.art || null, ci: s.ci || d?.ci || [] }, () => {});
  });
  v.querySelector("#edit-close").addEventListener("click", () => switchTab("history"));
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
      ${artImg(d.art, "art", artPosOf(d))}
      <div class="deck-info"><div class="name">${deckTitle(d)}</div><div class="theme" style="display:flex;align-items:center;gap:6px">${ciPips(deckCI(d))} ${esc(d.theme || "—")} · ${n} games</div></div>
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
  v.querySelector("#decks-back").addEventListener("click", () => {
    const t = Object.keys(VIEW).find(k => VIEW[k] === decksReturn);
    if (t) switchTab(t); else { renderSettings(); showView("view-settings"); }
  });
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
let decksReturn = "view-settings";
function openDecks() {
  decksReturn = document.querySelector(".view.active")?.id || "view-settings";
  editingDeck = null; renderDecks(); showView("view-decks");
}

/* ---------- commander picker (Scryfall autocomplete + partner/background) ---------- */
let pickerSeq = 0;
const SECOND_LABEL = { partner:"Partner", partnerWith:"Partner with", background:"Background", friends:"Friends forever", companion:"Doctor", doctor:"Companion" };

function makePicker(mount, initial = {}, onChange = () => {}) {
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
        <span class="art-slot">${v.art ? artImg(v.art, "art art-sm") : ""}</span>
        <input class="primary-input" type="text" placeholder="Commander…" value="${esc(v.commander)}" autocomplete="off" style="flex:1" />
        <span class="pips-slot">${ciPips(v.ci)}</span>
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
  const refreshPips = () => { v.ci = SF.mergeCI(v.baseCi, v.ci2); pipsSlot.innerHTML = ciPips(v.ci); };

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
    artSlot.innerHTML = v.art ? artImg(v.art, "art art-sm") : "";
    refreshPips(); renderSecond(); emit();
  }
  async function pickSecond(name) {
    v.commander2 = name;
    const c = await SF.getCard(name);
    v.art2 = c?.art || null; v.ci2 = c?.ci || [];
    refreshPips(); renderSecond(); emit();
  }

  function renderSecond() {
    if (!v.second) { secondSlot.innerHTML = ""; v.commander2 = v.commander2 && v.second ? v.commander2 : null; return; }
    if (v.second.type === "partnerWith" && !v.commander2) { pickSecond(v.second.name); return; }
    secondSlot.innerHTML = `
      <div class="second-pick"><div class="second-label">${SECOND_LABEL[v.second.type] || "Second"}</div>
        <div class="ac-wrap" style="display:flex;align-items:center;gap:8px">
          <span class="art-slot2">${v.art2 ? artImg(v.art2, "art art-sm") : ""}</span>
          <input class="second-input" type="text" placeholder="${SECOND_LABEL[v.second.type] || "Second card"}…" value="${esc(v.commander2 || "")}" autocomplete="off" style="flex:1" />
          ${v.commander2 ? '<button class="clear-x" title="Clear">✕</button>' : ""}
          <div class="ac-list second-list" hidden></div>
        </div></div>`;
    const sec = secondSlot.querySelector(".second-input");
    const secList = secondSlot.querySelector(".second-list");
    secondSlot.querySelector(".clear-x")?.addEventListener("click", () => { v.commander2 = null; v.art2 = null; v.ci2 = []; refreshPips(); renderSecond(); emit(); });
    sec.addEventListener("input", () => {
      v.commander2 = sec.value || null; emit();
      clearTimeout(tSec); tSec = setTimeout(async () => renderList(secList, await SF.searchSecond(sec.value, v.second), pickSecond), 250);
    });
    sec.addEventListener("blur", () => setTimeout(() => secList.hidden = true, 150));
  }

  primary.addEventListener("input", () => {
    v.commander = primary.value; v.art = null; artSlot.innerHTML = ""; emit();
    clearTimeout(tPrim); tPrim = setTimeout(async () => renderList(primaryList, await SF.commanderAutocomplete(primary.value), pickPrimary), 250);
  });
  primary.addEventListener("blur", () => setTimeout(() => primaryList.hidden = true, 150));

  renderSecond();
  return { getValue: () => ({ ...v, ci: v.ci.slice() }) };
}
