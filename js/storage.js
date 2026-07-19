/* Single source of truth = one JSON blob in localStorage.
   Seeded once from data/*.json. Everything is sync in-memory after load();
   persistence to localStorage is immediate, gist sync (sync.js) is opt-in and async.
   Records carry a per-record modified stamp `m` so cross-device merge (merge.js) can
   resolve collisions per record instead of per whole-state. */

const KEY = "mtg-tracker-v3";
const SCHEMA = 4;
let state = null;   // { schemaVersion, players, decks, games, deleted:{games,decks}, settings, updatedAt }

const clone = x => JSON.parse(JSON.stringify(x));

async function seed() {
  const [players, decks, games] = await Promise.all(
    ["players", "decks", "games"].map(n => fetch(`data/${n}.json`).then(r => r.json()))
  );
  return migrate({ players, decks, games, deleted: { games: [], decks: [] }, settings: { minGames: 2 }, updatedAt: null });
}

/* schema upgrades, idempotent — run on every load and on every imported/pulled state.
   v4: `deleted` grows from a plain array of game ids to {games, decks}. */
export function migrate(s) {
  if (Array.isArray(s.deleted)) s.deleted = { games: s.deleted, decks: [] };
  s.deleted ??= { games: [], decks: [] };
  s.deleted.games ??= []; s.deleted.decks ??= [];
  s.schemaVersion = SCHEMA;
  return s;
}

/* shape guard for anything arriving from outside (import box, gist pull) — a wrong paste
   must throw here, not persist a state that crashes every render and syncs the damage. */
export function validateState(x) {
  const arr = k => Array.isArray(x?.[k]);
  if (!x || typeof x !== "object" || !arr("players") || !arr("decks") || !arr("games"))
    throw new Error("Not tracker data — players/decks/games arrays missing");
  for (const g of x.games)
    if (g.id == null || !g.date || !Array.isArray(g.seats))
      throw new Error("Tracker data contains a malformed game");
  return x;
}

export async function load() {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    try { state = migrate(JSON.parse(raw)); }
    catch {
      // corrupted blob: park it for forensics instead of rendering a permanently blank app
      localStorage.setItem(KEY + "-corrupt", raw);
      state = await seed(); persist();
    }
  } else { state = await seed(); persist(); }
  // one-time cleanup: drop the old demo games (their ids start with "mg").
  // bumping updatedAt makes the cleaned data win the next gist sync.
  const before = state.games.length;
  state.games = dropDemo(state.games);
  if (state.games.length !== before) { state.updatedAt = new Date().toISOString(); }
  persist();
  return state;
}

const dropDemo = games => games.filter(g => !String(g.id).startsWith("mg"));

function persist() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

/* mutate via a callback so every write stamps updatedAt + persists once.
   `stamp(record)` marks the records a write touched, for per-record merge. */
const stamp = r => { if (r) r.m = new Date().toISOString(); return r; };
function commit(fn) {
  fn(state);
  state.updatedAt = new Date().toISOString();
  persist();
  return state;
}

/* ---- reads (return clones so callers can't mutate state directly) ---- */
export const getState = () => clone(state);
export const players   = () => clone(state.players);
export const decks     = () => clone(state.decks);
export const games     = () => clone(state.games);
export const settings  = () => clone(state.settings);

export const deckById   = id => state.decks.find(d => d.id === id) || null;
export const playerById = id => state.players.find(p => p.id === id) || null;
export const myDecks    = () => state.decks.filter(d => d.ownerId === "me");

/* ---- writes ---- */
export const addGame    = g => commit(s => s.games.push(stamp(g)));
export const updateGame = (id, patch) => commit(s => {
  const i = s.games.findIndex(g => g.id === id);
  if (i >= 0) s.games[i] = stamp({ ...s.games[i], ...patch });
});
export const deleteGame = id => commit(s => {
  s.games = s.games.filter(g => g.id !== id);
  s.deleted.games.push(id);   // tombstone so the deletion syncs to other devices
});

export const addDeck = d => commit(s => s.decks.push(stamp(d)));
export const updateDeck = (id, patch) => commit(s => {
  const i = s.decks.findIndex(d => d.id === id);
  if (i >= 0) s.decks[i] = stamp({ ...s.decks[i], ...patch });
});
export const deleteDeck = id => commit(s => {
  s.decks = s.decks.filter(d => d.id !== id);
  s.deleted.decks.push(id);   // tombstone — without it the deck resurrects from other devices
});
export const gamesForDeck = id => state.games.filter(g => g.seats.some(se => se.playerId === "me" && se.deckId === id));
export const addPlayer = p => commit(s => s.players.push(stamp(p)));
export const setSetting = (k, v) => commit(s => { s.settings[k] = v; });

/* deck ids: random suffix — the old `decks.length` suffix was reused after a delete,
   giving two decks the same id (deckById then returns the wrong one; merge drops one) */
export const newDeckId = commander =>
  "d_" + commander.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) + "_" + Math.random().toString(36).slice(2, 7);

/* ensure a deck exists for an opponent (player + commander identity); returns its id.
   extra = { commander2, art, art2, ci, theme } from Scryfall, merged in when known. */
export const ensureDeck = (ownerId, commander, extra = {}) => {
  const found = state.decks.find(d =>
    d.commander.toLowerCase() === commander.toLowerCase() &&
    (d.commander2 || "").toLowerCase() === (extra.commander2 || "").toLowerCase() &&
    (ownerId == null || d.ownerId === ownerId));
  if (found) {                       // backfill art/ci if we learned them later
    commit(s => { const d = s.decks.find(x => x.id === found.id); stamp(Object.assign(d, clean(extra))); });
    return found.id;
  }
  const id = newDeckId(commander);
  commit(s => s.decks.push(stamp({ id, ownerId, commander, commander2: null, art: null, art2: null, ci: [], theme: "", ...clean(extra) })));
  return id;
};
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

/* ---- bulk replace (used by import + gist pull); caller validates first ---- */
export const replaceAll = next => commit(s => {
  const n = migrate(next);
  s.players = n.players; s.decks = n.decks; s.games = dropDemo(n.games);
  s.deleted = n.deleted;
  if (n.settings) s.settings = n.settings;
});

/* id helper — no Date.now reliance for determinism in tests is irrelevant here (UI only) */
export const newId = prefix => `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random()*1e4)}`;

/* export/import for manual backup */
export const exportJson = () => JSON.stringify(getState(), null, 2);
export const importJson = text => { replaceAll(validateState(JSON.parse(text))); };

/* ---- active (live) game — kept separate from synced state, local only ---- */
const ACTIVE_KEY = "mtg-tracker-active";
export const getActive = () => { const r = localStorage.getItem(ACTIVE_KEY); return r ? JSON.parse(r) : null; };
export const setActive = g => localStorage.setItem(ACTIVE_KEY, JSON.stringify(g));
export const clearActive = () => localStorage.removeItem(ACTIVE_KEY);
