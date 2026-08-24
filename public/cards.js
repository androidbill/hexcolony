// Resource cards.
//
// One place that knows what a card looks like, so the hand, the build sheet, the trade
// screens and every picker all draw the same object. Everything returns an HTML string,
// because every caller is already building markup.
//
// The faces are the same tile illustrations the board uses, so a wheat card and a wheat
// field are recognisably the same thing. The zoom that crops them is worked out in
// styles.css — see .rcard-face, it is not arbitrary.

export const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

export const RES_NAME = {
  wood: 'Wood', brick: 'Brick', sheep: 'Sheep', wheat: 'Wheat', ore: 'Ore',
};

/**
 * One card.
 *
 * `count` draws the corner badge and, above one, the slivers of the cards behind it.
 * A stack reads as a stack at a glance, which is quicker than reading a number.
 */
export function resCard(res, {
  count = null, size = '', selected = false, dim = false, dataset = '', label = '', stack = true,
} = {}) {
  const cls = ['rcard', `rcard--${res}`];
  if (size) cls.push(`rcard--${size}`);
  if (selected) cls.push('is-selected');
  if (dim) cls.push('is-dim');

  // At most three, which is all that reads as depth before it turns to mush.
  const depth = stack && count && count > 1 ? Math.min(count - 1, 3) : 0;
  const edges = Array.from({ length: depth }, (_, i) =>
    `<span class="rcard-edge" style="--i:${depth - i}"></span>`).join('');

  const badge = (count !== null && count !== undefined)
    ? `<span class="rcard-count">${count}</span>` : '';
  const name = label ? `<span class="rcard-label">${label}</span>` : '';

  // The resource class goes on the WRAP as well as the card. It carries --rc, and the
  // stack edges are siblings of the card rather than children of it — so they could never
  // see that variable and every stack in the game has been drawing its edges in the grey
  // fallback colour instead of the resource's own.
  return `<span class="rcard-wrap rcard--${res}"${dataset}>${edges}`
    + `<span class="${cls.join(' ')}"><span class="rcard-face"></span>${badge}</span>`
    + `${name}</span>`;
}

/** The face-down development card: the one card with no tile behind it. */
export function devCard({ count = null, size = '', dim = false, dataset = '', label = '', stack = true } = {}) {
  const cls = ['rcard', 'rcard--dev'];
  if (size) cls.push(`rcard--${size}`);
  if (dim) cls.push('is-dim');
  const depth = stack && count && count > 1 ? Math.min(count - 1, 3) : 0;
  const edges = Array.from({ length: depth }, (_, i) =>
    `<span class="rcard-edge" style="--i:${depth - i}"></span>`).join('');
  const badge = (count !== null && count !== undefined)
    ? `<span class="rcard-count">${count}</span>` : '';
  const name = label ? `<span class="rcard-label">${label}</span>` : '';
  return `<span class="rcard-wrap rcard--dev"${dataset}>${edges}`
    + `<span class="${cls.join(' ')}"><span class="rcard-face rcard-face--dev">?</span>${badge}</span>`
    + `${name}</span>`;
}

/** A `{ wood: 2, ore: 1 }` style object as a row of cards. */
export function cardRow(counts, opts = {}) {
  const entries = Object.entries(counts || {}).filter(([, n]) => n > 0);
  if (!entries.length) return '<span class="rcard-none">nothing</span>';
  return entries.map(([res, n]) => resCard(res, { ...opts, count: n })).join('');
}

/** A cost, drawn as one card per unit — three ore reads faster than "3 ore". */
export function costRow(cost, have = null) {
  return Object.entries(cost).flatMap(([res, n]) =>
    Array.from({ length: n }, (_, i) => resCard(res, {
      size: 'xs',
      // Dim the units this player cannot currently cover.
      dim: have ? (have[res] || 0) < i + 1 : false,
    }))).join('');
}
