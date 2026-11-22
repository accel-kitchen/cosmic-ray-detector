'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// How mail leaves the server. Everything that sends mail goes through send({ to, subject, text }),
// so which route it takes (a Postfix on this machine, Google Workspace, an outside service) is a
// configuration choice made later (plan, Q-N1), not a code change.
//
//   smtp    a real SMTP server (nodemailer). The password lives only in /etc/cosmicray/env.
//   outbox  writes each message as a JSON file under DATA_DIR/outbox. For development and tests;
//           loadConfig refuses it together with an open registration in production.
//   none    sending fails. Registration cannot be opened while this is selected.
//
// Plain text only, no tracking, no images.
function createMailer(cfg, deps = {}) {
  const t = cfg.mail.transport;

  if (t === 'smtp') {
    const createTransport = deps.createTransport || require('nodemailer').createTransport;
    const s = cfg.mail.smtp;
    const transporter = createTransport({
      host: s.host, port: s.port, secure: s.secure,
      // Port 587 starts in plain text and upgrades with STARTTLS. Without this, nodemailer would carry on
      // in plain text (password included) if the upgrade were stripped. Only a server on this machine may skip it.
      requireTLS: !s.secure && !['localhost', '127.0.0.1', '::1'].includes(s.host),
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    });
    return {
      transport: 'smtp',
      async send({ to, subject, text }) {
        return transporter.sendMail({ from: cfg.mail.from, to, subject, text });
      },
    };
  }

  if (t === 'outbox') {
    const dir = path.join(cfg.dataDir, 'outbox');
    return {
      transport: 'outbox',
      dir,
      async send({ to, subject, text }) {
        fs.mkdirSync(dir, { recursive: true });
        const name = `${String(Date.now()).padStart(15, '0')}-${crypto.randomBytes(4).toString('hex')}.json`;
        fs.writeFileSync(path.join(dir, name), JSON.stringify({ from: cfg.mail.from, to, subject, text }, null, 2), { mode: 0o600 });
      },
    };
  }

  return {
    transport: 'none',
    async send() { throw new Error('mail is not configured (MAIL_TRANSPORT=none)'); },
  };
}

module.exports = { createMailer };
