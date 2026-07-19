import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  won,
  effRank,
  placeInfo,
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
  shrunk,
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
    { ...game("g1", { placement: 5, podSize: 5 }), date: "2026-01-01" },   // real pod: 5th of 5 (placement 5 in a 1-seat game is now capped to a win)
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
    game("g2", { placement: 3, podSize: 4, opps: [{ playerId: "p", placement: 2 }] }),  // not 2/2: equal places now mean a tie
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

/* ---------- ties (competition-style storage: tied players share the start position) ---------- */
test("effRank: sole placements unchanged, tied group averages its occupied positions", () => {
  // 4-pod: 1st, then two tied after 1st (both stored 2), then 4th
  const g = game("g", {
    placement: 2, podSize: 4,
    opps: [
      { playerId: "a", placement: 1 },
      { playerId: "b", placement: 2 },   // tied with me
      { playerId: "c", placement: 4 },
    ],
  });
  assert.equal(effRank(g, "a"), 1);
  assert.equal(effRank(g, "me"), 2.5);  // occupies 2+3 -> 2.5
  assert.equal(effRank(g, "b"), 2.5);
  assert.equal(effRank(g, "c"), 4);
  assert.equal(effRank(g, "nobody"), null);
});

test("effRank: 3-way tie averages all occupied positions, pod total stays constant", () => {
  // 4-pod: I win by killing everyone at once -> 1st, then a 3-way tie for 2nd
  const g = game("g", {
    placement: 1, podSize: 4,
    opps: [
      { playerId: "a", placement: 2 },
      { playerId: "b", placement: 2 },
      { playerId: "c", placement: 2 },
    ],
  });
  assert.equal(effRank(g, "me"), 1);
  for (const pid of ["a", "b", "c"]) assert.equal(effRank(g, pid), 3);  // (2+3+4)/3
  assert.deepEqual(placeInfo(g, "a"), { start: 2, tied: true, group: 3 });
  // pod's total normalized score is unchanged by the tie: 1 + 3×(4-3)/3 = 2, same as 1+2/3+1/3+0
  const total = ["me", "a", "b", "c"].reduce((s, pid) => s + normalizedScore(effRank(g, pid), 4), 0);
  assert.ok(Math.abs(total - 2) < 1e-9);
});

test("placeInfo: start position + tied flag for display (T-labels)", () => {
  const g = game("g", {
    placement: 2, podSize: 4,
    opps: [{ playerId: "a", placement: 1 }, { playerId: "b", placement: 2 }, { playerId: "c", placement: 4 }],
  });
  assert.deepEqual(placeInfo(g, "a"), { start: 1, tied: false, group: 1 });
  assert.deepEqual(placeInfo(g, "me"), { start: 2, tied: true, group: 2 });
  assert.deepEqual(placeInfo(g, "c"), { start: 4, tied: false, group: 1 });   // 4 entered after 2-2 stays 4th
  assert.equal(placeInfo(g, "nobody").start, null);
});

test("effRank: null placement stays null", () => {
  const g = game("g", { placement: 1, opps: [{ playerId: "a", placement: null }] });
  assert.equal(effRank(g, "a"), null);
});

test("aggregateDeck: tied placements score between the occupied positions", () => {
  // me tied after 1st in a 4-pod -> eff 2.5 -> norm (4-2.5)/3 = 0.5
  const g = game("g", {
    placement: 2, podSize: 4,
    opps: [{ playerId: "a", placement: 1 }, { playerId: "b", placement: 2 }, { playerId: "c", placement: 4 }],
  });
  const a = aggregateDeck([g]);
  assert.equal(a.avgPlace, 2.5);
  assert.ok(Math.abs(a.avgNorm - 0.5) < 1e-9);
});

test("aggregateDeck: a shared 1st (draw) is not a win but still scores high", () => {
  const g = game("g", {
    placement: 1, podSize: 4,
    opps: [{ playerId: "a", placement: 1 }, { playerId: "b", placement: 3 }, { playerId: "c", placement: 4 }],
  });
  const a = aggregateDeck([g]);
  assert.equal(a.wins, 0);                       // sole 1st only
  assert.ok(Math.abs(a.avgNorm - (4 - 1.5) / 3) < 1e-9);
  const sole = aggregateDeck([game("g2", { placement: 1, podSize: 4 })]);
  assert.equal(sole.wins, 1);                    // unchanged for sole wins
});

test("form: a shared 1st is not a W", () => {
  const g = game("g", { placement: 1, podSize: 3, opps: [{ playerId: "a", placement: 1 }, { playerId: "b", placement: 3 }] });
  assert.deepEqual(form([g]).recent, ["L"]);
});

test("headToHead: tying with the rival counts as neither above nor below", () => {
  const g = game("g", {
    placement: 2, podSize: 4,
    opps: [{ playerId: "jordi", placement: 2 }, { playerId: "miel", placement: 1 }],
  });
  const h = headToHead([g]);
  assert.equal(h.jordi.together, 1);
  assert.equal(h.jordi.theyAboveMe, 0);
  assert.equal(h.jordi.iAboveThem, 0);
  assert.equal(h.jordi.ties, 1);
  assert.equal(h.miel.theyAboveMe, 1);
  assert.equal(h.miel.ties, 0);
});

test("bogeyDecks: tying counts as a tie, not belowMe", () => {
  const g = game("g", { placement: 2, opps: [{ commander: "Foo", placement: 2 }] });
  const b = bogeyDecks([g]);
  assert.equal(b.Foo.aboveMe, 0);
  assert.equal(b.Foo.belowMe, 0);
  assert.equal(b.Foo.ties, 1);
});

/* ---------- guards: null my-placement, missing me seat, impossible placements ---------- */
test("headToHead: my null placement makes the comparison unknown, not a win", () => {
  const g = game("g", { placement: null, opps: [{ playerId: "jordi", placement: 1 }] });
  const h = headToHead([g]);
  assert.equal(h.jordi.iAboveThem, 0);
  assert.equal(h.jordi.theyAboveMe, 0);
  assert.equal(h.jordi.unknown, 1);
  assert.equal(h.jordi.together, 1);
});

test("bogeyDecks: my null placement counts as unknown", () => {
  const g = game("g", { placement: null, opps: [{ commander: "Foo", placement: 1 }] });
  const b = bogeyDecks([g]);
  assert.equal(b.Foo.aboveMe, 0);
  assert.equal(b.Foo.belowMe, 0);
  assert.equal(b.Foo.unknown, 1);
});

test("games without a 'me' seat don't crash aggregations", () => {
  const noMe = { id: "gx", date: "2026-01-01", seats: [{ playerId: "a", placement: 1 }, { playerId: "b", placement: 2 }] };
  assert.doesNotThrow(() => headToHead([noMe]));
  assert.doesNotThrow(() => bogeyDecks([noMe]));
  assert.doesNotThrow(() => seatBreakdown([noMe]));
  assert.doesNotThrow(() => form([noMe]));
  assert.deepEqual(form([noMe]).recent, []);   // not scored as a loss — the game simply isn't mine
});

test("seatBreakdown: placement-less games don't pollute seat stats", () => {
  const games = [
    game("g1", { seat: 1, placement: 1, podSize: 4 }),
    game("g2", { seat: 1, placement: null, podSize: 4 }),   // logged but no finish recorded
  ];
  const sb = seatBreakdown(games);
  assert.equal(sb[1].games, 2);
  assert.equal(sb[1].avgPlace, 1);            // only the scored game
  assert.equal(sb[1].finishVsAvg, 0.5);       // no NaN / >max inflation from the null game
  assert.equal(sb[1].wins, 1);
});

test("placeInfo/effRank: impossible placements are capped at pod size (stay zero-sum)", () => {
  // editor allows all four seats set to 4th in a 4-pod
  const g = { id: "g", date: "2026-01-01", seats: [
    { playerId: "me", placement: 4 }, { playerId: "a", placement: 4 },
    { playerId: "b", placement: 4 }, { playerId: "c", placement: 4 }] };
  assert.equal(placeInfo(g, "me").start, 1);   // 4-way tie can only start at 1st
  assert.equal(effRank(g, "me"), 2.5);
  const total = ["me", "a", "b", "c"].reduce((s, pid) => s + normalizedScore(effRank(g, pid), 4), 0);
  assert.ok(Math.abs(total - 2) < 1e-9);
});

test("degenerate 1-seat game yields null rating, not NaN", () => {
  assert.equal(normalizedScore(1, 1), null);
  const solo = { id: "g", date: "2026-01-01", seats: [{ playerId: "me", deckId: "d", placement: 1 }] };
  const a = aggregateDeck([solo]);
  assert.ok(!Number.isNaN(a.avgNorm));
  assert.equal(a.avgNorm, null);   // nothing scoreable -> dash in the UI, not "NaN"
});

/* ---------- shrunk: sample-size-aware ranking score ---------- */
test("shrunk: pulls small samples toward 5.0 so 1 lucky game can't top the leaderboard", () => {
  const oneGame10 = shrunk(1.0, 1);     // 10.0 rating over 1 game
  const twelve71 = shrunk(0.71, 12);    // 7.1 rating over 12 games
  assert.ok(twelve71 > oneGame10);
  assert.equal(shrunk(null, 0), null);
  assert.ok(Math.abs(shrunk(0.8, 1000) - 0.8) < 0.01);   // converges to the raw value
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
