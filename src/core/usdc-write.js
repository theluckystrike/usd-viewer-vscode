'use strict';
// USDC (crate 0.8.0) writer for the Pro converter: layer model -> binary. Value data first, then the TOKENS,
// STRINGS, FIELDS, FIELDSETS, PATHS and SPECS sections (LZ4-wrapped, integer-coded like USD writes them), then the
// table of contents. Arrays are written uncompressed; small scalar values are inlined in their value rep as USD does.
// The tests read every output back with usdc.js, and the release check ran /usr/bin/usdcat on the outputs.
const { fastCompress, encodeInts } = require('./compress');
const { Raw, Asset, SdfPath, Block, Tuples, ListOp, Ref, Dict, typeInfo } = require('./types');
const { TYPE } = require('./usdc');

const SPEC = { attribute: 1, prim: 6, pseudoRoot: 7, relationship: 8, variant: 10, variantSet: 11 };

// Metadata field types (the USD schema of known fields). Anything else is written as an unregistered value.
const FIELD = {
  defaultPrim: 'token', upAxis: 'token', metersPerUnit: 'double', kilogramsPerUnit: 'double', startTimeCode: 'double', endTimeCode: 'double',
  timeCodesPerSecond: 'double', framesPerSecond: 'double', documentation: 'string', comment: 'string', customLayerData: 'dictionary',
  owner: 'string', colorConfiguration: 'asset', colorManagementSystem: 'token', framePrecision: 'int', expressionVariables: 'dictionary',
  renderSettingsPrimPath: 'string',
  kind: 'token', active: 'bool', hidden: 'bool', instanceable: 'bool', displayName: 'string', displayGroup: 'string', customData: 'dictionary',
  assetInfo: 'dictionary', apiSchemas: 'TokenListOp', references: 'ReferenceListOp', payload: 'PayloadListOp', inheritPaths: 'PathListOp',
  specializes: 'PathListOp', variantSelection: 'VariantSelectionMap', variantSetNames: 'StringListOp', permission: 'Permission',
  symmetryFunction: 'token', prefixSubstitutions: 'dictionary', suffixSubstitutions: 'dictionary', clips: 'dictionary', sdrMetadata: 'dictionary',
  interpolation: 'token', elementSize: 'int', colorSpace: 'token', allowedTokens: 'TokenVector', renderType: 'token', limits: 'dictionary',
  noLoadHint: 'bool', instanceable_: 'bool', symmetricPeer: 'string', symmetryArguments: 'dictionary', displayUnit: 'token',
};
const FIELD_NAME = { doc: 'documentation', variants: 'variantSelection', variantSets: 'variantSetNames', inherits: 'inheritPaths' };

class Out {
  constructor() { this.buf = new Uint8Array(1 << 16); this.n = 0; }
  ensure(k) { if (this.n + k > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k)); b.set(this.buf.subarray(0, this.n)); this.buf = b; } }
  get dv() { return new DataView(this.buf.buffer); }
  u8(v) { this.ensure(1); this.buf[this.n++] = v; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.n, v >>> 0, true); this.n += 4; }
  i32(v) { this.ensure(4); this.dv.setInt32(this.n, v | 0, true); this.n += 4; }
  u64(v) { this.ensure(8); this.dv.setBigUint64(this.n, BigInt(Math.max(0, Math.floor(v))), true); this.n += 8; }
  i64(v) { this.ensure(8); this.dv.setBigInt64(this.n, BigInt(Math.trunc(v)), true); this.n += 8; }
  f16(v) { this.ensure(2); this.dv.setUint16(this.n, toHalf(v), true); this.n += 2; }
  f32(v) { this.ensure(4); this.dv.setFloat32(this.n, v, true); this.n += 4; }
  f64(v) { this.ensure(8); this.dv.setFloat64(this.n, v, true); this.n += 8; }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.n); this.n += b.length; }
  align(k) { while (this.n % k) this.u8(0); }
  patch64(at, v) { this.dv.setBigUint64(at, BigInt(v), true); }
  result() { return this.buf.slice(0, this.n); }
}

function toHalf(v) {
  const f = new Float32Array([v]);
  const x = new Uint32Array(f.buffer)[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (((x >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) { if (e < -10) return sign; m |= 0x800000; const shift = 14 - e; let h = m >> shift; if ((m >> (shift - 1)) & 1) h++; return sign | h; }
  let h = sign | (e << 10) | (m >> 13);
  if (m & 0x1000) h++;
  return h;
}

// rep: [lo32, hi32]
function rep(type, payload, { array = false, inlined = false } = {}) {
  const hi = ((array ? 0x80000000 : 0) | (inlined ? 0x40000000 : 0) | ((type & 0xff) << 16) | Math.floor(payload / 4294967296)) >>> 0;
  return [payload % 4294967296 >>> 0, hi];
}

function scalarKind(ti) {
  if (ti.base === 'q') return { type: { d: 'quatd', f: 'quatf', h: 'quath' }[ti.elem], comp: ti.elem === 'd' ? 'f64' : ti.elem === 'h' ? 'f16' : 'f32', n: 4 };
  if (ti.base === 'm') return { type: `matrix${ti.rows}d`, comp: 'f64', n: ti.n };
  const comp = { b: 'b', uc: 'u8', i: 'i32', ui: 'u32', i64: 'i64', ui64: 'u64', h: 'f16', f: 'f32', d: 'f64' }[ti.base];
  if (!comp) return null;
  if (ti.n === 1) return { type: ti.name === 'timecode' ? 'timecode' : { b: 'bool', uc: 'uchar', i: 'int', ui: 'uint', i64: 'int64', ui64: 'uint64', h: 'half', f: 'float', d: 'double' }[ti.base], comp, n: 1 };
  return { type: `${{ i: 'int', h: 'half', f: 'float', d: 'double' }[ti.base]}${ti.n}`, comp, n: ti.n };
}

/** Writes a layer as USDC bytes. */
function writeUsdc(layer) {
  const out = new Out();
  out.bytes(new Uint8Array(88)); // bootstrap, filled at the end
  const tokens = [''], tokenIdx = new Map([['', 0]]);
  const tok = (s) => { s = String(s); let i = tokenIdx.get(s); if (i === undefined) { i = tokens.length; tokens.push(s); tokenIdx.set(s, i); } return i; };
  const strings = [], stringIdx = new Map();
  const str = (s) => { s = String(s); let i = stringIdx.get(s); if (i === undefined) { i = strings.length; strings.push(tok(s)); stringIdx.set(s, i); } return i; };

  // ---------- paths ----------
  const pathNodes = new Map(); // path -> { parent, elem, prop, kids: [] }
  pathNodes.set('/', { parent: null, elem: '', prop: false, kids: [] });
  function addPath(p) {
    if (pathNodes.has(p)) return p;
    const parts = splitPath(p);
    let cur = '/';
    for (const part of parts) {
      const next = part.prop ? `${cur}.${part.name}` : part.variant ? `${cur}${part.name}` : cur === '/' ? `/${part.name}` : cur.endsWith('}') ? `${cur}${part.name}` : `${cur}/${part.name}`;
      if (!pathNodes.has(next)) { pathNodes.set(next, { parent: cur, elem: part.name, prop: part.prop, kids: [] }); pathNodes.get(cur).kids.push(next); }
      cur = next;
    }
    return cur;
  }
  const pathIndex = new Map(); // filled after all paths are known
  const pathRefs = []; // [out offset, path] patched later
  const writePathIdx = (p) => { pathRefs.push([out.n, p]); out.u32(0); };

  // ---------- values ----------
  const writeComp = (comp, v) => {
    const x = Number(v) || 0;
    switch (comp) {
      case 'b': out.u8(v ? 1 : 0); break;
      case 'u8': out.u8(x & 0xff); break;
      case 'i32': out.i32(x); break;
      case 'u32': out.u32(x); break;
      case 'i64': out.i64(x); break;
      case 'u64': out.u64(x); break;
      case 'f16': out.f16(x); break;
      case 'f32': out.f32(x); break;
      default: out.f64(x);
    }
  };
  const flatComps = (v, sk) => {
    if (sk.type.startsWith('quat')) { const q = Array.from(v); return [q[1], q[2], q[3], q[0]]; } // stored i, j, k, real
    if (sk.type.startsWith('matrix')) return Array.isArray(v[0]) ? v.flat() : Array.from(v);
    return sk.n === 1 ? [v] : Array.from(v);
  };
  function inlineScalar(sk, v) {
    const T = TYPE[sk.type];
    if (sk.n !== 1) return null;
    switch (sk.comp) {
      case 'b': return rep(T, v ? 1 : 0, { inlined: true });
      case 'u8': return rep(T, (Number(v) || 0) & 0xff, { inlined: true });
      case 'i32': return rep(T, (Number(v) | 0) >>> 0, { inlined: true });
      case 'u32': return rep(T, (Number(v) >>> 0), { inlined: true });
      case 'f16': return rep(T, toHalf(Number(v)), { inlined: true });
      case 'f32': { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, Number(v), true); return rep(T, b.getUint32(0, true), { inlined: true }); }
      case 'f64': { const f = Math.fround(Number(v)); if (f === Number(v) || Number.isNaN(Number(v))) { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, f, true); return rep(T, b.getUint32(0, true), { inlined: true }); } return null; }
      default: return null;
    }
  }
  /** A value of a declared USD type (attribute values, typed dictionary entries). */
  function packTyped(v, typeName) {
    if (v instanceof Block || v === null) return rep(TYPE.ValueBlock, 0, { inlined: true });
    const ti = typeInfo(typeName);
    if (ti.base === 's' || ti.base === 't' || ti.base === 'a') {
      const T = TYPE[{ s: 'string', t: 'token', a: 'asset' }[ti.base]];
      const idx = (x) => (ti.base === 's' ? str(x) : tok(x instanceof Asset ? x.asset : x));
      if (!ti.array) return rep(T, idx(v instanceof Asset ? v.asset : v), { inlined: true });
      const items = Array.from(v || []);
      const items2 = items.map((x) => idx(x instanceof Asset ? x.asset : x));
      out.align(8);
      const at = out.n;
      out.u64(items2.length);
      for (const i of items2) out.u32(i);
      return rep(T, at, { array: true });
    }
    const sk = scalarKind(ti);
    if (!sk) return packGeneric(v);
    const T = TYPE[sk.type];
    if (!ti.array) {
      const inl = inlineScalar(sk, v);
      if (inl) return inl;
      out.align(8);
      const at = out.n;
      for (const c of flatComps(v, sk)) writeComp(sk.comp, c);
      return rep(T, at);
    }
    out.align(8);
    const at = out.n;
    let flat;
    if (v instanceof Tuples) {
      flat = Array.from(v.data);
      if (sk.type.startsWith('quat')) { const q = []; for (let i = 0; i < flat.length; i += 4) q.push(flat[i + 1], flat[i + 2], flat[i + 3], flat[i]); flat = q; }
    } else if (sk.type.startsWith('matrix')) flat = Array.from(v || []).flatMap((m) => (Array.isArray(m[0]) ? m.flat() : Array.from(m)));
    else flat = Array.from(v || []).map((x) => (typeof x === 'boolean' ? (x ? 1 : 0) : x));
    const count = Math.floor(flat.length / sk.n);
    out.u64(count);
    for (let i = 0; i < count * sk.n; i++) writeComp(sk.comp, flat[i]);
    return rep(T, at, { array: true });
  }

  function packDict(d) {
    // value data first, then the entries (key, offset 8, rep)
    const reps = d.entries.map(([k, t, v]) => [k, t === 'dictionary' || v instanceof Dict ? packDict(v instanceof Dict ? v : new Dict([])) : t && t !== 'None' ? packTyped(v, t) : packGeneric(v)]);
    out.align(8);
    const at = out.n;
    out.u64(reps.length);
    for (const [k, r] of reps) { out.u32(str(k)); out.i64(8); out.u32(r[0]); out.u32(r[1]); }
    return rep(TYPE.dictionary, at);
  }

  function packListOp(op, typeName, item) {
    const it = op.items || {};
    const has = (k) => Array.isArray(it[k]) && (it[k].length || (k === 'explicit' && op.explicit));
    let h = op.explicit ? 1 : 0;
    if (has('explicit')) h |= 2;
    if (has('add')) h |= 4;
    if (has('delete')) h |= 8;
    if (has('order')) h |= 16;
    if (has('prepend')) h |= 32;
    if (has('append')) h |= 64;
    out.align(8);
    const at = out.n;
    out.u8(h);
    for (const k of ['explicit', 'add', 'prepend', 'append', 'delete', 'order']) {
      if (!(h & { explicit: 2, add: 4, prepend: 32, append: 64, delete: 8, order: 16 }[k])) continue;
      const list = it[k] || [];
      out.u64(list.length);
      for (const x of list) item(x);
    }
    return rep(TYPE[typeName], at);
  }
  const refItem = (withDict, withOffset) => (r) => {
    out.u32(str(r.asset || ''));
    writePathIdx(r.path ? addPath(r.path) : '');
    if (withOffset) { out.f64(r.offset || 0); out.f64(r.scale === undefined ? 1 : r.scale); }
    if (withDict) { out.u64(0); } // customData is not carried over (written as an empty dictionary)
  };

  /** A metadata value: the known field type when there is one, else from the value itself. */
  function packField(name, v, primPath) {
    const ft = FIELD[name];
    if (v instanceof Raw) {
      const r = packTyped(v.text, 'string');
      out.align(8);
      const at = out.n;
      out.i64(8); out.u32(r[0]); out.u32(r[1]);
      return rep(TYPE.UnregisteredValue, at);
    }
    switch (ft) {
      case 'TokenListOp': return packListOp(asListOp(v), 'TokenListOp', (x) => out.u32(tok(x)));
      case 'StringListOp': return packListOp(asListOp(v), 'StringListOp', (x) => out.u32(str(x)));
      case 'PathListOp': return packListOp(asListOp(v), 'PathListOp', (x) => writePathIdx(addPath(absolute(x.path || String(x), primPath))));
      case 'ReferenceListOp': return packListOp(asListOp(v), 'ReferenceListOp', refItem(true, true));
      case 'PayloadListOp': return packListOp(asListOp(v), 'PayloadListOp', refItem(false, true));
      case 'VariantSelectionMap': {
        const d = v instanceof Dict ? v : new Dict([]);
        out.align(8);
        const at = out.n;
        out.u64(d.entries.length);
        for (const [k, , x] of d.entries) { out.u32(str(k)); out.u32(str(x)); }
        return rep(TYPE.VariantSelectionMap, at);
      }
      case 'TokenVector': {
        const items = Array.from(v || []);
        out.align(8);
        const at = out.n;
        out.u64(items.length);
        for (const x of items) out.u32(tok(x));
        return rep(TYPE.TokenVector, at);
      }
      case 'Permission': return rep(TYPE.Permission, v === 'private' ? 1 : 0, { inlined: true });
      case 'dictionary': return packDict(v instanceof Dict ? v : new Dict([]));
      case undefined: return packGeneric(v);
      default: return packTyped(v, ft);
    }
  }
  function packGeneric(v) {
    if (v instanceof Dict) return packDict(v);
    if (v instanceof Asset) return packTyped(v, 'asset');
    if (v instanceof Block || v === null || v === undefined) return rep(TYPE.ValueBlock, 0, { inlined: true });
    if (typeof v === 'boolean') return packTyped(v, 'bool');
    if (typeof v === 'number') return packTyped(v, Number.isInteger(v) && Math.abs(v) < 2 ** 31 ? 'int' : 'double');
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return packTyped(v, 'string[]');
    if (Array.isArray(v) && v.every((x) => typeof x === 'number')) return packTyped(v, 'double[]');
    if (v instanceof Tuples) return packTyped(v, v.n === 2 ? 'double2[]' : v.n === 4 ? 'double4[]' : 'double3[]');
    return packTyped(String(v instanceof SdfPath ? v.path : v), 'string');
  }
  function tokenVector(items) {
    out.align(8);
    const at = out.n;
    out.u64(items.length);
    for (const x of items) out.u32(tok(x));
    return rep(TYPE.TokenVector, at);
  }
  function timeSamples(samples, typeName) {
    const reps = samples.map(([, v]) => packTyped(v, typeName));
    out.align(8);
    const timesAt = out.n;
    out.u64(samples.length);
    for (const [t] of samples) out.f64(t);
    const timesRep = rep(TYPE.DoubleVector, timesAt);
    out.align(8);
    const at = out.n;
    out.i64(8); out.u32(timesRep[0]); out.u32(timesRep[1]);
    out.i64(8); out.u64(reps.length);
    for (const r of reps) { out.u32(r[0]); out.u32(r[1]); }
    return rep(TYPE.TimeSamples, at);
  }

  // ---------- specs ----------
  const specs = []; // [path, type, [[fieldName, rep]]]
  const variability = (v) => rep(TYPE.Variability, v === 'uniform' ? 1 : v === 'config' ? 2 : 0, { inlined: true });
  function primFields(prim, isVariant) {
    const f = [];
    if (!isVariant) {
      f.push(['specifier', rep(TYPE.Specifier, { def: 0, over: 1, class: 2 }[prim.specifier || 'def'] || 0, { inlined: true })]);
      if (prim.typeName) f.push(['typeName', rep(TYPE.token, tok(prim.typeName), { inlined: true })]);
    }
    for (const [k, v] of prim.meta) { if (v === undefined) continue; const name = FIELD_NAME[k] || k; f.push([name, packField(name, v, prim.path)]); }
    if (prim.variantSets.length) f.push(['variantSetChildren', tokenVector(prim.variantSets.map((x) => x.name))]);
    if (prim.children.length) f.push(['primChildren', tokenVector(prim.children.map((c) => c.name))]);
    if (prim.props.length) f.push(['properties', tokenVector(prim.props.map((p) => p.name))]);
    if (prim.nameOrder) f.push(['primOrder', tokenVector(prim.nameOrder)]);
    if (prim.propOrder) f.push(['propertyOrder', tokenVector(prim.propOrder)]);
    return f;
  }
  function addPrim(prim, specPath, isVariant) {
    addPath(specPath);
    specs.push([specPath, isVariant ? SPEC.variant : SPEC.prim, primFields(prim, isVariant)]);
    for (const p of prim.props) {
      const pp = `${specPath}.${p.name}`;
      addPath(pp);
      const f = [];
      if (p.kind === 'relationship') {
        if (p.custom) f.push(['custom', rep(TYPE.bool, 1, { inlined: true })]);
        f.push(['variability', variability(p.variability || 'uniform')]);
        if (p.targets) f.push(['targetPaths', packField('inheritPaths', p.targets, specPath)]);
      } else {
        f.push(['custom', rep(TYPE.bool, p.custom ? 1 : 0, { inlined: true })]);
        f.push(['typeName', rep(TYPE.token, tok(p.typeName || 'float'), { inlined: true })]);
        f.push(['variability', variability(p.variability)]);
        if (p.value !== undefined) f.push(['default', packTyped(p.value, p.typeName || 'float')]);
        if (p.timeSamples) f.push(['timeSamples', timeSamples(p.timeSamples, p.typeName || 'float')]);
        if (p.connect) f.push(['connectionPaths', packField('inheritPaths', p.connect, specPath)]);
      }
      for (const [k, v] of p.meta) { if (v === undefined) continue; const name = FIELD_NAME[k] || k; f.push([name, packField(name, v, specPath)]); }
      specs.push([pp, p.kind === 'relationship' ? SPEC.relationship : SPEC.attribute, f]);
    }
    for (const c of prim.children) addPrim(c, specPath === '/' ? `/${c.name}` : specPath.endsWith('}') ? specPath + c.name : `${specPath}/${c.name}`, false);
    for (const vs of prim.variantSets) {
      const setPath = `${specPath}{${vs.name}=}`;
      addPath(setPath);
      specs.push([setPath, SPEC.variantSet, [['variantChildren', tokenVector(vs.variants.map((v) => v.name))]]]);
      for (const v of vs.variants) addPrim(v.prim, `${specPath}{${vs.name}=${v.name}}`, true);
    }
  }
  // pseudo-root
  {
    const f = [];
    for (const [k, v] of layer.meta) {
      if (v === undefined) continue;
      if (k === 'subLayers') {
        const items = (v || []).map((x) => (typeof x === 'string' ? { asset: x, offset: 0, scale: 1 } : x));
        out.align(8);
        const at = out.n;
        out.u64(items.length);
        for (const x of items) out.u32(str(x.asset));
        f.push(['subLayers', rep(TYPE.StringVector, at)]);
        out.align(8);
        const at2 = out.n;
        out.u64(items.length);
        for (const x of items) { out.f64(x.offset || 0); out.f64(x.scale === undefined ? 1 : x.scale); }
        f.push(['subLayerOffsets', rep(TYPE.LayerOffsetVector, at2)]);
        continue;
      }
      const name = FIELD_NAME[k] || k;
      f.push([name, packField(name, v, '/')]);
    }
    if (layer.root.children.length) f.push(['primChildren', tokenVector(layer.root.children.map((c) => c.name))]);
    if (layer.root.nameOrder) f.push(['primOrder', tokenVector(layer.root.nameOrder)]);
    specs.push(['/', SPEC.pseudoRoot, f]);
    for (const c of layer.root.children) addPrim(c, `/${c.name}`, false);
  }

  // path table in depth-first order; index = position
  const order = [];
  const visitPath = (p) => { order.push(p); for (const k of pathNodes.get(p).kids) visitPath(k); };
  visitPath('/');
  // An empty path (a reference with no prim path) gets table slot 0, outside the encoded tree, as USD writes it
  // (USD wants the largest encoded index to be the last slot).
  const usesEmpty = pathRefs.some(([, p]) => !p);
  const shift = usesEmpty ? 1 : 0;
  order.forEach((p, i) => pathIndex.set(p, i + shift));
  for (const [at, p] of pathRefs) new DataView(out.buf.buffer).setUint32(at, p ? pathIndex.get(p) : 0, true);
  const elemTok = order.map((p) => { const n = pathNodes.get(p); return n.parent === null ? 0 : n.prop ? -tok(n.elem) : tok(n.elem); });
  const jumps = order.map((p, i) => {
    const n = pathNodes.get(p);
    const hasChild = n.kids.length > 0;
    const sibs = n.parent === null ? [] : pathNodes.get(n.parent).kids;
    const k = sibs.indexOf(p);
    const hasSibling = k >= 0 && k < sibs.length - 1;
    if (hasChild && hasSibling) return order.indexOf(sibs[k + 1]) - i;
    if (hasChild) return -1;
    if (hasSibling) return 0;
    return -2;
  });

  // fields and field sets
  const fieldKey = new Map(), fieldToks = [], fieldReps = [];
  const fieldSets = [];
  const specRows = [];
  for (const [p, type, fields] of specs) {
    const start = fieldSets.length;
    for (const [name, r] of fields) {
      const key = `${name}|${r[0]}|${r[1]}`;
      let i = fieldKey.get(key);
      if (i === undefined) { i = fieldToks.length; fieldToks.push(tok(name)); fieldReps.push(r); fieldKey.set(key, i); }
      fieldSets.push(i);
    }
    fieldSets.push(-1);
    specRows.push([pathIndex.get(p), start, type]);
  }

  // ---------- sections ----------
  const sections = [];
  const section = (name, fn) => { out.align(8); const start = out.n; fn(); sections.push([name, start, out.n - start]); };
  const ints = (arr) => { const c = fastCompress(encodeInts(arr, false)); out.u64(c.length); out.bytes(c); };
  section('TOKENS', () => {
    const te = new TextEncoder();
    const parts = tokens.map((t) => te.encode(t));
    const raw = new Uint8Array(parts.reduce((a, b) => a + b.length + 1, 0));
    let k = 0;
    for (const b of parts) { raw.set(b, k); k += b.length + 1; }
    const c = fastCompress(raw);
    out.u64(tokens.length); out.u64(raw.length); out.u64(c.length); out.bytes(c);
  });
  section('STRINGS', () => { out.u64(strings.length); for (const s of strings) out.u32(s); });
  section('FIELDS', () => {
    out.u64(fieldToks.length);
    ints(fieldToks);
    const raw = new Uint8Array(fieldReps.length * 8);
    const rv = new DataView(raw.buffer);
    fieldReps.forEach((r, i) => { rv.setUint32(i * 8, r[0], true); rv.setUint32(i * 8 + 4, r[1], true); });
    const c = fastCompress(raw);
    out.u64(c.length); out.bytes(c);
  });
  section('FIELDSETS', () => { out.u64(fieldSets.length); ints(fieldSets); });
  section('PATHS', () => { out.u64(order.length + shift); out.u64(order.length); ints(order.map((_, i) => i + shift)); ints(elemTok); ints(jumps); });
  section('SPECS', () => { out.u64(specRows.length); ints(specRows.map((s) => s[0])); ints(specRows.map((s) => s[1])); ints(specRows.map((s) => s[2])); });
  out.align(8);
  const toc = out.n;
  out.u64(sections.length);
  for (const [name, start, size] of sections) { const nb = new Uint8Array(16); nb.set(new TextEncoder().encode(name)); out.bytes(nb); out.i64(start); out.i64(size); }
  const res = out.result();
  res.set(new TextEncoder().encode('PXR-USDC'), 0);
  res[8] = 0; res[9] = 8; res[10] = 0;
  new DataView(res.buffer).setBigUint64(16, BigInt(toc), true);
  return res;
}

function asListOp(v) {
  if (v instanceof ListOp) return v;
  if (v instanceof Ref) return new ListOp(true, { explicit: [v] });
  if (Array.isArray(v)) return new ListOp(true, { explicit: v });
  return new ListOp(true, { explicit: v === undefined || v === null ? [] : [v] });
}

/** Elements of a path: [{ name, prop, variant }]. */
function splitPath(p) {
  const out = [];
  let s = String(p);
  if (s === '/' || !s) return out;
  if (s[0] === '/') s = s.slice(1);
  let i = 0;
  let cur = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '/') { if (cur) out.push({ name: cur }); cur = ''; i++; continue; }
    if (c === '{') { if (cur) out.push({ name: cur }); cur = ''; const j = s.indexOf('}', i); out.push({ name: s.slice(i, j + 1), variant: true }); i = j + 1; continue; }
    if (c === '.') { if (cur) out.push({ name: cur }); out.push({ name: s.slice(i + 1), prop: true }); return out; }
    cur += c; i++;
  }
  if (cur) out.push({ name: cur });
  return out;
}

/** Makes a path absolute against the prim (or property owner) it was written in. */
function absolute(p, at) {
  p = String(p || '');
  if (!p || p.startsWith('/')) return p || '/';
  let base = String(at || '/').replace(/\.[^/]*$/, '');
  let rest = p;
  while (rest.startsWith('../')) { base = base.slice(0, base.lastIndexOf('/')) || '/'; rest = rest.slice(3); }
  if (rest.startsWith('./')) rest = rest.slice(2);
  if (rest.startsWith('.')) return base + rest;
  return base === '/' ? '/' + rest : base + '/' + rest;
}

module.exports = { writeUsdc, splitPath, absolute, toHalf };
