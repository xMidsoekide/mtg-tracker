/* merge.js — pure cross-device merge logic for gist sync (no DOM, node-testable).
   Records (games/decks/players) carry a per-record modified stamp `m` (set by storage.js
   writes). Merging is per-record by that stamp — NOT by whole-state updatedAt, which
   silently reverted device A's edit whenever device B had touched anything more recently.
   Tombstones: `deleted` is {games: [ids], decks: [ids]} (legacy plain array = game ids). */

/* union by id; on a collision the record with the newer `m` wins.
   Unstamped ties fall back to the preferred (first-arg) copy. */
export function mergeById(preferred, other) {
  const m = new Map();
  for (const x of other) m.set(x.id, x);
  for (const x of preferred) {
    const o = m.get(x.id);
    m.set(x.id, o && (o.m || "") > (x.m || "") ? o : x);
  }
  return [...m.values()];
}

/* normalize a state's tombstones to {games, decks} regardless of schema age */
const tombs = s => Array.isArray(s?.deleted)
  ? { games: s.deleted, decks: [] }
  : { games: s?.deleted?.games || [], decks: s?.deleted?.decks || [] };

export function mergeStates(local, remote) {
  const localNewer = (local.updatedAt || "") >= (remote.updatedAt || "");
  const w = localNewer ? local : remote, l = localNewer ? remote : local;
  const tl = tombs(local), tr = tombs(remote);
  const deleted = {
    games: [...new Set([...tl.games, ...tr.games])],
    decks: [...new Set([...tl.decks, ...tr.decks])],
  };
  const delGames = new Set(deleted.games), delDecks = new Set(deleted.decks);
  return {
    players: mergeById(w.players || [], l.players || []),
    decks:   mergeById(w.decks   || [], l.decks   || []).filter(d => !delDecks.has(d.id)),
    games:   mergeById(w.games   || [], l.games   || []).filter(g => !delGames.has(g.id)),
    deleted,
    settings: w.settings || l.settings,
  };
}

/* signature of what's worth syncing — game ids, deck ids, and both tombstone sets */
export const syncSig = s => {
  const t = tombs(s);
  return JSON.stringify([
    (s.games || []).map(g => g.id).sort(),
    (s.decks || []).map(d => d.id).sort(),
    t.games.slice().sort(),
    t.decks.slice().sort(),
  ]);
};
