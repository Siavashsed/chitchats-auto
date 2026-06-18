// ChitChats Auto - WooCommerce order -> buy/print/email shipping label.
// Zero dependency. Node 18+.  Powered By Nexus V22 / Kavalsia Inc.
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const store = require('./lib/store');
const woo = require('./lib/woo');
const pipeline = require('./lib/pipeline');
const { LABELS } = require('./lib/deliver');
const vapid = require('./lib/vapid');
const poller = require('./lib/poller');

const PORT = process.env.PORT || 4605;
const PUBLIC = path.join(__dirname, 'public');

function send(res, code, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function serveStatic(res, filePath) {
  if (!fs.existsSync(filePath)) { send(res, 404, { error: 'not found' }); return; }
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  res.end(fs.readFileSync(filePath));
}

// Redact secrets before sending to browser.
function publicSettings(s) {
  const c = JSON.parse(JSON.stringify(s));
  const mask = v => v ? '••••' + String(v).slice(-4) : '';
  if (c.chitchats) c.chitchats.accessToken = mask(c.chitchats.accessToken);
  if (c.woo) { c.woo.consumerSecret = mask(c.woo.consumerSecret); c.woo.webhookSecret = mask(c.woo.webhookSecret); }
  if (c.delivery) {
    if (c.delivery.brevo) c.delivery.brevo.apiKey = mask(c.delivery.brevo.apiKey);
    if (c.delivery.gmail) c.delivery.gmail.appPassword = mask(c.delivery.gmail.appPassword);
  }
  return c;
}

function stripMasked(obj) {
  if (Array.isArray(obj)) return obj.map(stripMasked);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.startsWith('••••')) continue;
      out[k] = stripMasked(v);
    }
    return out;
  }
  return obj;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { send(res, 204, ''); return; }
  const { pathname } = url.parse(req.url, true);

  try {
    // ---- Static files ----
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveStatic(res, path.join(PUBLIC, 'index.html'));
    }
    if (req.method === 'GET' && ['/manifest.json', '/sw.js', '/icon.svg'].includes(pathname)) {
      return serveStatic(res, path.join(PUBLIC, pathname));
    }

    const body = req.method !== 'GET' ? (await readBody(req)).toString('utf8') : '';

    // ---- WooCommerce webhook ----
    if (req.method === 'POST' && pathname === '/webhook/woo') {
      const rawBuf = await readBody(req);
      const raw = rawBuf.toString('utf8');
      const settings = store.getSettings();
      const sig = req.headers['x-wc-webhook-signature'];
      if (raw && raw.length < 5) return send(res, 200, { ok: true, ping: true });
      if (!woo.verifySignature(raw, sig, settings.woo.webhookSecret)) {
        return send(res, 401, { error: 'bad signature' });
      }
      let payload;
      try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: 'bad json' }); }
      const order = woo.normalizeOrder(payload);
      if (!order.shipping.address_1) return send(res, 200, { ok: true, skipped: 'no shipping address' });
      send(res, 200, { ok: true, received: order.orderId });
      pipeline.intake(order, settings).then(() => {
        // Push notify on webhook too
        const keys = vapid.loadKeys();
        const subj = `mailto:${settings.delivery?.brevo?.from || 'sia@kavalsia.com'}`;
        vapid.notifyAll(keys, subj).catch(() => {});
      }).catch(e => store.logEvent(order.orderId, 'ERROR: ' + e.message));
      return;
    }

    // ---- API: state ----
    if (req.method === 'GET' && pathname === '/api/state') {
      return send(res, 200, {
        settings: publicSettings(store.getSettings()),
        orders: store.getOrders(),
        poll: { running: poller.isRunning(), last: poller.getLastResult() },
        subscriptions: vapid.loadSubscriptions().length,
      });
    }

    // ---- API: VAPID public key (browser needs this to subscribe) ----
    if (req.method === 'GET' && pathname === '/api/vapid-key') {
      const keys = vapid.loadKeys();
      return send(res, 200, { publicKey: keys.publicKeyBase64url });
    }

    // ---- API: save push subscription ----
    if (req.method === 'POST' && pathname === '/api/subscribe') {
      const sub = JSON.parse(body || '{}');
      if (!sub.endpoint) return send(res, 400, { error: 'missing endpoint' });
      vapid.addSubscription(sub);
      return send(res, 200, { ok: true });
    }

    // ---- API: remove push subscription ----
    if (req.method === 'POST' && pathname === '/api/unsubscribe') {
      const { endpoint } = JSON.parse(body || '{}');
      vapid.removeSubscription(endpoint);
      return send(res, 200, { ok: true });
    }

    // ---- API: pending notifications (service worker fetches this on push wake) ----
    if (req.method === 'GET' && pathname === '/api/pending-notifications') {
      const orders = store.getOrders();
      const pending = orders.filter(o => o.status === 'staged' || o.status === 'received');
      const ready = orders.filter(o => o.status === 'label_ready' || o.status === 'delivered');
      const recent = orders.slice(0, 10);
      const count = pending.length + ready.filter(o => {
        const d = new Date(o.updatedAt); return (Date.now() - d) < 3 * 3600000;
      }).length;
      let summary = '';
      if (pending.length) summary += `${pending.length} awaiting approval. `;
      const recentReady = ready.filter(o => (Date.now() - new Date(o.updatedAt)) < 3 * 3600000);
      if (recentReady.length) summary += `${recentReady.length} labels ready to print.`;
      if (!summary) summary = 'Check your shipping dashboard.';
      return send(res, 200, { count, summary: summary.trim() });
    }

    // ---- API: manual poll now ----
    if (req.method === 'POST' && pathname === '/api/poll') {
      const result = await poller.runPoll(true);
      return send(res, 200, { ok: true, result });
    }

    // ---- API: save settings ----
    if (req.method === 'POST' && pathname === '/api/settings') {
      const patch = stripMasked(JSON.parse(body || '{}'));
      const saved = store.saveSettings(patch);
      // Reschedule poller if hour changed
      poller.stop();
      poller.schedule(saved);
      return send(res, 200, { ok: true, settings: publicSettings(saved) });
    }

    // ---- API: set mode ----
    if (req.method === 'POST' && pathname === '/api/mode') {
      const { mode } = JSON.parse(body || '{}');
      if (!['off', 'stage', 'auto'].includes(mode)) return send(res, 400, { error: 'bad mode' });
      store.saveSettings({ mode });
      return send(res, 200, { ok: true, mode });
    }

    // ---- API: buy a staged order ----
    if (req.method === 'POST' && pathname.match(/^\/api\/order\/[^/]+\/buy$/)) {
      const id = pathname.split('/')[3];
      const { postageType } = JSON.parse(body || '{}');
      const rec = await pipeline.buyAndDeliver(id, store.getSettings(), postageType);
      return send(res, 200, { ok: true, order: rec });
    }

    // ---- API: set box dimensions for 3+ item orders ----
    if (req.method === 'POST' && pathname.match(/^\/api\/order\/[^/]+\/set-box$/)) {
      const id = pathname.split('/')[3];
      const { size_x, size_y, size_z } = JSON.parse(body || '{}');
      if (!size_x || !size_y || !size_z) return send(res, 400, { error: 'size_x, size_y, size_z required' });
      const rec = store.getOrder(id);
      if (!rec) return send(res, 404, { error: 'order not found' });
      const updatedPkg = { ...rec.pkg, size_x, size_y, size_z, needsBoxSize: false, boxName: `${size_x}x${size_y}x${size_z}cm (manual)` };
      store.upsertOrder({ orderId: id, pkg: updatedPkg, status: 'received' });
      store.logEvent(id, `Box set to ${size_x}x${size_y}x${size_z}cm`);
      // Now create a ChitChats shipment so the order is staged for buying
      const settings = store.getSettings();
      const updatedOrder = { ...rec.order, pkg: updatedPkg };
      updatedOrder.pkg = updatedPkg;
      const { intake } = require('./lib/pipeline');
      // Re-run intake with fixed pkg — patch order's lineItems so computePackage won't re-flag it
      // Instead, directly create shipment and stage it
      const { isMock } = require('./lib/pipeline');
      if (isMock(settings)) {
        store.upsertOrder({ orderId: id, status: 'staged', shipmentId: 'MOCK-' + id });
        store.logEvent(id, '[MOCK] Shipment staged with manual box dimensions');
      } else {
        const Chitchats = require('./lib/chitchats');
        const cfg = { clientId: settings.chitchats.clientId, accessToken: settings.chitchats.accessToken, environment: settings.environment === 'live' ? 'live' : 'staging' };
        const payload = Chitchats.buildShipmentPayload(rec.order, updatedPkg, settings, { cheapest: true });
        const created = await Chitchats.createShipment(cfg, payload);
        const ship = created.shipment || created;
        store.upsertOrder({ orderId: id, status: 'staged', shipmentId: ship.id });
        store.logEvent(id, `Shipment ${ship.id} created with manual box ${size_x}x${size_y}x${size_z}cm`);
      }
      return send(res, 200, { ok: true, order: store.getOrder(id) });
    }

    // ---- API: sync all WooCommerce processing orders into store ----
    if (req.method === 'POST' && pathname === '/api/sync-all') {
      const result = await poller.syncAll();
      return send(res, 200, { ok: true, ...result });
    }

    // ---- API: clear isNew flags (user has seen the dashboard) ----
    if (req.method === 'POST' && pathname === '/api/orders/mark-seen') {
      store.clearNewFlags();
      return send(res, 200, { ok: true });
    }

    // ---- API: refund an order ----
    if (req.method === 'POST' && pathname.match(/^\/api\/order\/[^/]+\/refund$/)) {
      const id = pathname.split('/')[3];
      const { amount, reason } = JSON.parse(body || '{}');
      if (!amount) return send(res, 400, { error: 'amount required' });
      const rec = store.getOrder(id);
      if (!rec) return send(res, 404, { error: 'order not found' });
      const settings = store.getSettings();
      const wcId = rec.order.orderId;
      const refundData = await woo.createRefund(settings, wcId, { amount, reason });
      store.upsertOrder({ orderId: id, status: 'refunded' });
      store.logEvent(id, `Refund $${amount} processed${reason ? ' — ' + reason : ''}. WC ref: ${refundData.id}`);
      return send(res, 200, { ok: true, refund: refundData });
    }

    // ---- API: re-deliver existing label ----
    if (req.method === 'POST' && pathname.match(/^\/api\/order\/[^/]+\/redeliver$/)) {
      const id = pathname.split('/')[3];
      const rec = store.getOrder(id);
      if (!rec || !rec.labelFile) return send(res, 400, { error: 'no label' });
      const file = path.join(LABELS, rec.labelFile);
      const buf = fs.readFileSync(file);
      const ext = path.extname(file).slice(1);
      const { deliver } = require('./lib/deliver');
      const order = rec.order; order.pkg = rec.pkg; order.tracking = rec.tracking; order.cost = rec.cost;
      const results = await deliver(order, { file, buf, ext }, store.getSettings());
      store.logEvent(id, 'Re-delivered: ' + results.filter(r => r.ok).map(r => r.channel).join(', '));
      return send(res, 200, { ok: true, results });
    }

    // ---- API: simulate order ----
    if (req.method === 'POST' && pathname === '/api/simulate') {
      const opts = JSON.parse(body || '{}');
      const n = Date.now().toString().slice(-6);
      const fake = woo.normalizeOrder({
        id: 'SIM' + n, number: 'SIM' + n, status: 'processing', total: '79.00', currency: 'CAD',
        billing: { first_name: 'Test', last_name: 'Buyer', email: 'sia@kavalsia.com', phone: '6475107272' },
        shipping: {
          first_name: 'Test', last_name: 'Buyer',
          address_1: opts.address || '123 Queen St W', address_2: 'Unit 4',
          city: opts.city || 'Toronto', state: opts.state || 'ON',
          postcode: opts.postcode || 'M5H 2M9', country: opts.country || 'CA',
        },
        line_items: opts.lineItems || [
          { name: 'Vish Body Candle', sku: 'VISH', quantity: opts.qty || 2, price: '39.50' },
        ],
      });
      const rec = await pipeline.intake(fake, store.getSettings());
      store.upsertOrder({ orderId: fake.orderId, isSimulated: true });
      return send(res, 200, { ok: true, order: store.getOrder(fake.orderId) });
    }

    // ---- API: delete a simulated order ----
    if (req.method === 'DELETE' && pathname.match(/^\/api\/order\/[^/]+$/)) {
      const id = pathname.split('/')[3];
      const rec = store.getOrder(id);
      if (!rec) return send(res, 404, { error: 'not found' });
      if (!rec.isSimulated) return send(res, 403, { error: 'only simulated orders can be deleted' });
      const list = store.getOrders().filter(o => String(o.orderId) !== String(id));
      store.saveOrders(list);
      return send(res, 200, { ok: true });
    }

    // ---- Serve label files ----
    if (req.method === 'GET' && pathname.startsWith('/label/')) {
      const file = path.join(LABELS, path.basename(pathname));
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      return serveStatic(res, file);
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const s = store.getSettings();
  const keys = vapid.loadKeys(); // ensure keys exist on startup
  console.log(`\n  ChitChats Auto  ->  http://localhost:${PORT}`);
  console.log(`  Mode: ${s.mode}   Environment: ${s.environment}${pipeline.isMock(s) ? ' (MOCK)' : ''}`);
  console.log(`  VAPID public key: ${keys.publicKeyBase64url.slice(0, 20)}...`);
  console.log(`  Webhook: POST http://localhost:${PORT}/webhook/woo\n`);
  // Start the daily poller
  if (s.mode !== 'off') poller.schedule(s);
  // Pull all existing WC processing orders on startup
  poller.syncAll().catch(e => console.warn('Startup sync failed:', e.message));
});
