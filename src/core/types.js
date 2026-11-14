'use strict';
// USD value types and the in-memory values both parsers produce (USDA text and USDC binary), so the tree, the text
// view, the 3D preview, the checker and the compare tool read one model.
//
// Values:
//   number | boolean | string (string and token) | Asset { asset } | SdfPath { path } | Block (None)
//   array (vector, quaternion as [real, i, j, k], matrix as rows)
//   typed array (int, float, double ... arrays) | Tuples { data, n } (arrays of vectors) | plain arrays (strings, ...)
//   ListOp { explicit, items: { explicit, add, prepend, append, delete, order } }
//   Ref { asset, path, offset, scale, customData } (references and payloads)
//   Dict { entries: [[key, type, value]] }

class Asset { constructor(asset) { this.asset = String(asset || ''); } }
class SdfPath { constructor(path) { this.path = String(path || ''); } }
class Block { }
/** Metadata USD does not know, kept as its text (USDC stores it that way): printed without quotes. */
class Raw { constructor(text) { this.text = String(text); } }
const BLOCK = new Block();
class Tuples { constructor(data, n) { this.data = data; this.n = n; } get length() { return Math.floor(this.data.length / this.n); } at(i) { return Array.from(this.data.subarray(i * this.n, i * this.n + this.n)); } }
class ListOp {
  constructor(explicit, items) { this.explicit = !!explicit; this.items = items || {}; }
  /** Every item named in the op that adds something (explicit, add, prepend, append), in that order. */
  all() { const it = this.items; return [...(it.explicit || []), ...(it.prepend || []), ...(it.add || []), ...(it.append || [])]; }
}
class Ref { constructor(o) { Object.assign(this, { asset: '', path: '', offset: 0, scale: 1, customData: null }, o || {}); } }
class Dict { constructor(entries) { this.entries = entries || []; } get(k) { const e = this.entries.find((x) => x[0] === k); return e ? e[2] : undefined; } }

const ROLE_RE = /^(point|normal|vector|color|texCoord)([234])([hfd])$/;
const NUM_RE = /^(int|half|float|double)([234])$/;

/**
 * Type facts for a USD value type name: { base, n, rows, array }.
 * base: b (bool), uc, i, ui, i64, ui64, h, f, d, s (string), t (token), a (asset), q (quaternion), m (matrix),
 * none (opaque, group). n = components per element. rows = matrix rows.
 */
function typeInfo(name) {
  let t = String(name || '');
  const array = t.endsWith('[]');
  if (array) t = t.slice(0, -2);
  const simple = { bool: 'b', uchar: 'uc', int: 'i', uint: 'ui', int64: 'i64', uint64: 'ui64', half: 'h', float: 'f', double: 'd', timecode: 'd', string: 's', token: 't', asset: 'a', pathExpression: 's', opaque: 'none', group: 'none' }[t];
  if (simple) return { name: t, base: simple, n: 1, rows: 0, array };
  let m = NUM_RE.exec(t);
  if (m) return { name: t, base: { int: 'i', half: 'h', float: 'f', double: 'd' }[m[1]], n: Number(m[2]), rows: 0, array };
  m = ROLE_RE.exec(t);
  if (m) return { name: t, base: m[3], n: Number(m[2]), rows: 0, array };
  m = /^quat([hfd])$/.exec(t);
  if (m) return { name: t, base: 'q', elem: m[1], n: 4, rows: 0, array };
  m = /^(?:matrix([234])d|frame4d)$/.exec(t);
  if (m) { const r = m[1] ? Number(m[1]) : 4; return { name: t, base: 'm', n: r * r, rows: r, array }; }
  return { name: t, base: 'unknown', n: 1, rows: 0, array };
}

const f32 = new Float32Array(1);
/** Shortest decimal text that reads back as the same 32-bit float (USD prints floats this way). */
function fmtFloat(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (Object.is(x, -0)) return '-0';
  f32[0] = x;
  const v = f32[0];
  for (let p = 1; p <= 9; p++) {
    const s = Number(v.toPrecision(p));
    if (Math.fround(s) !== v) continue;
    // toPrecision rounds a tie up; USD rounds it to the even digit (0.330078125 prints as 0.33007812).
    const full = Math.abs(v).toExponential(99);
    const digits = full.slice(0, full.indexOf('e')).replace('.', '');
    const rest = digits.slice(p);
    if (/^50*$/.test(rest) && Number(digits[p - 1]) % 2 === 0) {
      const down = Number((v < 0 ? '-' : '') + digits[0] + '.' + digits.slice(1, p) + full.slice(full.indexOf('e')));
      if (Math.fround(down) === v) return String(down);
    }
    return String(s);
  }
  return String(v);
}
function fmtDouble(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (Object.is(x, -0)) return '-0';
  return String(x);
}
function numFmt(base) { return base === 'f' || base === 'h' ? fmtFloat : base === 'd' ? fmtDouble : (x) => String(x); }

/** Approximate equality used by the compare tool and the tests: floats within a relative 1e-5. */
function sameValue(a, b, tol = 1e-5) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
  if (a == null || b == null) return false;
  // Metadata USD does not know stays text in USDC ("false"), while the USDA parser reads false.
  if (a instanceof Raw) a = a.text;
  if (b instanceof Raw) b = b.text;
  if (a === b) return true;
  if (typeof a === 'string' && (typeof b === 'boolean' || typeof b === 'number')) return a === String(b);
  if (typeof b === 'string' && (typeof a === 'boolean' || typeof a === 'number')) return b === String(a);
  if (a instanceof Tuples || b instanceof Tuples) {
    const da = a instanceof Tuples ? a.data : flat(a), db = b instanceof Tuples ? b.data : flat(b);
    return sameValue(da, db, tol);
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b) || (Array.isArray(a) && Array.isArray(b))) {
    const x = Array.isArray(a) && a.some(Array.isArray) ? flat(a) : a, y = Array.isArray(b) && b.some(Array.isArray) ? flat(b) : b;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!sameValue(x[i], y[i], tol)) return false;
    return true;
  }
  if (a instanceof Asset && b instanceof Asset) return a.asset === b.asset;
  if (a instanceof SdfPath && b instanceof SdfPath) return a.path === b.path;
  if (a instanceof Block && b instanceof Block) return true;
  if (a instanceof ListOp && b instanceof ListOp) {
    const ka = Object.keys(a.items).filter((k) => a.items[k] && a.items[k].length), kb = Object.keys(b.items).filter((k) => b.items[k] && b.items[k].length);
    if (ka.sort().join() !== kb.sort().join()) return false;
    return ka.every((k) => sameValue(a.items[k], b.items[k], tol));
  }
  if (a instanceof Ref && b instanceof Ref) return a.asset === b.asset && a.path === b.path && a.offset === b.offset && a.scale === b.scale;
  if (a instanceof Dict && b instanceof Dict) {
    if (a.entries.length !== b.entries.length) return false;
    return a.entries.every(([k, , v]) => sameValue(v, b.get(k), tol));
  }
  return false;
}
function flat(a) { const out = []; const go = (x) => { if (Array.isArray(x) || ArrayBuffer.isView(x)) for (const y of x) go(y); else out.push(x); }; go(a); return out; }

/** Number of elements in an array value (or 1 for a scalar, 0 for none). */
function valueLength(v) {
  if (v == null) return 0;
  if (v instanceof Tuples) return v.length;
  if (ArrayBuffer.isView(v)) return v.length;
  if (Array.isArray(v)) return v.length;
  return 1;
}

module.exports = { Raw, Asset, SdfPath, Block, BLOCK, Tuples, ListOp, Ref, Dict, typeInfo, fmtFloat, fmtDouble, numFmt, sameValue, valueLength, flat };
