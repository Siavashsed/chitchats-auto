// Orchestration: order -> package -> shipment -> (stage | auto-buy) -> label -> deliver.
const fs = require('fs');
const path = require('path');
const Chitchats = require('./chitchats');
const { computePackage } = require('./packages');
// computePackage now takes only (order) — packaging rules baked in
const { downloadLabel, deliver, LABELS } = require('./deliver');
const store = require('./store');

function isMock(settings) {
  return settings.environment === 'mock'
    || !settings.chitchats || !settings.chitchats.clientId || !settings.chitchats.accessToken;
}

// A tiny valid 1x1 PNG, scaled label placeholder for offline demos.
function mockLabelPng(order) {
  // Minimal but real PNG (red dot). Good enough to prove the delivery path.
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  return Buffer.from(b64, 'base64');
}

function cfgFor(settings) {
  return {
    clientId: settings.chitchats.clientId,
    accessToken: settings.chitchats.accessToken,
    environment: settings.environment === 'live' ? 'live' : 'staging',
  };
}

// Step 1: receive an order, compute package, create (stage) a shipment.
// Does NOT buy postage. Returns the order record.
async function intake(order, settings) {
  const pkg = computePackage(order);
  order.pkg = pkg;

  // 3+ items: always stage and wait for box size input — never auto-buy
  const status = pkg.needsBoxSize ? 'needs_box_size' : 'received';
  store.upsertOrder({
    orderId: order.orderId,
    number: order.number,
    order,
    pkg,
    status,
    mode: settings.mode,
    events: [{ at: new Date().toISOString(), message: `Order received - ${pkg.summary} -> ${pkg.boxName}${pkg.needsBoxSize ? ' (box size needed)' : ` (${pkg.weight}g)`}` }],
  });

  if (pkg.needsBoxSize) {
    store.logEvent(order.orderId, `${pkg.totalQty} items — enter box dimensions before buying`);
    return store.getOrder(order.orderId);
  }

  if (settings.mode === 'off') {
    store.logEvent(order.orderId, 'Automation OFF - left as received');
    return store.getOrder(order.orderId);
  }

  // Create shipment (staged with cheapest rate requested)
  if (isMock(settings)) {
    const rates = [
      { postage_type: 'chit_chats_canada_tracked', payment_amount: '8.49', payment_currency: 'cad' },
      { postage_type: 'usps_first', payment_amount: '12.10', payment_currency: 'cad' },
    ];
    store.upsertOrder({
      orderId: order.orderId, status: 'staged', shipmentId: 'MOCK-' + order.orderId,
      rates, chosenRate: rates[0],
    });
    store.logEvent(order.orderId, `[MOCK] Shipment staged, cheapest ${rates[0].payment_amount} ${rates[0].payment_currency}`);
  } else {
    const cfg = cfgFor(settings);
    const payload = Chitchats.buildShipmentPayload(order, pkg, settings, { cheapest: true });
    const created = await Chitchats.createShipment(cfg, payload);
    const ship = created.shipment || created;
    store.upsertOrder({
      orderId: order.orderId, status: 'staged',
      shipmentId: ship.id, rates: ship.rates || [], chosenRate: pickCheapest(ship.rates),
    });
    store.logEvent(order.orderId, `Shipment ${ship.id} staged on ${cfg.environment}`);
  }

  // Auto mode -> immediately buy
  if (settings.mode === 'auto') {
    return buyAndDeliver(order.orderId, settings);
  }
  return store.getOrder(order.orderId);
}

function pickCheapest(rates) {
  if (!Array.isArray(rates) || !rates.length) return null;
  return [...rates].sort((a, b) =>
    parseFloat(a.payment_amount || a.amount || 0) - parseFloat(b.payment_amount || b.amount || 0))[0];
}

// Step 2: buy postage + fetch label + deliver. SPENDS MONEY (unless mock).
async function buyAndDeliver(orderId, settings, postageType) {
  const rec = store.getOrder(orderId);
  if (!rec) throw new Error('Order not found: ' + orderId);
  const order = rec.order;
  order.pkg = rec.pkg;

  store.upsertOrder({ orderId, status: 'buying' });

  let label;
  if (isMock(settings)) {
    const buf = mockLabelPng(order);
    const file = path.join(LABELS, `label_${order.number}.png`);
    fs.writeFileSync(file, buf);
    label = { file, buf, ext: 'png' };
    order.tracking = 'MOCK1234567890';
    order.cost = (rec.chosenRate && rec.chosenRate.payment_amount) ? `$${rec.chosenRate.payment_amount}` : '$8.49';
    store.upsertOrder({ orderId, tracking: order.tracking, cost: order.cost, status: 'label_ready', labelFile: path.basename(file) });
    store.logEvent(orderId, `[MOCK] Postage bought (${order.cost}), label generated`);
  } else {
    const cfg = cfgFor(settings);
    await Chitchats.buyPostage(cfg, rec.shipmentId, postageType || (rec.chosenRate && rec.chosenRate.postage_type));
    store.logEvent(orderId, `Buy requested for shipment ${rec.shipmentId}, polling...`);
    const final = await Chitchats.waitUntilReady(cfg, rec.shipmentId);
    const ship = final.shipment || final;
    if (ship.status === 'postage_purchase_failed') {
      store.upsertOrder({ orderId, status: 'failed' });
      store.logEvent(orderId, 'Postage purchase FAILED');
      throw new Error('Postage purchase failed');
    }
    order.tracking = ship.carrier_tracking_code || ship.tracking_number || '';
    order.cost = ship.payment_amount ? `$${ship.payment_amount}` : '';
    const url = ship.postage_label_png_url || ship.postage_label_pdf_url;
    label = await downloadLabel(url, order.number);
    store.upsertOrder({
      orderId, status: 'label_ready', tracking: order.tracking, cost: order.cost,
      labelFile: path.basename(label.file), trackingUrl: ship.tracking_url || '',
    });
    store.logEvent(orderId, `Label ready (${order.cost}), tracking ${order.tracking}`);
  }

  // Deliver
  order.tracking = order.tracking; order.cost = order.cost;
  const results = await deliver(order, label, settings);
  const okChannels = results.filter(r => r.ok).map(r => r.channel).join(', ');
  store.upsertOrder({ orderId, status: 'delivered', delivery: results });
  store.logEvent(orderId, `Delivered via: ${okChannels}`);
  results.filter(r => !r.ok).forEach(r => store.logEvent(orderId, `Delivery FAILED (${r.channel}): ${r.detail}`));
  return store.getOrder(orderId);
}

module.exports = { intake, buyAndDeliver, isMock, pickCheapest };
