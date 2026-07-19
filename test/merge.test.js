import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeById, mergeStates, syncSig } from "../js/merge.js";
import { validateState, migrate } from "../js/storage.js";

/* ---------- mergeById: per-record recency ---------- */
test("mergeById: disjoint ids union", () => {
  const out = mergeById([{ id: "a" }], [{ id: "b" }]);
  assert.deepEqual(out.map(x => x.id).sort(), ["a", "b"]);
});

test("mergeById: on collision the record with the newer per-record stamp wins, regardless of side", () => {
  const mine = { id: "g1", note: "mine", m: "2026-07-01T00:00:00Z" };
  const theirs = { id: "g1", note: "theirs", m: "2026-07-15T00:00:00Z" };
  assert.equal(mergeById([mine], [theirs]).find(x => x.id === "g1").note, "theirs");
  assert.equal(mergeById([theirs], [mine]).find(x => x.id === "g1").note, "theirs");
});

test("mergeById: unstamped collision falls back to the preferred (first-arg) copy", () => {
  const out = mergeById([{ id: "g1", note: "preferred" }], [{ id: "g1", note: "other" }]);
  assert.equal(out[0].note, "preferred");
});

test("mergeById: a stamped record beats an unstamped one", () => {
  const out = mergeById([{ id: "g1", note: "unstamped" }], [{ id: "g1", note: "stamped", m: "2026-01-01" }]);
  assert.equal(out[0].note, "stamped");
});

/* ---------- mergeStates: edits survive regardless of whole-state age ---------- */
test("mergeStates: a per-record edit on the OLDER state survives the merge", () => {
  // A edits game X at t1; B logs game Y at t2 (B's whole state is newer).
  const A = { updatedAt: "2026-07-10", players: [], decks: [],
    games: [{ id: "x", note: "edited", m: "2026-07-10" }], deleted: { games: [], decks: [] } };
  const B = { updatedAt: "2026-07-12", players: [], decks: [],
    games: [{ id: "x", note: "stale", m: "2026-07-01" }, { id: "y", m: "2026-07-12" }], deleted: { games: [], decks: [] } };
  const out = mergeStates(A, B);
  assert.equal(out.games.find(g => g.id === "x").note, "edited");   // A's edit wins by record stamp
  assert.ok(out.games.find(g => g.id === "y"));                     // B's new game survives
});

test("mergeStates: deck tombstones propagate (no resurrection)", () => {
  const A = { updatedAt: "2026-07-10", players: [], decks: [], games: [],
    deleted: { games: [], decks: ["d_gone"] } };
  const B = { updatedAt: "2026-07-01", players: [], decks: [{ id: "d_gone" }, { id: "d_keep" }], games: [],
    deleted: { games: [], decks: [] } };
  const out = mergeStates(A, B);
  assert.deepEqual(out.decks.map(d => d.id), ["d_keep"]);
  assert.deepEqual(out.deleted.decks, ["d_gone"]);
});

test("mergeStates: legacy array-shaped `deleted` (game tombstones) still works", () => {
  const A = { updatedAt: "2026-07-10", players: [], decks: [], games: [{ id: "g2" }], deleted: ["g1"] };
  const B = { updatedAt: "2026-07-01", players: [], decks: [], games: [{ id: "g1" }, { id: "g2" }], deleted: [] };
  const out = mergeStates(A, B);
  assert.deepEqual(out.games.map(g => g.id), ["g2"]);
  assert.deepEqual(out.deleted, { games: ["g1"], decks: [] });
});

test("syncSig: differs when deck tombstones differ", () => {
  const a = { games: [], decks: [], deleted: { games: [], decks: [] } };
  const b = { games: [], decks: [], deleted: { games: [], decks: ["d1"] } };
  assert.notEqual(syncSig(a), syncSig(b));
});

/* ---------- validateState / migrate ---------- */
test("validateState: rejects junk before it can wipe state", () => {
  assert.throws(() => validateState(null));
  assert.throws(() => validateState({ foo: 1 }));
  assert.throws(() => validateState({ players: [], decks: [], games: [{ id: "g" }] }));  // game missing date/seats
  const ok = { players: [], decks: [], games: [{ id: "g", date: "2026-01-01", seats: [] }] };
  assert.equal(validateState(ok), ok);
});

test("migrate: legacy deleted array becomes {games, decks} and stamps schemaVersion", () => {
  const s = migrate({ players: [], decks: [], games: [], deleted: ["g1"] });
  assert.deepEqual(s.deleted, { games: ["g1"], decks: [] });
  assert.ok(s.schemaVersion >= 4);
  // idempotent
  const again = migrate(s);
  assert.deepEqual(again.deleted, { games: ["g1"], decks: [] });
});

/* ---------- PRECACHE completeness (regression guard for offline) ---------- */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

test("sw.js PRECACHE lists every js module (forgetting one silently breaks offline)", () => {
  const sw = readFileSync(join(__dirname, "../sw.js"), "utf8");
  for (const f of readdirSync(join(__dirname, "../js"))) {
    assert.ok(sw.includes(`"js/${f}"`), `js/${f} missing from sw.js PRECACHE`);
  }
});
