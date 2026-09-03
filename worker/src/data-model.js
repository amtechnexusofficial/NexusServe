/**
 * Branch + stock helpers — flexible N branches, with legacy b1/b2/b3 migration.
 * Identical logic to the Node version, no Node-specific APIs used.
 */

export const DEFAULT_BRANCH_DEFS = [
  { id: 'b1', name: 'Main Branch', defaultPin: '1111' },
  { id: 'b2', name: 'Counter 2', defaultPin: '2222' },
  { id: 'b3', name: 'Delivery Unit', defaultPin: '3333' }
];

export function legacyStockKey(branchId) {
  return `${branchId}Stock`;
}

export function normalizeBranches(tenant = {}) {
  if (Array.isArray(tenant.branches) && tenant.branches.length > 0) {
    return tenant.branches.map((b, i) => ({
      id: String(b.id || `b${i + 1}`),
      name: b.name || `Branch ${i + 1}`,
      sortOrder: b.sortOrder != null ? Number(b.sortOrder) : i
    })).sort((a, b) => a.sortOrder - b.sortOrder);
  }
  const out = [];
  for (let i = 1; i <= 3; i++) {
    const id = `b${i}`;
    const name = tenant[`${id}name`] || DEFAULT_BRANCH_DEFS[i - 1].name;
    out.push({ id, name, sortOrder: i - 1 });
  }
  return out;
}

export function ensureTenantBranches(tenant) {
  const branches = normalizeBranches(tenant);
  tenant.branches = branches;
  for (const b of branches) {
    if (/^b[1-9]\d*$/.test(b.id)) {
      tenant[`${b.id}name`] = b.name;
    }
  }
  return branches;
}

export function getProductStockMap(product = {}, branchIds = []) {
  const map = {};
  if (product.stock && typeof product.stock === 'object') {
    for (const [k, v] of Object.entries(product.stock)) {
      map[k] = Number(v) || 0;
    }
  }
  const ids = branchIds.length ? branchIds : ['b1', 'b2', 'b3', ...Object.keys(map)];
  for (const id of ids) {
    if (map[id] == null) {
      const legacy = product[legacyStockKey(id)];
      if (legacy != null) map[id] = Number(legacy) || 0;
      else map[id] = 0;
    }
  }
  return map;
}

export function getStock(product, branchId) {
  const map = getProductStockMap(product, [branchId]);
  return Number(map[branchId]) || 0;
}

export function setStock(product, branchId, qty) {
  const n = Math.max(0, Number(qty) || 0);
  if (!product.stock || typeof product.stock !== 'object') {
    product.stock = getProductStockMap(product);
  }
  product.stock[branchId] = n;
  if (/^b[1-9]\d*$/.test(branchId)) {
    product[legacyStockKey(branchId)] = n;
  }
  return n;
}

export function applyStockDelta(product, branchId, delta) {
  const next = getStock(product, branchId) + Number(delta || 0);
  return setStock(product, branchId, next);
}

export function normalizeProduct(product, branches = []) {
  const branchIds = branches.map(b => b.id);
  const stock = getProductStockMap(product, branchIds);
  product.stock = stock;
  for (const id of branchIds) {
    if (/^b[1-9]\d*$/.test(id)) {
      product[legacyStockKey(id)] = stock[id] || 0;
    }
  }
  return product;
}

export function staffRolesForTenant(tenant) {
  const branches = normalizeBranches(tenant);
  return ['admin', ...branches.map(b => b.id)];
}

export function isValidStaffRole(tenant, role) {
  return staffRolesForTenant(tenant).includes(role);
}

export function branchLabel(tenant, branchId) {
  if (branchId === 'admin') return 'Admin';
  const b = normalizeBranches(tenant).find(x => x.id === branchId);
  if (b) return b.name;
  return tenant[`${branchId}name`] || branchId;
}
