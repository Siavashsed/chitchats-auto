// ChitChats API client - zero dependency (Node 18+ global fetch)
// Docs: https://github.com/chitchats/chitchats-api-doc
//
// Auth: Authorization header carries the access token.
// Base (live):    https://chitchats.com/api/v1/clients/{client_id}
// Base (staging): https://staging.chitchats.com/api/v1/clients/{client_id}
//
// All money-spending happens in buyPostage(). Everything else is read/stage only.

function baseUrl(cfg) {
  const host = cfg.environment === 'staging'
    ? 'https://staging.chitchats.com'
    : 'https://chitchats.com';
  return `${host}/api/v1/clients/${cfg.clientId}`;
}

async function api(cfg, method, path, body) {
  if (!cfg.clientId || !cfg.accessToken) {
    throw new Error('ChitChats not configured (missing clientId / accessToken)');
  }
  const res = await fetch(`${baseUrl(cfg)}${path}`, {
    method,
    headers: {
      'Authorization': cfg.accessToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data && (data.error || data.message)
      ? (data.error || data.message)
      : `ChitChats ${method} ${path} -> HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Build a shipment payload from a normalized order + package + settings.
// If buyCheapest is true we ask ChitChats to pre-select the cheapest rate.
function buildShipmentPayload(order, pkg, settings, { cheapest = true } = {}) {
  const ship = order.shipping;
  const ret = settings.returnAddress || {};
  const payload = {
    name: ship.name,
    address_1: ship.address_1,
    address_2: ship.address_2 || '',
    city: ship.city,
    province_code: ship.province_code,
    postal_code: ship.postal_code,
    country_code: ship.country_code || 'CA',
    phone: ship.phone || '',
    email: ship.email || '',

    package_contents: 'merchandise',
    description: pkg.description || order.description || 'Merchandise',
    value: String(order.value || pkg.value || '20'),
    value_currency: (settings.valueCurrency || 'cad').toLowerCase(),

    package_type: pkg.package_type || 'parcel',
    weight_unit: pkg.weight_unit || 'g',
    weight: String(pkg.weight),
    size_unit: pkg.size_unit || 'cm',
    size_x: String(pkg.size_x),
    size_y: String(pkg.size_y),
    size_z: String(pkg.size_z),

    ship_date: settings.shipDate || 'today',

    order_id: String(order.orderId || ''),
    order_store: settings.orderStore || 'woocommerce',
  };

  // Return / sender address (optional but recommended)
  if (ret.name) {
    payload.return_name = ret.name;
    payload.return_address_1 = ret.address_1 || '';
    payload.return_address_2 = ret.address_2 || '';
    payload.return_city = ret.city || '';
    payload.return_province_code = ret.province_code || '';
    payload.return_postal_code = ret.postal_code || '';
    payload.return_phone = ret.phone || '';
  }

  if (cheapest) {
    payload.postage_type = 'unknown';
    payload.cheapest_postage_type_requested = 'yes';
  } else if (pkg.postage_type) {
    payload.postage_type = pkg.postage_type;
  }

  // International (non CA/US) needs line items
  const dest = (payload.country_code || '').toUpperCase();
  if (dest !== 'CA' && dest !== 'US' && Array.isArray(order.lineItems)) {
    payload.line_items = order.lineItems.map(li => ({
      description: li.name,
      quantity: li.quantity,
      value: String(li.price || '10'),
      value_currency: payload.value_currency,
      country_of_origin: 'CA',
    }));
  }

  return payload;
}

const Chitchats = {
  baseUrl,

  async createShipment(cfg, payload) {
    return api(cfg, 'POST', '/shipments', payload);
  },

  async getShipment(cfg, id) {
    return api(cfg, 'GET', `/shipments/${id}`);
  },

  // Spends money. Optionally pass a specific postage_type.
  async buyPostage(cfg, id, postageType) {
    return api(cfg, 'PATCH', `/shipments/${id}/buy`, postageType ? { postage_type: postageType } : undefined);
  },

  // Poll until ready / failed. Returns the final shipment object.
  async waitUntilReady(cfg, id, { tries = 12, delayMs = 2500 } = {}) {
    let last;
    for (let i = 0; i < tries; i++) {
      last = await Chitchats.getShipment(cfg, id);
      const s = last.shipment || last;
      const status = s.status;
      if (status === 'ready' || status === 'postage_purchase_failed') return last;
      await new Promise(r => setTimeout(r, delayMs));
    }
    return last;
  },

  buildShipmentPayload,
};

module.exports = Chitchats;
