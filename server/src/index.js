'use strict';
const { loadConfig } = require('./config');
const { createApp } = require('./app');

async function main() {
  const cfg = loadConfig();
  const { app, close } = await createApp(cfg);

  // Bound to the loopback by default: the outside world reaches this process
  // only through the Apache reverse proxy (see the plan, section 3).
  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`cosmicray-v3 ${cfg.version} (${cfg.commit}) listening on http://${cfg.host}:${cfg.port}`);
  });

  const stop = () => server.close(() => { close(); process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
