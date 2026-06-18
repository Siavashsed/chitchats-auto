// WooCommerce order poller + daily scheduler.
// Polls for new "processing" orders since last run, feeds them through the pipeline,
// then sends a push notification summary to all subscribed devices.

const store = require('./store');
const woo = require('./woo');
const pipeline = require('./pipeline');
const vapid = require('./vapid');

let _timer = null;
let _running = false;
let _lastResult = null;

// Fetch new WooCommerce orders created after `since` (ISO string).
async function fetchNewOrders(settings, since) {
  const s = settings.woo;
  if (!s || !s.url || !s.consumerKey || !s.consumerSecret) return [];
  const base = s.url.replace(/\/+$/, '');
  const auth = Buffer.from(`${s.consumerKey}:${s.consumerSecret}`).toString('base64');
  // WC REST: orders with status=processing created after `since`
  const params = new URLSearchParams({
    status: 'processing',
    after: since,
    per_page: '100',
    orderby: 'date',
    order: 'asc',
  });
  const res = await fetch(`${base}/wp-json/wc/v3/orders?${params}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`WooCommerce fetch failed: HTTP ${res.status}`);
  return res.json();
}

async function runPoll(manual = false) {
  if (_running) return { skipped: true, reason: 'already running' };
  _running = true;
  const startedAt = new Date().toISOString();
  let processed = 0, skipped = 0, errors = 0;

  try {
    const settings = store.getSettings();
    if (settings.mode === 'off') {
      _running = false;
      return { skipped: true, reason: 'mode is off' };
    }
    if (pipeline.isMock(settings)) {
      // In mock mode, just simulate one order so you can test the flow
      const n = Date.now().toString().slice(-6);
      const fake = woo.normalizeOrder({
        id: 'POLL' + n, number: 'POLL' + n, status: 'processing', total: '39.50', currency: 'CAD',
        billing: { first_name: 'Poll', last_name: 'Test', email: 'sia@kavalsia.com' },
        shipping: {
          first_name: 'Poll', last_name: 'Test',
          address_1: '123 Queen St W', city: 'Toronto', state: 'ON', postcode: 'M5H 2M9', country: 'CA',
        },
        line_items: [{ name: 'Vish Body Candle', sku: 'VISH', quantity: 1, price: '39.50' }],
      });
      await pipeline.intake(fake, settings);
      processed = 1;
    } else {
      // Find the last poll time from settings, default to 24h ago
      const since = settings.poller && settings.poller.lastPolledAt
        ? settings.poller.lastPolledAt
        : new Date(Date.now() - 86400000).toISOString();

      const rawOrders = await fetchNewOrders(settings, since);
      const existingIds = new Set(store.getOrders().map(o => String(o.orderId)));

      for (const raw of rawOrders) {
        const order = woo.normalizeOrder(raw);
        if (existingIds.has(String(order.orderId))) { skipped++; continue; }
        if (!order.shipping.address_1) { skipped++; continue; }
        try {
          await pipeline.intake(order, settings);
          processed++;
        } catch (e) {
          errors++;
          console.error(`Poll: error processing order ${order.orderId}:`, e.message);
        }
      }
    }

    // Record this poll time
    store.saveSettings({ poller: { ...((store.getSettings().poller) || {}), lastPolledAt: startedAt } });

    // Send push notification if anything was processed
    const keys = vapid.loadKeys();
    const subject = `mailto:${settings.delivery?.brevo?.from || 'sia@kavalsia.com'}`;
    let pushResult = { sent: 0, total: 0 };
    if (processed > 0 || manual) {
      try {
        pushResult = await vapid.notifyAll(keys, subject);
      } catch (e) {
        console.error('Push notify error:', e.message);
      }
    }

    _lastResult = { at: startedAt, processed, skipped, errors, pushSent: pushResult.sent, manual };
    console.log(`Poll done: ${processed} new, ${skipped} skipped, ${errors} errors. Push: ${pushResult.sent}/${pushResult.total}`);
    return _lastResult;
  } catch (e) {
    _lastResult = { at: startedAt, error: e.message, processed, skipped, errors, manual };
    console.error('Poll error:', e.message);
    return _lastResult;
  } finally {
    _running = false;
  }
}

// Schedule the next poll at a given hour (0-23, server local time).
// Loops daily. Call once on startup.
function schedule(settings) {
  const hour = (settings.poller && settings.poller.hour != null) ? Number(settings.poller.hour) : 9;
  if (_timer) clearTimeout(_timer);

  function nextRunMs() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  function loop() {
    const ms = nextRunMs();
    const h = Math.round(ms / 36000) / 100;
    console.log(`Next poll scheduled in ${h}h (at ${hour}:00 server time)`);
    _timer = setTimeout(async () => {
      await runPoll(false);
      loop();
    }, ms);
  }

  loop();
}

function getLastResult() { return _lastResult; }
function isRunning() { return _running; }
function stop() { if (_timer) { clearTimeout(_timer); _timer = null; } }

module.exports = { runPoll, schedule, stop, getLastResult, isRunning };
