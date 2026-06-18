// Load-test helper: creates fake WooCommerce orders at a configurable rate.
// Tracks created IDs in data/loadtest-orders.json so they can all be wiped.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const IDS_FILE = path.join(__dirname, '..', 'data', 'loadtest-orders.json');

function loadIds() { try { return JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')); } catch { return []; } }
function saveIds(ids) { fs.writeFileSync(IDS_FILE, JSON.stringify(ids)); }

// ---- Random fake data ----
const FIRST  = ['Emma','Liam','Olivia','Noah','Ava','William','Sophia','James','Isabella','Oliver','Mia','Lucas','Charlotte','Ethan','Amelia'];
const LAST   = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Wilson','Taylor','Anderson','Thomas','Jackson','White','Harris'];
const STREETS = ['100 Queen St W','45 King St E','200 Bloor St W','1 Yonge St','88 Dundas St','350 College St','740 Spadina Ave','55 Bay St'];
const LOCS = [
  { city:'Toronto',     province:'ON', postal:'M5H 2M9' },
  { city:'Vancouver',   province:'BC', postal:'V6B 1A1' },
  { city:'Montreal',    province:'QC', postal:'H2Y 1C6' },
  { city:'Calgary',     province:'AB', postal:'T2P 0N2' },
  { city:'Ottawa',      province:'ON', postal:'K1P 1J1' },
  { city:'Edmonton',    province:'AB', postal:'T5J 0N3' },
  { city:'Mississauga', province:'ON', postal:'L5B 3C3' },
  { city:'Winnipeg',    province:'MB', postal:'R3C 0N2' },
];
const PRODUCTS = [
  { name:'Grand Vish Candle',  price: 79.00, qty: [1] },
  { name:'Vish Body Candle',   price: 39.50, qty: [1,2] },
  { name:'Vish Candle Set',    price:119.00, qty: [1] },
  { name:'Vish Mini Candle',   price: 24.00, qty: [1,2,3] },
];
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function fakePayload() {
  const first = pick(FIRST), last = pick(LAST), loc = pick(LOCS), street = pick(STREETS);
  const prod = pick(PRODUCTS);
  const qty  = pick(prod.qty);
  const total = (prod.price * qty).toFixed(2);
  const addr = { first_name:first, last_name:last, address_1:street, city:loc.city,
    state:loc.province, postcode:loc.postal, country:'CA',
    email:`${first.toLowerCase()}.${last.toLowerCase()}@example-loadtest.com` };
  return {
    status: 'processing',
    billing: addr, shipping: addr,
    line_items: [{ name:prod.name, quantity:qty, subtotal:total, total }],
    meta_data: [{ key:'_chitchats_loadtest', value:'true' }],
  };
}

// ---- WooCommerce helpers ----
function wooAuth(settings) {
  const s = settings.woo;
  return { base: s.url.replace(/\/+$/,''), auth: Buffer.from(`${s.consumerKey}:${s.consumerSecret}`).toString('base64') };
}
async function wooCreate(settings) {
  const { base, auth } = wooAuth(settings);
  const res = await fetch(`${base}/wp-json/wc/v3/orders`, {
    method:'POST', headers:{ Authorization:`Basic ${auth}`, 'Content-Type':'application/json' },
    body: JSON.stringify(fakePayload()),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`WC create HTTP ${res.status}: ${t.slice(0,200)}`); }
  return res.json();
}
async function wooDelete(settings, wcId) {
  const { base, auth } = wooAuth(settings);
  const res = await fetch(`${base}/wp-json/wc/v3/orders/${wcId}?force=true`, {
    method:'DELETE', headers:{ Authorization:`Basic ${auth}` },
  });
  return res.ok;
}

// ---- State ----
let _timers = [];
let _running = false;
let _progress = { total:0, created:0, failed:0, running:false, mode:'' };

function getStatus() { return { ..._progress, pendingIds: loadIds().length }; }

function stop() {
  _timers.forEach(t => clearTimeout(t));
  _timers = [];
  _running = false;
  _progress.running = false;
}

function start(settings, { count=50, mode='rate', ordersPerMin=4 } = {}) {
  if (_running) stop();
  _running = true;
  _progress = { total:count, created:0, failed:0, running:true, mode };

  // Build delay schedule
  const delays = [];
  if (mode === 'persec') {
    for (let i = 0; i < count; i++) delays.push(i * 1000);
  } else if (mode === 'random2h') {
    const max = 2 * 3600 * 1000;
    for (let i = 0; i < count; i++) delays.push(Math.random() * max);
    delays.sort((a,b) => a-b);
  } else {
    const interval = (60 * 1000) / Math.max(0.01, ordersPerMin);
    for (let i = 0; i < count; i++) delays.push(i * interval);
  }

  for (const delay of delays) {
    const t = setTimeout(async () => {
      if (!_running) return;
      try {
        const order = await wooCreate(settings);
        const ids = loadIds(); ids.push(order.id); saveIds(ids);
        _progress.created++;
      } catch(e) {
        _progress.failed++;
        console.error('Loadtest order create failed:', e.message);
      }
      if (_progress.created + _progress.failed >= _progress.total) {
        _progress.running = false;
        _running = false;
        console.log(`Loadtest done: ${_progress.created} created, ${_progress.failed} failed`);
      }
    }, delay);
    _timers.push(t);
  }
  console.log(`Loadtest started: ${count} orders, mode=${mode}, ${ordersPerMin}/min`);
}

async function clearAll(settings) {
  stop();
  const wcIds = loadIds();
  let deleted = 0, failed = 0;

  for (const wcId of wcIds) {
    try { await wooDelete(settings, wcId); deleted++; }
    catch(e) { failed++; console.error('Delete failed:', wcId, e.message); }
  }
  saveIds([]);

  // Also wipe local simulated + loadtest orders from store
  const list = store.getOrders().filter(o => {
    if (o.isSimulated) return false;
    if (String(o.number || '').startsWith('SIM')) return false;
    if (String(o.number || '').startsWith('POLL')) return false;
    return true;
  });
  // Actually only remove ones whose WC IDs were in the loadtest list
  const wcSet = new Set(wcIds.map(String));
  const pruned = store.getOrders().filter(o =>
    !o.isSimulated && !wcSet.has(String(o.orderId))
  );
  store.saveOrders(pruned);

  console.log(`Loadtest clear: ${deleted} WC orders deleted, ${failed} failed`);
  return { deleted, failed };
}

// Also expose a clearSimulated so the "delete all fake" button covers simulated orders too
function clearSimulated() {
  const list = store.getOrders().filter(o => !o.isSimulated);
  store.saveOrders(list);
  return { cleared: store.getOrders().length };
}

module.exports = { start, stop, clearAll, clearSimulated, getStatus };
