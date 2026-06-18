#!/usr/bin/env node
// Polls WooCommerce, buys ChitChats labels, emails them via Brevo.
// Runs on GitHub Actions (or locally: node scripts/run-labels.js)
// No npm install needed — pure Node built-ins + project libs.
//
// Deduplication: after buying a label, adds a private WooCommerce note
// "[ChitChats Auto] Label purchased". Skips orders that already have it.

const Chitchats = require('../lib/chitchats');
const { computePackage } = require('../lib/packages');
const { normalizeOrder } = require('../lib/woo');

// ---- Config from GitHub Secrets (env vars) ----
const CC = {
  clientId: process.env.CC_CLIENT_ID || '',
  accessToken: process.env.CC_ACCESS_TOKEN || '',
  environment: process.env.CC_ENV || 'live',
};
const WOO_BASE = (process.env.WOO_URL || 'https://dalmend.com').replace(/\/+$/, '');
const WOO_AUTH = Buffer.from(`${process.env.WOO_KEY}:${process.env.WOO_SECRET}`).toString('base64');
const BREVO_KEY = process.env.BREVO_KEY || '';
const BREVO_TO = process.env.BREVO_TO || 'sia@kavalsia.com';
const BREVO_FROM = process.env.BREVO_FROM || 'sia@kavalsia.com';
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME || 'Dalmend Shipping';
const RETURN_ADDRESS = process.env.RETURN_ADDRESS
  ? JSON.parse(process.env.RETURN_ADDRESS)
  : { name: 'Dalmend', city: 'Toronto', province_code: 'ON', country_code: 'CA' };
// ---- WooCommerce ----
async function wooGet(path) {
  const res = await fetch(`${WOO_BASE}/wp-json/wc/v3${path}`, {
    headers: { Authorization: `Basic ${WOO_AUTH}` },
  });
  if (!res.ok) throw new Error(`WooCommerce GET ${path} -> HTTP ${res.status}`);
  return res.json();
}
async function wooPost(path, body) {
  const res = await fetch(`${WOO_BASE}/wp-json/wc/v3${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${WOO_AUTH}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`WooCommerce POST ${path} -> HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchNewOrders() {
  // 25h lookback so we never miss an overnight order even with timezone drift
  const after = new Date(Date.now() - 25 * 3600000).toISOString();
  const params = new URLSearchParams({ status: 'processing', after, per_page: '50', orderby: 'date', order: 'asc' });
  return wooGet(`/orders?${params}`);
}
async function alreadyProcessed(orderId) {
  try {
    const notes = await wooGet(`/orders/${orderId}/notes`);
    return notes.some(n => (n.note || '').includes('[ChitChats Auto]'));
  } catch { return false; }
}
async function markProcessed(orderId, tracking, cost) {
  try {
    await wooPost(`/orders/${orderId}/notes`, {
      note: `[ChitChats Auto] Shipping label purchased. Tracking: ${tracking}. Cost: ${cost}.`,
      customer_note: false,
    });
  } catch (e) {
    console.warn(`  Could not add order note: ${e.message}`);
  }
}

// ---- Brevo ----
async function sendEmail(subject, text, attachments = []) {
  if (!BREVO_KEY) { console.log('No BREVO_KEY set, skipping email.'); return; }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { email: BREVO_FROM, name: BREVO_FROM_NAME },
      to: [{ email: BREVO_TO }],
      subject,
      textContent: text,
      ...(attachments.length ? { attachment: attachments } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Brevo failed: HTTP ${res.status} - ${await res.text()}`);
}

// ---- Main ----
async function main() {
  console.log(`ChitChats Auto - ${new Date().toUTCString()}`);
  console.log(`Store: ${WOO_BASE}  |  Environment: ${CC.environment}`);

  if (!CC.clientId || !CC.accessToken) throw new Error('Missing CC_CLIENT_ID or CC_ACCESS_TOKEN');
  if (!process.env.WOO_KEY) throw new Error('Missing WOO_KEY / WOO_SECRET');

  const rawOrders = await fetchNewOrders();
  console.log(`Found ${rawOrders.length} processing orders in the last 25h`);

  const results = [];

  for (const raw of rawOrders) {
    const order = normalizeOrder(raw);
    console.log(`\nOrder #${order.number} — ${order.shipping.name}, ${order.shipping.city} ${order.shipping.province_code}`);

    if (await alreadyProcessed(order.orderId)) {
      console.log('  Skipped (already processed)');
      continue;
    }
    if (!order.shipping.address_1) {
      console.log('  Skipped (no shipping address)');
      continue;
    }

    const pkg = computePackage(order);
    console.log(`  Package: ${pkg.boxName}, ${pkg.weight}g, ${pkg.size_x}x${pkg.size_y}x${pkg.size_z}cm`);

    if (pkg.needsBoxSize) {
      console.log(`  SKIPPED: ${pkg.totalQty} items — open dashboard to enter box size and buy manually.`);
      results.push({ ok: false, number: order.number, name: order.shipping.name, error: `${pkg.totalQty} items — open dashboard to set box size` });
      continue;
    }
    console.log(`  Items: ${pkg.summary}`);

    try {
      // 1. Create shipment (cheapest rate)
      const payload = Chitchats.buildShipmentPayload(order, pkg, {
        valueCurrency: 'cad', shipDate: 'today', orderStore: 'woocommerce',
        returnAddress: RETURN_ADDRESS,
      }, { cheapest: true });
      const created = await Chitchats.createShipment(CC, payload);
      const ship = created.shipment || created;
      console.log(`  Shipment created: ${ship.id}`);

      // 2. Buy postage + poll until ready
      await Chitchats.buyPostage(CC, ship.id);
      const final = await Chitchats.waitUntilReady(CC, ship.id, { tries: 15, delayMs: 3000 });
      const done = final.shipment || final;

      if (done.status === 'postage_purchase_failed') throw new Error('Postage purchase failed');

      const tracking = done.carrier_tracking_code || done.tracking_number || '';
      const cost = done.payment_amount ? `$${done.payment_amount} CAD` : '';
      console.log(`  Label ready! Tracking: ${tracking}  Cost: ${cost}`);

      // 3. Download label PNG/PDF
      const labelUrl = done.postage_label_png_url || done.postage_label_pdf_url;
      const labelRes = await fetch(labelUrl);
      if (!labelRes.ok) throw new Error(`Label download failed: HTTP ${labelRes.status}`);
      const labelBuf = Buffer.from(await labelRes.arrayBuffer());
      const ext = labelUrl.includes('.pdf') ? 'pdf' : 'png';

      // 4. Mark order in WooCommerce so we don't re-process it
      await markProcessed(order.orderId, tracking, cost);

      results.push({ ok: true, number: order.number, name: order.shipping.name, city: order.shipping.city, tracking, cost, pkg, labelBuf, ext });
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
      results.push({ ok: false, number: order.number, error: e.message });
    }
  }

  // ---- Summary email ----
  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);

  if (results.length === 0) {
    console.log('\nNo new orders. No email sent.');
    return;
  }

  const today = new Date().toLocaleDateString('en-CA');
  const subject = ok.length
    ? `Dalmend Ship — ${ok.length} label${ok.length !== 1 ? 's' : ''} ready (${today})`
    : `Dalmend Ship — ${failed.length} failed (${today})`;

  const lines = [
    `Dalmend Shipping Labels — ${today}`,
    `${ok.length} bought  |  ${failed.length} failed`,
    '',
    ...ok.map(r =>
      `Order #${r.number}\n  ${r.name} — ${r.city}\n  Tracking: ${r.tracking}\n  Cost: ${r.cost}\n  Box: ${r.pkg.boxName} ${r.pkg.weight}g`
    ),
    ...(failed.length ? ['\n--- Failed ---', ...failed.map(r => `Order #${r.number}: ${r.error}`)] : []),
    '',
    'Generated by Nexus V22 / Kavalsia Inc.',
  ];

  const attachments = ok.map(r => ({
    name: `label_${r.number}.${r.ext}`,
    content: r.labelBuf.toString('base64'),
  }));

  await sendEmail(subject, lines.join('\n'), attachments);
  console.log(`\nEmail sent to ${BREVO_TO} with ${ok.length} label attachment${ok.length !== 1 ? 's' : ''}.`);

  if (failed.length) process.exitCode = 1;
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
