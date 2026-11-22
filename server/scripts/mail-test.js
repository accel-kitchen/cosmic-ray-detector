'use strict';
// Sends ONE test message with the mail settings the server itself uses, so that delivery can be checked
// before registration is opened. It prints what it used, never the password.
//
//   sudo -u cosmicray bash -c 'cd /opt/cosmicray-v3/current && /opt/node-v22.23.4/bin/node --env-file=/etc/cosmicray/env scripts/mail-test.js you@example.org'
//
// (Do not `source` the env file in a shell: MAIL_FROM contains "<...>", which the shell reads as a redirect.)
//
// It does not touch the database and does not count against the daily mail budget.
const { loadConfig } = require('../src/config');
const { createMailer } = require('../src/mailer');

async function main() {
  const to = process.argv[2];
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { console.error('usage: mail-test.js <address>'); process.exit(2); }
  const cfg = loadConfig(process.env, { quiet: true });
  const m = cfg.mail;
  console.log(`transport=${m.transport} host=${m.smtp.host} port=${m.smtp.port} secure=${m.smtp.secure} user=${m.smtp.user ? m.smtp.user : '(none)'} from=${m.from}`);
  if (m.transport !== 'smtp') { console.error('MAIL_TRANSPORT is not "smtp": nothing was sent'); process.exit(1); }
  const mailer = createMailer(cfg);
  const info = await mailer.send({
    to,
    subject: '【CosmicRay】メール送信の試験',
    text: 'これは、CosmicRay 観測ネットワークのサーバーからの、送信の試験です。\nこのメールに心当たりがなければ、無視してください。\n',
  });
  console.log(`sent: ${info && info.response ? info.response : 'ok'}`);
  if (info && info.rejected && info.rejected.length) { console.error('REJECTED:', info.rejected.join(', ')); process.exit(1); }
}
main().catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
