// Zero-dep VAPID for Web Push (RFC 8292).
// Uses Node's built-in crypto — no npm packages needed.
//
// Strategy: send push with NO payload body (no encryption needed).
// The service worker wakes up and fetches /api/pending-notifications.
// This keeps the code simple and avoids aes128gcm payload encryption.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEYS_FILE = path.join(__dirname, '..', 'data', 'vapid-keys.json');
const SUBS_FILE = path.join(__dirname, '..', 'data', 'subscriptions.json');

// P-256 SPKI DER: 2-byte outer SEQUENCE + 2-byte inner SEQUENCE + 9-byte OID1 + 10-byte OID2 + 2-byte BIT STRING + 1 unused-bits byte = 26 bytes before the 65-byte uncompressed point
function spkiToRaw(derBuf) {
  return derBuf.slice(26); // 04 || x(32) || y(32)
}

function generateKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const keys = {
    privateKey: Buffer.from(privateKey).toString('base64'),
    publicKey: Buffer.from(publicKey).toString('base64'),
    publicKeyBase64url: spkiToRaw(Buffer.from(publicKey)).toString('base64url'),
  };
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
  console.log('VAPID keys generated and saved.');
  return keys;
}

function loadKeys() {
  try {
    const k = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    // Backfill publicKeyBase64url if old keys file missing it
    if (!k.publicKeyBase64url) {
      k.publicKeyBase64url = spkiToRaw(Buffer.from(k.publicKey, 'base64')).toString('base64url');
      fs.writeFileSync(KEYS_FILE, JSON.stringify(k, null, 2));
    }
    return k;
  } catch {
    return generateKeys();
  }
}

function buildJwt(audience, subject, privateKeyDerBase64) {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ aud: audience, exp: now + 43200, sub: subject })).toString('base64url');
  const sigInput = `${header}.${payload}`;
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyDerBase64, 'base64'),
    format: 'der', type: 'pkcs8',
  });
  // Node 15+ dsaEncoding='ieee-p1363' gives raw r||s (64 bytes) instead of ASN.1 DER
  const sig = crypto.sign('SHA256', Buffer.from(sigInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${sigInput}.${sig.toString('base64url')}`;
}

// Send a bodyless push (no encryption needed). Returns HTTP status from push service.
// 201 = success. 404/410 = subscription expired (remove it).
async function sendPush(subscription, keys, subject) {
  const u = new URL(subscription.endpoint);
  const audience = `${u.protocol}//${u.host}`;
  const jwt = buildJwt(audience, subject, keys.privateKey);
  const auth = `vapid t=${jwt},k=${keys.publicKeyBase64url}`;
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: { Authorization: auth, TTL: '86400' },
  });
  return res.status;
}

// Fan out a push to all saved subscriptions; remove stale ones.
async function notifyAll(keys, subject) {
  const subs = loadSubscriptions();
  const still = [];
  let sent = 0;
  for (const sub of subs) {
    try {
      const status = await sendPush(sub, keys, subject);
      if (status === 410 || status === 404) {
        console.log('Removed stale push subscription');
      } else {
        still.push(sub);
        if (status === 201 || status === 200) sent++;
        else console.log(`Push returned HTTP ${status} for ${sub.endpoint.slice(0, 60)}...`);
      }
    } catch (e) {
      console.error('Push send error:', e.message);
      still.push(sub); // keep on network error, remove only on 404/410
    }
  }
  saveSubscriptions(still);
  return { sent, total: subs.length };
}

function loadSubscriptions() {
  try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch { return []; }
}
function saveSubscriptions(list) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(list, null, 2));
}
function addSubscription(sub) {
  const list = loadSubscriptions();
  // Deduplicate by endpoint
  const i = list.findIndex(s => s.endpoint === sub.endpoint);
  if (i >= 0) list[i] = sub; else list.push(sub);
  saveSubscriptions(list);
}
function removeSubscription(endpoint) {
  saveSubscriptions(loadSubscriptions().filter(s => s.endpoint !== endpoint));
}

module.exports = { loadKeys, generateKeys, notifyAll, addSubscription, removeSubscription, loadSubscriptions };
