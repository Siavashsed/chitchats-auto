// WooCommerce order normalization + webhook signature verification.
const crypto = require('crypto');

// WooCommerce signs webhooks as base64( HMAC-SHA256( rawBody, secret ) )
// in the X-WC-Webhook-Signature header.
function verifySignature(rawBody, signature, secret) {
  if (!secret) return true; // not configured -> skip (dev / simulate)
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

const PROV = {
  'ALBERTA': 'AB', 'BRITISH COLUMBIA': 'BC', 'MANITOBA': 'MB', 'NEW BRUNSWICK': 'NB',
  'NEWFOUNDLAND AND LABRADOR': 'NL', 'NORTHWEST TERRITORIES': 'NT', 'NOVA SCOTIA': 'NS',
  'NUNAVUT': 'NU', 'ONTARIO': 'ON', 'PRINCE EDWARD ISLAND': 'PE', 'QUEBEC': 'QC',
  'SASKATCHEWAN': 'SK', 'YUKON': 'YT',
};

function provinceCode(state) {
  if (!state) return '';
  const s = String(state).trim();
  if (s.length === 2) return s.toUpperCase();
  return PROV[s.toUpperCase()] || s.toUpperCase();
}

// Accepts a raw WooCommerce order object (webhook or REST) -> internal shape.
function normalizeOrder(o) {
  const ship = o.shipping && o.shipping.address_1 ? o.shipping : o.billing || {};
  const bill = o.billing || {};
  const name = `${ship.first_name || bill.first_name || ''} ${ship.last_name || bill.last_name || ''}`.trim();

  const lineItems = (o.line_items || []).map(li => ({
    name: li.name,
    sku: li.sku || '',
    quantity: Number(li.quantity || 1),
    price: Number(li.price || (Number(li.total || 0) / Math.max(1, Number(li.quantity || 1)))),
    productId: li.product_id,
  }));

  return {
    orderId: o.id || o.number,
    number: o.number || o.id,
    status: o.status,
    createdAt: o.date_created || o.date_created_gmt || null,
    value: Number(o.total || 0) || lineItems.reduce((s, li) => s + li.price * li.quantity, 0),
    currency: (o.currency || 'CAD').toLowerCase(),
    description: lineItems.map(li => li.name).join(', ').slice(0, 200),
    customerEmail: bill.email || '',
    shipping: {
      name: name || 'Customer',
      address_1: ship.address_1 || '',
      address_2: ship.address_2 || '',
      city: ship.city || '',
      province_code: provinceCode(ship.state),
      postal_code: (ship.postcode || '').toUpperCase(),
      country_code: (ship.country || 'CA').toUpperCase(),
      phone: ship.phone || bill.phone || '',
      email: bill.email || '',
    },
    lineItems,
  };
}

// Optional: pull a single order from the WooCommerce REST API (verification / re-fetch).
async function fetchOrder(store, orderId) {
  if (!store || !store.url || !store.consumerKey || !store.consumerSecret) {
    throw new Error('WooCommerce store not configured');
  }
  const base = store.url.replace(/\/+$/, '');
  const auth = Buffer.from(`${store.consumerKey}:${store.consumerSecret}`).toString('base64');
  const res = await fetch(`${base}/wp-json/wc/v3/orders/${orderId}`, {
    headers: { 'Authorization': `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`WooCommerce order fetch failed: HTTP ${res.status}`);
  return res.json();
}

module.exports = { verifySignature, normalizeOrder, fetchOrder, provinceCode };
