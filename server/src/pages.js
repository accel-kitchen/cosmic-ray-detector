'use strict';
const path = require('path');
const express = require('express');
const { TILES } = require('./routes-public');

// Serves the static pages in public/ with a strict Content-Security-Policy.
//
//  - script-src 'self'  : only our own files run. There is no inline script anywhere, so a
//                         stored-text mistake (an owner's introduction) cannot become a script.
//  - style-src 'self'   : no inline style attributes either (the pages use classes).
//  - img-src            : our own files, data: URLs, and the one map-tile host the operator chose.
//  - connect-src 'self' : the pages talk to this server only.
// The libraries (Leaflet) are vendored under public/vendor, so no page loads code from a CDN.
function register(app, ctx) {
  const { cfg } = ctx;
  const root = path.join(__dirname, '..', 'public');
  const tile = TILES[cfg.mapTile];

  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' data:${tile ? ' ' + tile.host : ''}`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');

  function pageHeaders(res) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Frame-Options', 'DENY');
    // Cross-origin requests (map tiles) carry only the origin: some providers require a Referer.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cache-Control', 'no-cache');
  }

  app.get('/', (req, res) => { pageHeaders(res); res.sendFile(path.join(root, 'index.html')); });

  app.use(express.static(root, {
    index: false,
    extensions: ['html'],            // /account -> account.html (the mailed links are clean URLs)
    dotfiles: 'ignore',
    setHeaders(res, file) {
      if (file.endsWith('.html')) pageHeaders(res);
      if (file.endsWith('admin.html')) res.setHeader('X-Robots-Tag', 'noindex');     // the operator page is not for search engines
      else if (/[\\/]vendor[\\/]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=86400');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  }));
}

module.exports = { register };
