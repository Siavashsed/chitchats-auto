// Dalmend box rules:
//   1 item  -> 24 x 21 x 11 cm
//   2 items -> 24 x 21 x 22 cm  (stacked, height doubles)
//   3+ items -> needsBoxSize: true  (always ask before buying)
//
// Weight: ChitChats has item weights configured; we pass a per-item default
// so the API is happy. Adjust DEFAULT_ITEM_GRAMS if needed.

const DEFAULT_ITEM_GRAMS = 500; // grams per item (rough default for postage calc)
const TARE_GRAMS = 150;         // box + padding + card

function computePackage(order) {
  const items = order.lineItems || [];
  let totalQty = 0;
  const names = [];
  for (const it of items) {
    const qty = Number(it.quantity || 1);
    totalQty += qty;
    names.push(`${qty}x ${it.name}`);
  }
  if (totalQty === 0) totalQty = 1;

  const summary = names.join(', ');
  const weight = Math.max(1, totalQty * DEFAULT_ITEM_GRAMS + TARE_GRAMS);

  if (totalQty === 1) {
    return {
      boxName: '1 item (24x21x11)',
      package_type: 'parcel',
      weight, weight_unit: 'g',
      size_unit: 'cm',
      size_x: 24, size_y: 21, size_z: 11,
      description: 'Scented candle (home decor)',
      totalQty, summary,
      needsBoxSize: false,
    };
  }

  if (totalQty === 2) {
    return {
      boxName: '2 items stacked (24x21x22)',
      package_type: 'parcel',
      weight, weight_unit: 'g',
      size_unit: 'cm',
      size_x: 24, size_y: 21, size_z: 22,
      description: 'Scented candles (home decor)',
      totalQty, summary,
      needsBoxSize: false,
    };
  }

  // 3+ items: flag for manual box size input before buying
  return {
    boxName: `${totalQty} items — box size needed`,
    package_type: 'parcel',
    weight, weight_unit: 'g',
    size_unit: 'cm',
    size_x: 0, size_y: 0, size_z: 0,
    description: 'Scented candles (home decor)',
    totalQty, summary,
    needsBoxSize: true,
  };
}

// Legacy compat: some callers pass (order, rules) — rules ignored now
function computePackageCompat(order, _rules) {
  return computePackage(order);
}

const DEFAULT_RULES = {}; // kept for import compat

module.exports = { computePackage, computePackageCompat, DEFAULT_RULES };
