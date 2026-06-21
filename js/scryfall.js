/* Thin Scryfall client. Card data only (names, art, color identity, partner-ability).
   Results are cached in localStorage so the app works offline after first lookup.
   Every call fails soft (returns [] / null) so logging never breaks on bad wifi. */

const BASE = "https://api.scryfall.com";
const CACHE_KEY = "mtg-scry-cache-v1";
let cache = {};
try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch { cache = {}; }
const saveCache = () => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {} };

export const CI_ORDER = ["W", "U", "B", "R", "G"];
export const mergeCI = (...lists) => CI_ORDER.filter(c => lists.flat().includes(c));

/* raw name completions (any card) */
export async function autocomplete(q) {
  if (!q || q.trim().length < 2) return [];
  try {
    const r = await fetch(`${BASE}/cards/autocomplete?q=${encodeURIComponent(q)}`);
    const j = await r.json();
    return j.data || [];
  } catch { return []; }
}

/* completions limited to cards that can actually be a commander */
export async function commanderAutocomplete(q) {
  if (!q || q.trim().length < 2) return [];
  try {
    const r = await fetch(`${BASE}/cards/search?q=${encodeURIComponent(`is:commander ${q}`)}&order=name&unique=cards`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data || []).slice(0, 15).map(c => c.name);
  } catch { return []; }
}

function parse(c) {
  const art = c.image_uris?.art_crop || c.card_faces?.[0]?.image_uris?.art_crop || null;
  const oracle = c.oracle_text || (c.card_faces || []).map(f => f.oracle_text || "").join("\n");
  return { name: c.name, art, ci: c.color_identity || [], typeLine: c.type_line || "", oracle,
    keywords: c.keywords || [], second: secondKind(c.type_line || "", oracle, c.keywords || []) };
}

/* full card by exact name, cached */
export async function getCard(name) {
  if (!name) return null;
  const key = name.toLowerCase();
  if (cache[key]) return cache[key];
  try {
    const r = await fetch(`${BASE}/cards/named?exact=${encodeURIComponent(name)}`);
    if (!r.ok) return null;
    const info = parse(await r.json());
    cache[key] = info; saveCache();
    return info;
  } catch { return null; }
}

/* what kind of second card (if any) this commander can pair with */
export function secondKind(typeLine, oracle, keywords) {
  const o = (oracle || "").toLowerCase();
  const t = (typeLine || "").toLowerCase();
  const kw = (keywords || []).map(k => k.toLowerCase());
  const pw = o.match(/partner with ([^\n.(]+)/);
  if (pw) return { type: "partnerWith", name: pw[1].trim().replace(/\s+and\s+/i, " and ") };
  if (o.includes("choose a background")) return { type: "background" };
  if (o.includes("friends forever")) return { type: "friends" };
  if (o.includes("doctor's companion")) return { type: "companion" };  // pairs with a Time Lord Doctor
  if (t.includes("time lord doctor")) return { type: "doctor" };       // pairs with a companion
  if (kw.includes("partner") || /\bpartner\b/.test(o)) return { type: "partner" };
  return null;
}

/* constrained name search for the second card */
const SCOPE_FILTER = {
  background: "type:background",
  partner: "keyword:partner",
  friends: 'oracle:"friends forever"',
  companion: "type:'time lord doctor'",      // a companion pairs with a Doctor
  doctor: "oracle:\"doctor's companion\"",   // a Doctor pairs with a companion
};
export async function searchSecond(q, scope) {
  const filter = SCOPE_FILTER[scope?.type] || "";
  if (!filter) return autocomplete(q);
  try {
    const r = await fetch(`${BASE}/cards/search?q=${encodeURIComponent(`${filter} ${q || ""}`)}&order=name&unique=cards`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data || []).slice(0, 15).map(c => c.name);
  } catch { return []; }
}
