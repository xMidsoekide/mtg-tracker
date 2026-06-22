import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = p => readFileSync(join(root, p), "utf8");

test("manifest.json is valid and references icons that exist", () => {
  const m = JSON.parse(read("manifest.json"));
  assert.ok(m.name, "name");
  assert.equal(m.display, "standalone");        // opens chrome-less, like an app
  assert.ok(m.start_url, "start_url");
  assert.ok(m.icons?.length >= 1, "has icons");
  for (const ic of m.icons) {
    assert.ok(existsSync(join(root, ic.src)), `icon missing on disk: ${ic.src}`);
  }
});

test("service worker precaches only files that exist", () => {
  const sw = read("sw.js");
  // PRECACHE is declared as an array literal; pull the entries out and check each.
  const block = sw.match(/PRECACHE\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(block, "PRECACHE array found in sw.js");
  const assets = [...block[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map(m => m[1]);
  assert.ok(assets.length > 0, "precache is non-empty");
  for (const a of assets) {
    const rel = a === "." || a === "./" ? "index.html" : a.replace(/^\.?\//, "");
    assert.ok(existsSync(join(root, rel)), `precached asset missing on disk: ${a}`);
  }
});

test("index.html wires up the PWA (manifest + apple meta + SW registration)", () => {
  const html = read("index.html");
  assert.match(html, /<link[^>]+rel=["']manifest["']/, "manifest link");
  assert.match(html, /apple-mobile-web-app-capable/, "iOS standalone meta");
  assert.match(html, /apple-touch-icon/, "iOS home-screen icon");
  assert.match(html, /serviceWorker/, "registers a service worker");
});
