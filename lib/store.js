// Tiny JSON persistence. No deps.
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const SETTINGS = path.join(DATA, 'settings.json');
const ORDERS = path.join(DATA, 'orders.json');

const { DEFAULT_RULES } = require('./packages');

const DEFAULT_SETTINGS = {
  mode: 'stage',                 // off | stage | auto
  environment: 'staging',        // staging | live   (start safe on sandbox)
  chitchats: { clientId: '', accessToken: '' },
  woo: { url: 'https://dalmend.com', consumerKey: '', consumerSecret: '', webhookSecret: '' },
  valueCurrency: 'cad',
  shipDate: 'today',
  orderStore: 'woocommerce',
  returnAddress: {
    name: 'Dalmend', address_1: '', address_2: '', city: 'Toronto',
    province_code: 'ON', postal_code: '', country_code: 'CA', phone: '',
  },
  delivery: {
    dashboard: true,
    brevo: { enabled: false, apiKey: '', from: 'sia@kavalsia.com', fromName: 'Dalmend Shipping', to: 'sia@kavalsia.com' },
    gmail: { enabled: false, user: '', appPassword: '', to: '' },
    print: { enabled: false, printer: '', media: '4x6.Postcard' },
  },
  packaging: DEFAULT_RULES,
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function getSettings() {
  const s = readJSON(SETTINGS, null);
  if (!s) { writeJSON(SETTINGS, DEFAULT_SETTINGS); return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
  // shallow-merge defaults so new keys appear after upgrades
  return deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), s);
}
function saveSettings(patch) {
  const merged = deepMerge(getSettings(), patch);
  writeJSON(SETTINGS, merged);
  return merged;
}
function deepMerge(base, over) {
  if (Array.isArray(over)) return over;
  if (over && typeof over === 'object') {
    const out = Array.isArray(base) ? [] : { ...base };
    for (const k of Object.keys(over)) {
      out[k] = (k in base) ? deepMerge(base[k], over[k]) : over[k];
    }
    return out;
  }
  return over === undefined ? base : over;
}

function getOrders() { return readJSON(ORDERS, []); }
function saveOrders(list) { writeJSON(ORDERS, list); }

function upsertOrder(rec) {
  const list = getOrders();
  const i = list.findIndex(o => String(o.orderId) === String(rec.orderId));
  if (i >= 0) list[i] = { ...list[i], ...rec, updatedAt: new Date().toISOString() };
  else list.unshift({ ...rec, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  saveOrders(list);
  return rec;
}
function getOrder(orderId) {
  return getOrders().find(o => String(o.orderId) === String(orderId));
}
function logEvent(orderId, message) {
  const list = getOrders();
  const o = list.find(x => String(x.orderId) === String(orderId));
  if (o) {
    o.events = o.events || [];
    o.events.push({ at: new Date().toISOString(), message });
    o.updatedAt = new Date().toISOString();
    saveOrders(list);
  }
}

// Clear isNew flag on all orders (call after user views dashboard).
function clearNewFlags() {
  const list = getOrders();
  list.forEach(o => { o.isNew = false; });
  saveOrders(list);
}

module.exports = {
  getSettings, saveSettings, getOrders, saveOrders, upsertOrder, getOrder, logEvent, clearNewFlags,
  DEFAULT_SETTINGS, DATA,
};
