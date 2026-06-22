import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  won,
  normalizedScore,
  expectedWR,
  mySeat,
  aggregateDeck,
  form,
  pilotOverall,
  seatBreakdown,
  headToHead,
  bogeyDecks,
  wilson,
  confidence,
} from "../js/metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ---------- fixtures (handwritten, independent of seed files) ----------
   Helper builds a game: me at given placement/seat/podSize, plus opponents.
   Opponents: [{ playerId, deckId, commander, placement }] (any field optional). */
function game(id, { deckId = "d_x", seat = 1, placement = 1, podSize, opps = [] }) {
  // podSize is authoritative as seats.length, so pad anonymous filler seats
  // up to (podSize - 1) opponents when an explicit podSize is requested.
  const filled = [...opps];
  if (podSize != null) {
    while (filled.length < podSize - 1) filled.push({ playerId: null });
  }
  const oppSeats = filled.map((o, i) => ({
    playerId: o.playerId ?? null,
    deckId: o.deckId ?? null,
    commander: o.commander ?? null,
    seat: i + 2,
    placement: o.placement ?? null,
  }));
  return {
    id,
    date: "2026-01-01",
    seats: [{ playerId: "me", deckId, seat, placement }, ...oppSeats],
    notes: "",
  };
}

/* ---------- scalar helpers ---------- */
test("won", () => {
  assert.equal(won(1), true);
  assert.equal(won(2), false);
  assert.equal(won(null), false);
});

test("normalizedScore: 1st = 1, last = 0, middle in between", () => {
  assert.equal(normalizedScore(1, 4), 1);
  assert.equal(normalizedScore(4, 4), 0);
  assert.equal(normalizedScore(2, 4), 2 / 3);
});

test("expectedWR is 1/podSize", () => {
  assert.equal(expectedWR(4), 0.25);
  assert.equal(expectedWR(5), 0.2);
});

test("mySeat finds the me seat, undefined when absent", () => {
  const g = game("g", { seat: 3, placement: 2 });
  assert.equal(mySeat(g).playerId, "me");
  assert.equal(mySeat(g).seat, 3);
  assert.equal(mySeat({ seats: [{ playerId: "x" }] }), undefined);
});

/* ---------- aggregateDeck ---------- */
test("aggregateDeck: 0 games returns nulls, no NaN", () => {
  const a = aggregateDeck([]);
  assert.equal(a.games, 0);
  assert.equal(a.wins, 0);
  assert.equal(a.actualWR, null);
  assert.equal(a.expectedWR, null);
  assert.equal(a.wrVsExpected, null);
  assert.equal(a.avgPlace, null);
  assert.equal(a.avgNorm, null);
  assert.equal(a.volatility, null);
  assert.equal(a.avgPodSize, null);
  assert.equal(a.lastPlayed, null);
});

test("aggregateDeck: 1 game has volatility null (need 2+)", () => {
  const a = aggregateDeck([game("g", { placement: 1, podSize: 4 })]);
  assert.equal(a.games, 1);
  assert.equal(a.wins, 1);
  assert.equal(a.actualWR, 1);
  assert.equal(a.expectedWR, 0.25);
  assert.equal(a.wrVsExpected, 0.75);
  assert.equal(a.avgPlace, 1);
  assert.equal(a.avgNorm, 1);
  assert.equal(a.volatility, null);
  assert.equal(a.avgPodSize, 4);
});

test("aggregateDeck: multi-game means and lastPlayed", () => {
  const g1 = { ...game("g1", { placement: 1, podSize: 4 }), date: "2026-02-01" };
  const g2 = { ...game("g2", { placement: 3, podSize: 4 }), date: "2026-03-01" };
  const a = aggregateDeck([g1, g2]);
  assert.equal(a.games, 2);
  assert.equal(a.wins, 1);
  assert.equal(a.actualWR, 0.5);
  assert.equal(a.avgPlace, 2);
  assert.ok(a.volatility > 0);
  assert.equal(a.lastPlayed, "2026-03-01");
});

test("aggregateDeck: finishVsAvg is normalized finish minus 0.5 (pod-size-fair)", () => {
  // 2nd of 4 every game -> avgNorm 2/3 -> +1/6, NOT a loss-flavoured negative
  const a = aggregateDeck([game("g1", { placement: 2, podSize: 4 }), game("g2", { placement: 2, podSize: 4 })]);
  assert.ok(Math.abs(a.finishVsAvg - (2 / 3 - 0.5)) < 1e-9);
  // last every game -> avgNorm 0 -> -0.5 (floor)
  const last = aggregateDeck([game("g", { placement: 4, podSize: 4 })]);
  assert.equal(last.finishVsAvg, -0.5);
  // 1st every game -> +0.5 (ceiling); baseline is 0.5 regardless of pod size
  const top4 = aggregateDeck([game("a", { placement: 1, podSize: 4 })]);
  const top5 = aggregateDeck([game("b", { placement: 1, podSize: 5 })]);
  assert.equal(top4.finishVsAvg, 0.5);
  assert.equal(top5.finishVsAvg, 0.5);
});

/* ---------- form ---------- */
test("form: empty games", () => {
  const f = form([]);
  assert.deepEqual(f.recent, []);
  assert.equal(f.streak.len, 0);
});

test("form: newest-first recent + streak", () => {
  // dates ascending; form should return newest first
  const games = [
    { ...game("g1", { placement: 5 }), date: "2026-01-01" },
    { ...game("g2", { placement: 1 }), date: "2026-02-01" },
    { ...game("g3", { placement: 1 }), date: "2026-03-01" },
  ];
  const f = form(games);
  assert.deepEqual(f.recent, ["W", "W", "L"]); // newest first
  assert.deepEqual(f.streak, { type: "W", len: 2 });
});

test("form: respects n cap", () => {
  const games = Array.from({ length: 8 }, (_, i) => ({
    ...game("g" + i, { placement: 1 }),
    date: "2026-01-0" + (i + 1),
  }));
  assert.equal(form(games, 3).recent.length, 3);
});

/* ---------- pilotOverall ---------- */
test("pilotOverall: aggregates across all my games", () => {
  const games = [
    game("g1", { placement: 1, podSize: 4 }),
    game("g2", { placement: 4, podSize: 4 }),
  ];
  const p = pilotOverall(games);
  assert.equal(p.actualWR, 0.5);
  assert.equal(p.expectedWR, 0.25);
  assert.equal(p.wrVsExpected, 0.25);
});

test("pilotOverall: 0 games no NaN", () => {
  const p = pilotOverall([]);
  assert.equal(p.actualWR, null);
  assert.equal(p.wrVsExpected, null);
});

/* ---------- seatBreakdown ---------- */
test("seatBreakdown: per seat 1..5", () => {
  const games = [
    game("g1", { seat: 1, placement: 1, podSize: 4 }),
    game("g2", { seat: 1, placement: 3, podSize: 4 }),
    game("g3", { seat: 3, placement: 2, podSize: 4 }),
  ];
  const sb = seatBreakdown(games);
  assert.equal(sb[1].games, 2);
  assert.equal(sb[1].wins, 1);
  assert.equal(sb[1].avgPlace, 2);
  assert.equal(sb[3].games, 1);
  assert.equal(sb[2].games, 0);
  assert.equal(sb[2].avgPlace, null);
  assert.equal(sb[5].games, 0);
});

/* ---------- headToHead ---------- */
test("headToHead: above/below/unknown + together", () => {
  const games = [
    // me 2nd; jordi 1st (above me), miel unknown
    game("g1", {
      placement: 2,
      podSize: 4,
      opps: [
        { playerId: "jordi", placement: 1 },
        { playerId: "miel", placement: null },
      ],
    }),
    // me 1st; jordi 3rd (below me)
    game("g2", {
      placement: 1,
      podSize: 3,
      opps: [{ playerId: "jordi", placement: 3 }],
    }),
  ];
  const h = headToHead(games);
  assert.equal(h.jordi.together, 2);
  assert.equal(h.jordi.theyAboveMe, 1);
  assert.equal(h.jordi.iAboveThem, 1);
  assert.equal(h.jordi.unknown, 0);
  assert.equal(h.jordi.avgMyPlaceWhenPresent, 1.5);

  assert.equal(h.miel.together, 1);
  assert.equal(h.miel.theyAboveMe, 0);
  assert.equal(h.miel.iAboveThem, 0);
  assert.equal(h.miel.unknown, 1);
});

test("headToHead: ignores null-playerId opponents", () => {
  const g = game("g1", {
    placement: 2,
    opps: [{ playerId: null, commander: "Random", placement: 1 }],
  });
  assert.deepEqual(headToHead([g]), {});
});

/* ---------- bogeyDecks ---------- */
test("bogeyDecks: keyed by deckId or commander, above/below/unknown", () => {
  const games = [
    game("g1", {
      placement: 3,
      opps: [
        { commander: "Reyhan + Nadier", placement: 1 }, // above me
        { commander: "Jasmine Boreal", placement: null }, // unknown
      ],
    }),
    game("g2", {
      placement: 1,
      opps: [{ commander: "Reyhan + Nadier", placement: 2 }], // below me
    }),
  ];
  const b = bogeyDecks(games);
  assert.equal(b["Reyhan + Nadier"].faced, 2);
  assert.equal(b["Reyhan + Nadier"].aboveMe, 1);
  assert.equal(b["Reyhan + Nadier"].belowMe, 1);
  assert.equal(b["Reyhan + Nadier"].unknown, 0);
  assert.equal(b["Jasmine Boreal"].faced, 1);
  assert.equal(b["Jasmine Boreal"].unknown, 1);
});

test("bogeyDecks: prefers deckId as key when present", () => {
  const g = game("g1", {
    placement: 2,
    opps: [{ deckId: "d_foo", commander: "Foo", placement: 1 }],
  });
  const b = bogeyDecks([g]);
  assert.ok(b.d_foo);
  assert.equal(b.d_foo.faced, 1);
  assert.equal(b.d_foo.aboveMe, 1);
});

/* ---------- wilson ---------- */
test("wilson: 0 games -> [0,0] no NaN", () => {
  const w = wilson(0, 0);
  assert.equal(w.low, 0);
  assert.equal(w.high, 0);
});

test("wilson: interval brackets the point estimate", () => {
  const w = wilson(5, 10);
  assert.ok(w.low > 0 && w.low < 0.5);
  assert.ok(w.high > 0.5 && w.high < 1);
});

/* ---------- confidence ---------- */
test("confidence: enough + needed", () => {
  assert.deepEqual(confidence(3, 2), { enough: true, needed: 0 });
  assert.deepEqual(confidence(1, 5), { enough: false, needed: 4 });
  assert.deepEqual(confidence(0, 0), { enough: true, needed: 0 });
});

test("aggregateDeck(games, playerId): opponent finish over recorded placements only", () => {
  const games = [
    game("g1", { placement: 3, podSize: 4, opps: [{ playerId: "p", placement: 1 }] }),
    game("g2", { placement: 2, podSize: 4, opps: [{ playerId: "p", placement: 2 }] }),
    game("g3", { placement: 1, podSize: 4, opps: [{ playerId: "p" }] }), // p placement not recorded
  ];
  const a = aggregateDeck(games, "p");
  assert.equal(a.games, 3);   // appeared in 3
  assert.equal(a.scored, 2);  // finish known for 2
  assert.equal(a.wins, 1);
  assert.equal(a.actualWR, 0.5);
  assert.equal(a.avgPlace, 1.5);
  // norms: 1st->1, 2nd->2/3; avg = 5/6; finishVsAvg = 5/6 - 1/2
  assert.ok(Math.abs(a.finishVsAvg - (5 / 6 - 0.5)) < 1e-9);
});

/* ---------- real seed data smoke test ---------- */
test("aggregates real games.json without throwing", () => {
  const raw = readFileSync(join(__dirname, "../data/games.json"), "utf8");
  const games = JSON.parse(raw);
  assert.ok(games.length > 0);
  // none of these should throw on real-shaped data
  assert.ok(aggregateDeck(games).games === games.length);
  assert.ok(pilotOverall(games));
  assert.ok(seatBreakdown(games));
  assert.ok(headToHead(games)); // all opponents null-playerId here -> {}
  assert.ok(bogeyDecks(games)); // keyed by commander strings
  assert.ok(form(games));
});
