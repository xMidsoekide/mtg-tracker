/* metrics.js — pure aggregation functions for the Commander tracker.
   Dual-mode: ES module usable in the browser (<script type="module">) and
   under Node's test runner (import {...} from '../js/metrics.js').
   No DOM, no Date.now, no globals — everything derives from its arguments. */

/* ---------- scalar helpers ---------- */
export const won = (placement) => placement === 1;

export const normalizedScore = (placement, podSize) =>
  (podSize - placement) / (podSize - 1);

export const expectedWR = (podSize) => 1 / podSize;

export const seatOf = (game, playerId = "me") => game.seats?.find((s) => s.playerId === playerId);
export const mySeat = (game) => seatOf(game, "me");

/* mean/stdev return null on empty (or <2 for stdev) so callers never see NaN. */
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

const stdev = (xs) => {
  if (xs.length < 2) return null; // population stdev is undefined for a single sample here
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/* podSize is authoritative as seats.length; my placement/seat come from mySeat. */
const podSize = (game) => game.seats.length;

/* ---------- aggregateDeck ---------- */
/* Aggregates a player's results over a set of games (filtered to one deck, or all). playerId
   defaults to "me" so existing callers are unchanged. `games` = games the player appeared in;
   finish/win figures use only games where their placement was recorded (`scored`) — opponents
   often have no recorded finish, so the two can differ. */
export function aggregateDeck(games, playerId = "me") {
  const present = games
    .map((g) => ({ seat: seatOf(g, playerId), size: podSize(g), date: g.date }))
    .filter((m) => m.seat);
  const total = present.length;
  if (!total) {
    return {
      games: 0, scored: 0, wins: 0, actualWR: null, expectedWR: null, wrVsExpected: null,
      avgPlace: null, avgNorm: null, finishVsAvg: null, volatility: null, avgPodSize: null, lastPlayed: null,
    };
  }

  const scored = present.filter((m) => m.seat.placement != null);
  const n = scored.length;
  const placements = scored.map((m) => m.seat.placement);
  const norms = scored.map((m) => normalizedScore(m.seat.placement, m.size));
  const wins = placements.filter(won).length;
  const actualWR = n ? wins / n : null;
  const expWR = n ? mean(scored.map((m) => expectedWR(m.size))) : null;
  const avgNorm = mean(norms);

  return {
    games: total,
    scored: n,
    wins,
    actualWR,
    expectedWR: expWR,
    wrVsExpected: actualWR == null ? null : actualWR - expWR,
    avgPlace: mean(placements),
    avgNorm,
    // finish vs a random seat: normalized finish averages 0.5 for any pod size, so the
    // baseline is a clean 50% (pod-size-fair without a 1/podSize term). This is the app's
    // north-star — rewards placing well, not only winning.
    finishVsAvg: avgNorm == null ? null : avgNorm - 0.5,
    volatility: stdev(norms),
    avgPodSize: mean(present.map((m) => m.size)),
    lastPlayed: present.map((m) => m.date).sort().at(-1),
  };
}

/* ---------- form ---------- */
/* Newest-first W/L list (last n games) + current streak. */
export function form(games, n = 5) {
  const sorted = [...games].sort((a, b) => b.date.localeCompare(a.date));
  const recent = sorted.slice(0, n).map((g) => (won(mySeat(g).placement) ? "W" : "L"));

  let streak = { type: null, len: 0 };
  for (const r of recent) {
    if (streak.len === 0) streak = { type: r, len: 1 };
    else if (r === streak.type) streak.len++;
    else break;
  }
  return { recent, streak };
}

/* ---------- pilotOverall ---------- */
/* North-star: a player's finish vs average (+ win rate) across every game they appeared in. */
export function pilotOverall(games, playerId = "me") {
  const a = aggregateDeck(games, playerId);
  return {
    games: a.games,
    scored: a.scored,
    wins: a.wins,
    actualWR: a.actualWR,
    expectedWR: a.expectedWR,
    wrVsExpected: a.wrVsExpected,
    avgNorm: a.avgNorm,
    finishVsAvg: a.finishVsAvg,
  };
}

/* ---------- seatBreakdown ---------- */
/* Per turn-order seat 1..5: how I do from that seat. */
export function seatBreakdown(games) {
  const out = {};
  for (let s = 1; s <= 5; s++) {
    const inSeat = games.filter((g) => mySeat(g).seat === s);
    const placements = inSeat.map((g) => mySeat(g).placement);
    const exps = inSeat.map((g) => expectedWR(podSize(g)));
    const norms = inSeat.map((g) => normalizedScore(mySeat(g).placement, podSize(g)));
    const wins = placements.filter(won).length;
    const actualWR = inSeat.length ? wins / inSeat.length : null;
    const expWR = mean(exps);
    const avgNorm = mean(norms);
    out[s] = {
      games: inSeat.length,
      wins,
      wrVsExpected: actualWR == null ? null : actualWR - expWR,
      finishVsAvg: avgNorm == null ? null : avgNorm - 0.5,
      avgPlace: mean(placements),
    };
  }
  return out;
}

/* ---------- headToHead ---------- */
/* Per opponent *player* (playerId !== "me"/null). Null opponent placements are
   counted in together + unknown but excluded from above/below comparisons.
   avgMyPlaceWhenPresent = my mean placement across all games this player was in. */
export function headToHead(games) {
  const out = {};
  for (const g of games) {
    const myPlace = mySeat(g).placement;
    for (const s of g.seats) {
      if (s.playerId == null || s.playerId === "me") continue;
      const h = (out[s.playerId] ??= {
        together: 0,
        theyAboveMe: 0,
        iAboveThem: 0,
        unknown: 0,
        _myPlaces: [],
      });
      h.together++;
      h._myPlaces.push(myPlace);
      if (s.placement == null) h.unknown++;
      else if (s.placement < myPlace) h.theyAboveMe++; // lower placement = better finish
      else h.iAboveThem++;
    }
  }
  // Replace the accumulator with the public shape.
  for (const id of Object.keys(out)) {
    const { _myPlaces, ...rest } = out[id];
    out[id] = { ...rest, avgMyPlaceWhenPresent: mean(_myPlaces) };
  }
  return out;
}

/* ---------- bogeyDecks ---------- */
/* Per opponent deck, keyed by deckId when known else the raw commander string.
   Same null-placement handling as headToHead. */
export function bogeyDecks(games) {
  const out = {};
  for (const g of games) {
    const myPlace = mySeat(g).placement;
    for (const s of g.seats) {
      if (s.playerId === "me") continue;
      const key = s.deckId ?? s.commander;
      if (key == null) continue;
      const b = (out[key] ??= { faced: 0, aboveMe: 0, belowMe: 0, unknown: 0 });
      b.faced++;
      if (s.placement == null) b.unknown++;
      else if (s.placement < myPlace) b.aboveMe++;
      else b.belowMe++;
    }
  }
  return out;
}

/* ---------- wilson ---------- */
/* Wilson score 95% interval on the underlying win probability.
   Returns {low:0, high:0} for n=0 to avoid divide-by-zero. */
export function wilson(wins, n, z = 1.96) {
  if (n === 0) return { low: 0, high: 0 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return { low: (center - margin) / denom, high: (center + margin) / denom };
}

/* ---------- confidence ---------- */
export function confidence(n, min) {
  return { enough: n >= min, needed: Math.max(0, min - n) };
}
