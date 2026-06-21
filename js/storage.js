/* Single source of truth = one JSON blob in localStorage.
   Seeded once from data/*.json. Everything is sync in-memory after load();
   persistence to localStorage is immediate, gist sync (sync.js) is opt-in and async. */

const KEY = "mtg-tracker-v3";
let state = null;   // { players, decks, games, settings, updatedAt }

const clone = x => JSON.parse(JSON.stringify(x));

async function seed() {
  const [players, decks, games] = await Promise.all(
    ["players", "decks", "games"].map(n => fetch(`data/${n}.json`).then(r => r.json()))
  );
  return { players, decks, games, settings: { minGames: 2 }, updatedAt: null };
}

export async function load() {
  const raw = localStorage.getItem(KEY);
  if (raw) { state = JSON.parse(raw); }
  else { state = await seed(); persist(); }
  return state;
}

function persist() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

/* mutate via a callback so every write stamps updatedAt + persists once */
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
export const addGame    = g => commit(s => s.games.push(g));
export const updateGame = (id, patch) => commit(s => {
  const i = s.games.findIndex(g => g.id === id);
  if (i >= 0) s.games[i] = { ...s.games[i], ...patch };
});
export const deleteGame = id => commit(s => { s.games = s.games.filter(g => g.id !== id); });

export const addDeck = d => commit(s => s.decks.push(d));
export const updateDeck = (id, patch) => commit(s => {
  const i = s.decks.findIndex(d => d.id === id);
  if (i >= 0) s.decks[i] = { ...s.decks[i], ...patch };
});
export const deleteDeck = id => commit(s => { s.decks = s.decks.filter(d => d.id !== id); });
export const gamesForDeck = id => state.games.filter(g => g.seats.some(se => se.playerId === "me" && se.deckId === id));
export const addPlayer = p => commit(s => s.players.push(p));
export const setSetting = (k, v) => commit(s => { s.settings[k] = v; });

/* ensure a deck exists for an opponent (player + commander identity); returns its id.
   extra = { commander2, art, art2, ci, theme } from Scryfall, merged in when known. */
export const ensureDeck = (ownerId, commander, extra = {}) => {
  const found = state.decks.find(d =>
    d.commander.toLowerCase() === commander.toLowerCase() &&
    (d.commander2 || "").toLowerCase() === (extra.commander2 || "").toLowerCase() &&
    (ownerId == null || d.ownerId === ownerId));
  if (found) {                       // backfill art/ci if we learned them later
    commit(s => { const d = s.decks.find(x => x.id === found.id); Object.assign(d, clean(extra)); });
    return found.id;
  }
  const id = "d_" + commander.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) + "_" + state.decks.length;
  commit(s => s.decks.push({ id, ownerId, commander, commander2: null, art: null, art2: null, ci: [], theme: "", ...clean(extra) }));
  return id;
};
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

/* ---- bulk replace (used by import + gist pull) ---- */
export const replaceAll = next => commit(s => {
  s.players = next.players; s.decks = next.decks; s.games = next.games;
  if (next.settings) s.settings = next.settings;
});

/* id helper — no Date.now reliance for determinism in tests is irrelevant here (UI only) */
export const newId = prefix => `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random()*1e4)}`;

/* export/import for manual backup */
export const exportJson = () => JSON.stringify(getState(), null, 2);
export const importJson = text => { replaceAll(JSON.parse(text)); };

/* ---- active (live) game — kept separate from synced state, local only ---- */
const ACTIVE_KEY = "mtg-tracker-active";
export const getActive = () => { const r = localStorage.getItem(ACTIVE_KEY); return r ? JSON.parse(r) : null; };
export const setActive = g => localStorage.setItem(ACTIVE_KEY, JSON.stringify(g));
export const clearActive = () => localStorage.removeItem(ACTIVE_KEY);
