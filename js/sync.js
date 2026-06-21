/* Cloud sync via a private GitHub Gist holding one JSON file.
   The token lives ONLY in localStorage (never inside the synced data, so it
   never gets pushed to the gist). A fine-grained PAT with just the Gist
   permission is enough. Same token on any device auto-finds the gist. */

const CFG_KEY = "mtg-sync-cfg";
const FILE = "mtg-tracker.json";
const API = "https://api.github.com";

let cfg = {};
try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch { cfg = {}; }
const save = () => localStorage.setItem(CFG_KEY, JSON.stringify(cfg));

export const hasToken = () => !!cfg.token;
export const isConfigured = () => !!cfg.token && !!cfg.gistId;
export const getConfig = () => ({ gistId: cfg.gistId || null, lastSync: cfg.lastSync || null, hasToken: !!cfg.token });
export const setToken = t => { cfg.token = (t || "").trim() || null; if (!cfg.token) cfg.gistId = null; save(); };
export const disconnect = () => { cfg = {}; save(); };

const headers = () => ({ Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" });

async function req(url, opts = {}) {
  // no-store + cache-bust: GitHub API responses are otherwise cached by the
  // browser for ~60s, which makes a fresh pull return stale data.
  const u = url + (url.includes("?") ? "&" : "?") + "_=" + Date.now();
  const r = await fetch(u, { ...opts, cache: "no-store", headers: { ...headers(), "Cache-Control": "no-cache" } });
  if (r.status === 401 || r.status === 403) throw new Error("Token rejected — check it has the Gist permission");
  if (!r.ok) throw new Error(`GitHub error ${r.status}`);
  return r;
}

async function createGist(content) {
  const r = await req(`${API}/gists`, {
    method: "POST",
    body: JSON.stringify({ description: "MTG Commander Tracker data", public: false, files: { [FILE]: { content } } }),
  });
  const j = await r.json();
  cfg.gistId = j.id; save();
  return j.id;
}

/* find an existing tracker gist for this token, else null */
async function findGist() {
  const r = await req(`${API}/gists?per_page=100`);
  const list = await r.json();
  const found = (list || []).find(g => g.files && g.files[FILE]);
  return found ? found.id : null;
}

/* connect a device: reuse the existing gist if the token already has one, else create it */
export async function connect(content) {
  if (!cfg.token) throw new Error("No token");
  cfg.gistId = (await findGist()) || (await createGist(content));
  save();
  return cfg.gistId;
}

export async function push(content) {
  if (!cfg.gistId) return createGist(content);
  await req(`${API}/gists/${cfg.gistId}`, { method: "PATCH", body: JSON.stringify({ files: { [FILE]: { content } } }) });
  cfg.lastSync = new Date().toISOString(); save();
}

export async function pull() {
  if (!cfg.gistId) return null;
  const r = await req(`${API}/gists/${cfg.gistId}`);
  const j = await r.json();
  const f = j.files?.[FILE];
  if (!f) return null;
  const text = f.truncated && f.raw_url ? await (await fetch(f.raw_url)).text() : f.content;
  cfg.lastSync = new Date().toISOString(); save();
  return JSON.parse(text);
}
