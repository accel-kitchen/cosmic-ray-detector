'use strict';
// The static pages: strict CSP, no inline code anywhere, nothing that turns text into HTML,
// nothing loaded from outside, and no way to read files outside public/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');
const htmlFiles = () => fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
const jsFiles = () => fs.readdirSync(path.join(PUBLIC, 'js')).filter((f) => f.endsWith('.js'));

test('pages: no inline script, no inline style, no event-handler attributes, nothing from outside', () => {
  assert.ok(htmlFiles().length >= 2);
  for (const f of htmlFiles()) {
    const html = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
      assert.match(m[1], /\bsrc="\/(js|vendor)\//, `${f}: <script> must load one of our own files`);
    }
    assert.equal(/<style\b/i.test(html), false, `${f}: no <style> element (CSP style-src 'self')`);
    assert.equal(/\sstyle\s*=/i.test(html), false, `${f}: no style attribute`);
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, `${f}: no on...= handler attribute`);
    assert.equal(/javascript:/i.test(html), false, `${f}: no javascript: URL`);
    for (const m of html.matchAll(/<(?:script|link|img|iframe|form)\b[^>]*\b(?:src|href|action)="([^"]+)"/gi)) {
      assert.equal(/^(https?:)?\/\//i.test(m[1]), false, `${f}: ${m[1]} would load something from outside`);
    }
    assert.match(html, /<html lang="ja">/, `${f}: language set`);
    assert.match(html, /<meta name="viewport"/, `${f}: usable on a phone`);
  }
});

test('pages: our scripts never turn text into HTML and never run strings as code', () => {
  for (const f of jsFiles()) {
    const src = fs.readFileSync(path.join(PUBLIC, 'js', f), 'utf8');
    assert.equal(/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(|\.outerHTML\s*=/.test(src), false, `${f}`);
    assert.equal(/localStorage/.test(src), false, `${f}: the session stays in sessionStorage (this tab only)`);
  }
});

test('pages: served with a strict CSP and no third-party host by default', async () => {
  const t = await boot();
  try {
    for (const p of ['/', '/station', '/index.html']) {
      const res = await fetch(t.base + p);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get('content-type'), /text\/html/);
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'self'(;|$)/);
      assert.match(csp, /style-src 'self'(;|$)/);
      assert.match(csp, /connect-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /img-src 'self' data:(;|$)/, 'no map-tile host unless the operator chose one');
      assert.equal(/unsafe-inline|unsafe-eval|\*/.test(csp), false);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('referrer-policy'), /strict-origin-when-cross-origin/);
    }
    // static files
    const js = await fetch(t.base + '/js/common.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    const lf = await fetch(t.base + '/vendor/leaflet/leaflet.js');
    assert.equal(lf.status, 200);
    assert.match(lf.headers.get('cache-control'), /max-age/);
    assert.equal((await fetch(t.base + '/vendor/leaflet/LICENSE')).status, 200, 'the licence ships with the library');
    // the API still answers JSON and the unknown path still 404s as JSON
    assert.equal((await t.call('GET', '/healthz')).status, 200);
    const nf = await t.call('GET', '/no/such/thing');
    assert.equal(nf.status, 404);
    assert.equal(nf.json.error, 'Not found');
  } finally { await t.close(); }
});

test('pages: the chosen map-tile host (and only that one) is allowed for images', async () => {
  const g = await boot({ mapTile: 'gsi' });
  try {
    const csp = (await fetch(g.base + '/')).headers.get('content-security-policy');
    assert.match(csp, /img-src 'self' data: https:\/\/cyberjapandata\.gsi\.go\.jp(;|$)/);
    assert.equal(/openstreetmap/.test(csp), false);
  } finally { await g.close(); }
  const o = await boot({ mapTile: 'osm' });
  try {
    const csp = (await fetch(o.base + '/')).headers.get('content-security-policy');
    assert.match(csp, /img-src 'self' data: https:\/\/tile\.openstreetmap\.org(;|$)/);
  } finally { await o.close(); }
});

test('pages: files outside public/ cannot be read through the static handler', async () => {
  const t = await boot();
  try {
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/js/..%2f..%2fpackage.json', '/..%2fsrc%2fapp.js',
                     '/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/.git/config', '/.env', '/js/%2e%2e/%2e%2e/package.json']) {
      const res = await fetch(t.base + p);
      const body = await res.text();
      assert.notEqual(res.status, 200, p);
      assert.equal(body.includes('cosmicray-v3-server') || body.includes('createApp') || body.includes('root:'), false, p);
    }
  } finally { await t.close(); }
});

test('pages: the map and graph pages use only the API endpoints that exist', () => {
  const used = new Set();
  for (const f of jsFiles()) {
    const src = fs.readFileSync(path.join(PUBLIC, 'js', f), 'utf8');
    for (const m of src.matchAll(/api\(\s*['"`]([^'"`?$]+)/g)) used.add(m[1].replace(/\/$/, ''));
  }
  const known = ['/public/stations', '/stations', '/auth/login', '/auth/register', '/auth/verify-email', '/auth/forgot', '/auth/reset',
                 '/auth/resend-verify', '/me', '/me/profile', '/me/password', '/me/delete', '/me/export', '/me/events'];
  for (const u of used) assert.ok(known.some((k) => u === k || u.startsWith(k)), `unknown endpoint used by a page: ${u}`);
});
