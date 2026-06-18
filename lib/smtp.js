// Minimal zero-dependency SMTP client over implicit TLS (port 465).
// Enough to send a single multipart email with one attachment via Gmail
// (use a Google App Password as the password).
const tls = require('tls');

function sendMail(opts) {
  // opts: { host, port=465, user, pass, from, to, subject, text, attachment:{filename, content(Buffer), contentType} }
  return new Promise((resolve, reject) => {
    const host = opts.host || 'smtp.gmail.com';
    const port = opts.port || 465;
    const socket = tls.connect({ host, port, servername: host }, () => {});
    socket.setEncoding('utf8');
    socket.setTimeout(20000, () => { socket.destroy(); reject(new Error('SMTP timeout')); });

    let step = 0;
    let buf = '';
    const boundary = 'b_' + Buffer.from(opts.subject || 'x').toString('hex').slice(0, 12);
    const to = Array.isArray(opts.to) ? opts.to : [opts.to];

    const body = buildMime(opts, boundary);
    const cmds = [
      `EHLO localhost\r\n`,
      `AUTH LOGIN\r\n`,
      Buffer.from(opts.user).toString('base64') + '\r\n',
      Buffer.from(opts.pass).toString('base64') + '\r\n',
      `MAIL FROM:<${opts.from || opts.user}>\r\n`,
      ...to.map(t => `RCPT TO:<${t}>\r\n`),
      `DATA\r\n`,
      body + `\r\n.\r\n`,
      `QUIT\r\n`,
    ];

    function expect(code, line) {
      return line.split('\n').some(l => l.startsWith(code) || /^\d{3} /.test(l) && l.startsWith(code));
    }

    socket.on('data', (chunk) => {
      buf += chunk;
      if (!/\r?\n$/.test(buf)) return; // wait for full line
      const line = buf.trim();
      buf = '';
      const code = line.slice(0, 3);
      // 2xx/3xx good; 5xx/4xx error
      if (code[0] === '4' || code[0] === '5') {
        socket.destroy();
        return reject(new Error(`SMTP error: ${line}`));
      }
      if (step < cmds.length) {
        socket.write(cmds[step++]);
      }
    });

    socket.on('error', reject);
    socket.on('end', () => resolve({ ok: true }));
  });
}

function buildMime(opts, boundary) {
  const lines = [];
  lines.push(`From: ${opts.fromName ? `"${opts.fromName}" ` : ''}<${opts.from || opts.user}>`);
  lines.push(`To: ${(Array.isArray(opts.to) ? opts.to : [opts.to]).join(', ')}`);
  lines.push(`Subject: ${opts.subject || ''}`);
  lines.push('MIME-Version: 1.0');
  if (opts.attachment) {
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('');
    lines.push(opts.text || '');
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${opts.attachment.contentType || 'application/octet-stream'}; name="${opts.attachment.filename}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${opts.attachment.filename}"`);
    lines.push('');
    lines.push(opts.attachment.content.toString('base64').replace(/(.{76})/g, '$1\r\n'));
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('');
    lines.push(opts.text || '');
  }
  return lines.join('\r\n');
}

module.exports = { sendMail };
