// Package mapping engine: order line items + qty -> box preset + total weight.
//
// Rules are user-editable in the dashboard (data/settings.json -> packaging).
// Strategy:
//   1. Sum per-item weight (match by sku, then product name contains, else default).
//   2. Add packaging tare weight.
//   3. Total quantity picks the smallest box preset whose maxQty >= qty.
//      Box preset gives dimensions; weight stays the computed sum.

function matchItemWeight(item, rules) {
  const sku = (item.sku || '').toLowerCase();
  const name = (item.name || '').toLowerCase();
  for (const r of rules.itemWeights || []) {
    const m = (r.match || '').toLowerCase();
    if (!m) continue;
    if (r.field === 'sku' && sku && sku === m) return Number(r.grams);
    if (r.field === 'name' && name.includes(m)) return Number(r.grams);
    if (!r.field && (sku === m || name.includes(m))) return Number(r.grams);
  }
  return Number(rules.defaultItemGrams ?? 350);
}

function pickBox(totalQty, rules) {
  const boxes = [...(rules.boxes || [])].sort((a, b) => (a.maxQty || 0) - (b.maxQty || 0));
  for (const b of boxes) {
    if (totalQty <= (b.maxQty || 0)) return b;
  }
  // Fall back to the largest box if qty exceeds all presets.
  return boxes[boxes.length - 1] || {
    name: 'Default', size_x: 20, size_y: 15, size_z: 10, size_unit: 'cm',
  };
}

function computePackage(order, rules) {
  rules = rules || {};
  const items = order.lineItems || [];
  let totalQty = 0;
  let contentWeight = 0;
  const names = [];
  for (const it of items) {
    const qty = Number(it.quantity || 1);
    totalQty += qty;
    contentWeight += matchItemWeight(it, rules) * qty;
    names.push(`${qty}x ${it.name}`);
  }
  if (totalQty === 0) { totalQty = 1; contentWeight = Number(rules.defaultItemGrams ?? 350); }

  const tare = Number(rules.packagingTareGrams ?? 120);
  const box = pickBox(totalQty, rules);
  const weight = Math.max(1, Math.round(contentWeight + tare));

  return {
    boxName: box.name,
    package_type: box.package_type || 'parcel',
    weight,
    weight_unit: 'g',
    size_unit: box.size_unit || 'cm',
    size_x: Number(box.size_x),
    size_y: Number(box.size_y),
    size_z: Number(box.size_z),
    postage_type: box.postage_type || '',
    description: rules.description || 'Home decor',
    value: order.value,
    totalQty,
    summary: names.join(', '),
  };
}

// Sensible Dalmend candle defaults (grams / cm).
const DEFAULT_RULES = {
  defaultItemGrams: 450,        // a typical candle
  packagingTareGrams: 150,      // box + filler + card
  description: 'Scented candle (home decor)',
  itemWeights: [
    { field: 'name', match: 'body candle', grams: 600 },
    { field: 'name', match: 'candle', grams: 450 },
    { field: 'name', match: 'slipper', grams: 250 },
  ],
  boxes: [
    { name: 'Small (1 item)',  maxQty: 1, size_x: 15, size_y: 12, size_z: 10, size_unit: 'cm', package_type: 'parcel' },
    { name: 'Medium (2-3)',    maxQty: 3, size_x: 25, size_y: 20, size_z: 12, size_unit: 'cm', package_type: 'parcel' },
    { name: 'Large (4-6)',     maxQty: 6, size_x: 35, size_y: 25, size_z: 18, size_unit: 'cm', package_type: 'parcel' },
  ],
};

module.exports = { computePackage, DEFAULT_RULES };
