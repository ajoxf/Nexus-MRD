/*
 * Panel order.
 *
 * A trader arranging their own screen is a preference, not a setting: it changes nothing about
 * what any number means. It is kept in prefs for that reason, next to "hide figures".
 *
 * The saved order is a wish, not a contract. Panels appear and disappear between releases and
 * between accounts — the Close account panel only exists on the hosted build — so an order read
 * back from storage is reconciled against what is actually on the page rather than trusted. A
 * layout saved last month must never blank a panel added since, or leave a hole where one went.
 */

// The saved order, filtered to panels that exist, with anything new appended in its natural place.
export function applyOrder(ids, saved) {
  const known = new Set(ids);
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(saved) ? saved : []) {
    if (known.has(id) && !seen.has(id)) { out.push(id); seen.add(id); }
  }
  for (const id of ids) if (!seen.has(id)) out.push(id);
  return out;
}

// Drop `id` at position `to`, counted in the list as it stands once `id` has been lifted out.
export function moveTo(order, id, to) {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const rest = order.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

// One step either way, for the keyboard. Stops at the ends rather than wrapping: a panel that
// leapt from the last position to the first would read as a bug.
export function moveBy(order, id, delta) {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const to = from + delta;
  if (to < 0 || to >= order.length) return order;
  return moveTo(order, id, to);
}

// Whether a saved order still says anything, once reconciled — what decides if "Reset layout"
// is worth offering. An order that happens to match the natural one is not a customisation.
export const isCustomised = (ids, saved) => {
  const applied = applyOrder(ids, saved);
  return applied.length === ids.length && applied.some((id, i) => id !== ids[i]);
};
