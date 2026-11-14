'use strict';
// Compares two layers as prim trees: prims added and removed, type and specifier changes, metadata changes, and
// property changes (type, default value, time samples, connections, targets, metadata). Array values report their
// lengths and the first index that differs. Used by the Pro compare tool and by the tests that check the USDC reader
// against the USDA parser.
const { sameValue, Tuples, valueLength, ListOp, Block } = require('./types');
const { generic, typed } = require('./usda-write');

function primMap(layer) {
  const m = new Map();
  const go = (p) => {
    for (const c of p.children) { m.set(c.path, c); go(c); for (const vs of c.variantSets) for (const v of vs.variants) { m.set(v.prim.path, v.prim); go(v.prim); } }
  };
  go(layer.root);
  return m;
}

function firstDiffIndex(a, b, tol) {
  const n = Math.min(valueLength(a), valueLength(b));
  const at = (v, i) => (v instanceof Tuples ? v.at(i) : v[i]);
  for (let i = 0; i < n; i++) if (!sameValue(at(a, i), at(b, i), tol)) return i;
  return valueLength(a) === valueLength(b) ? -1 : n;
}

function short(v, typeName) {
  if (v === undefined) return '(not set)';
  let s;
  try { s = typeName ? typed(v, typeName, { maxArray: 6 }) : generic(v); } catch (e) { s = String(v); }
  s = s.replace(/\s+/g, ' ');
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}

function describeValue(a, b, typeName, tol) {
  const isArr = (v) => v instanceof Tuples || ArrayBuffer.isView(v) || (Array.isArray(v) && typeName && typeName.endsWith('[]'));
  if (isArr(a) && isArr(b)) {
    const i = firstDiffIndex(a, b, tol);
    const la = valueLength(a), lb = valueLength(b);
    if (la !== lb) return `${la.toLocaleString('en-US')} values, now ${lb.toLocaleString('en-US')}` + (i >= 0 && i < Math.min(la, lb) ? `; first difference at index ${i}` : '');
    const at = (v) => (v instanceof Tuples ? v.at(i) : v[i]);
    return `${la.toLocaleString('en-US')} values; first difference at index ${i}: ${short(at(a), typeName.replace('[]', ''))} -> ${short(at(b), typeName.replace('[]', ''))}`;
  }
  return `${short(a, typeName)} -> ${short(b, typeName)}`;
}

const PROP_FIELDS = ['typeName', 'variability', 'custom'];

/**
 * opts: { tol, ignoreRelVariability }. Returns { added: [path], removed: [path], changed: [{ path, field, detail }],
 * same: number of prims with no change, primsA, primsB }.
 */
function diffLayers(a, b, opts = {}) {
  const tol = opts.tol === undefined ? 1e-6 : opts.tol;
  const ma = primMap(a), mb = primMap(b);
  const added = [], removed = [], changed = [];
  let same = 0;
  const metaDiff = (path, x, y, what) => {
    const keys = new Set([...x.keys(), ...y.keys()]);
    for (const k of keys) {
      const va = x.get(k), vb = y.get(k);
      if (va === undefined && vb instanceof ListOp && !vb.all().length && !vb.explicit) continue;
      if (!sameValue(va, vb, tol)) changed.push({ path, field: `${what}${k}`, detail: describeValue(va, vb, '', tol) });
    }
  };
  for (const [path, pa] of ma) {
    const pb = mb.get(path);
    if (!pb) { removed.push(path); continue; }
    const before = changed.length;
    if ((pa.typeName || '') !== (pb.typeName || '')) changed.push({ path, field: 'type', detail: `${pa.typeName || '(none)'} -> ${pb.typeName || '(none)'}` });
    if ((pa.specifier || '') !== (pb.specifier || '')) changed.push({ path, field: 'specifier', detail: `${pa.specifier} -> ${pb.specifier}` });
    metaDiff(path, pa.meta, pb.meta, 'metadata ');
    const names = new Set([...pa.props.map((p) => p.name), ...pb.props.map((p) => p.name)]);
    for (const n of names) {
      const x = pa.prop(n), y = pb.prop(n);
      const pp = `${path}.${n}`;
      if (!x) { changed.push({ path: pp, field: 'property added', detail: `${y.kind === 'relationship' ? 'rel' : y.typeName}` }); continue; }
      if (!y) { changed.push({ path: pp, field: 'property removed', detail: `${x.kind === 'relationship' ? 'rel' : x.typeName}` }); continue; }
      for (const f of PROP_FIELDS) {
        if (f === 'variability' && (x.kind === 'relationship' || opts.ignoreRelVariability)) { if (x.kind === 'relationship') continue; }
        if ((x[f] || '') !== (y[f] || '')) changed.push({ path: pp, field: f, detail: `${x[f] || '(none)'} -> ${y[f] || '(none)'}` });
      }
      if (!sameValue(x.value, y.value, tol) && !(x.value === undefined && y.value === undefined)) changed.push({ path: pp, field: 'value', detail: describeValue(x.value, y.value, x.typeName || y.typeName, tol) });
      const ts = (p) => p.timeSamples || [];
      if (ts(x).length !== ts(y).length) changed.push({ path: pp, field: 'time samples', detail: `${ts(x).length} samples, now ${ts(y).length}` });
      else for (let i = 0; i < ts(x).length; i++) {
        const [t1, v1] = ts(x)[i], [t2, v2] = ts(y)[i];
        if (!sameValue(t1, t2, tol) || !sameValue(v1, v2, tol)) { changed.push({ path: pp, field: 'time samples', detail: `sample ${i} (time ${t1}): ${describeValue(v1, v2, x.typeName, tol)}` }); break; }
      }
      if (!sameValue(x.connect || undefined, y.connect || undefined, tol) && (x.connect || y.connect)) changed.push({ path: pp, field: 'connections', detail: `${short(x.connect && x.connect.all())} -> ${short(y.connect && y.connect.all())}` });
      if (!sameValue(x.targets || undefined, y.targets || undefined, tol) && (x.targets || y.targets)) changed.push({ path: pp, field: 'targets', detail: `${short(x.targets && x.targets.all())} -> ${short(y.targets && y.targets.all())}` });
      metaDiff(pp, x.meta, y.meta, 'metadata ');
    }
    if (changed.length === before) same++;
  }
  for (const path of mb.keys()) if (!ma.has(path)) added.push(path);
  const lm = [];
  const keys = new Set([...a.meta.keys(), ...b.meta.keys()]);
  for (const k of keys) {
    const va = a.meta.get(k), vb = b.meta.get(k);
    const norm = (v) => (Array.isArray(v) ? v.map((x) => (x && x.asset !== undefined ? `${x.asset}|${x.offset}|${x.scale}` : x)) : v);
    if (!sameValue(norm(va), norm(vb), tol)) lm.push({ path: '(layer)', field: `metadata ${k}`, detail: describeValue(va, vb, '', tol) });
  }
  return { added, removed, changed: lm.concat(changed), same, primsA: ma.size, primsB: mb.size };
}

function isBlock(v) { return v instanceof Block; }

module.exports = { diffLayers, primMap, firstDiffIndex, isBlock };
