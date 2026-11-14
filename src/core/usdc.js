'use strict';
// USDC ("crate") binary layer reader, written from the file format: an 88-byte bootstrap ("PXR-USDC", version,
// table of contents offset), a table of sections (TOKENS, STRINGS, FIELDS, FIELDSETS, PATHS, SPECS) and value
// data addressed by 64-bit value reps (array, inlined and compressed flags, a type byte and a 48-bit payload).
// Versions 0.4.0 and newer compress the structural sections with LZ4 and USD integer coding. Older files (0.0.1 to
// 0.3.x) store them plainly; both are read. Everything ends up in the shared layer model (model.js).
const { fastDecompress, decodeInts, intsBound } = require('./compress');
const { Raw, Asset, SdfPath, BLOCK, Tuples, ListOp, Ref, Dict } = require('./types');
const { Prop, Prim, Layer } = require('./model');

const MAGIC = 'PXR-USDC';

// Crate value type numbers.
const TYPE_NAMES = [, 'bool', 'uchar', 'int', 'uint', 'int64', 'uint64', 'half', 'float', 'double', 'string', 'token', 'asset',
  'matrix2d', 'matrix3d', 'matrix4d', 'quatd', 'quatf', 'quath', 'double2', 'float2', 'half2', 'int2', 'double3', 'float3', 'half3', 'int3',
  'double4', 'float4', 'half4', 'int4', 'dictionary', 'TokenListOp', 'StringListOp', 'PathListOp', 'ReferenceListOp', 'IntListOp',
  'Int64ListOp', 'UIntListOp', 'UInt64ListOp', 'PathVector', 'TokenVector', 'Specifier', 'Permission', 'Variability',
  'VariantSelectionMap', 'TimeSamples', 'Payload', 'DoubleVector', 'LayerOffsetVector', 'StringVector', 'ValueBlock', 'Value',
  'UnregisteredValue', 'UnregisteredValueListOp', 'PayloadListOp', 'timecode', 'PathExpression', 'Relocates', 'Spline', 'AnimationBlock'];
const TYPE = Object.fromEntries(TYPE_NAMES.map((n, i) => [n, i]).filter(([n]) => n));

// [component kind, components] for the numeric types.
const NUMERIC = {
  bool: ['b', 1], uchar: ['u8', 1], int: ['i32', 1], uint: ['u32', 1], int64: ['i64', 1], uint64: ['u64', 1], half: ['f16', 1], float: ['f32', 1], double: ['f64', 1], timecode: ['f64', 1],
  matrix2d: ['f64', 4], matrix3d: ['f64', 9], matrix4d: ['f64', 16], quatd: ['f64', 4], quatf: ['f32', 4], quath: ['f16', 4],
  double2: ['f64', 2], float2: ['f32', 2], half2: ['f16', 2], int2: ['i32', 2], double3: ['f64', 3], float3: ['f32', 3], half3: ['f16', 3], int3: ['i32', 3],
  double4: ['f64', 4], float4: ['f32', 4], half4: ['f16', 4], int4: ['i32', 4],
};
const KSIZE = { b: 1, u8: 1, i32: 4, u32: 4, i64: 8, u64: 8, f16: 2, f32: 4, f64: 8 };
const SPECIFIERS = ['def', 'over', 'class'];
const VARIABILITY = ['', 'uniform', 'config'];
const SPEC = { attribute: 1, connection: 2, prim: 6, pseudoRoot: 7, relationship: 8, target: 9, variant: 10, variantSet: 11 };

function half(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

function isUsdc(buf) { return buf && buf.length >= 88 && String.fromCharCode(...buf.subarray(0, 8)) === MAGIC; }

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = 0;
  }
  need(n) { if (this.pos < 0 || this.pos + n > this.buf.length) throw new Error(`The USDC file ends early (read of ${n} bytes at ${this.pos}).`); }
  u8() { this.need(1); return this.buf[this.pos++]; }
  i8() { this.need(1); return this.dv.getInt8(this.pos++); }
  u32() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  u64() { this.need(8); const lo = this.dv.getUint32(this.pos, true), hi = this.dv.getUint32(this.pos + 4, true); this.pos += 8; return hi * 4294967296 + lo; }
  i64() { this.need(8); const v = Number(this.dv.getBigInt64(this.pos, true)); this.pos += 8; return v; }
  f64() { this.need(8); const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
  bytes(n) { this.need(n); const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  rep() { this.need(8); const lo = this.dv.getUint32(this.pos, true), hi = this.dv.getUint32(this.pos + 4, true); this.pos += 8; return mkRep(lo, hi); }
}
function mkRep(lo, hi) {
  return { array: !!(hi & 0x80000000), inlined: !!(hi & 0x40000000), compressed: !!(hi & 0x20000000), type: (hi >>> 16) & 0xff, payload: (hi & 0xffff) * 4294967296 + lo, lo };
}

const MAX_COUNT = 1 << 28;
function checkCount(n, what) { if (!(n >= 0 && n < MAX_COUNT)) throw new Error(`The USDC file has a damaged ${what} count (${n}).`); return n; }

/** Reads a USDC layer from a Buffer or Uint8Array. Throws an Error with a plain message for files it cannot read. */
function readUsdc(input, opts = {}) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isUsdc(buf)) throw new Error('This is not a USDC file (no PXR-USDC header).');
  const r = new Reader(buf);
  const ver = [buf[8], buf[9], buf[10]];
  const vnum = ver[0] * 10000 + ver[1] * 100 + ver[2];
  const atLeast = (a, b, c = 0) => vnum >= a * 10000 + b * 100 + c;
  if (ver[0] !== 0) throw new Error(`USDC version ${ver.join('.')} is newer than this viewer knows (0.x).`);
  r.pos = 16;
  const tocOffset = r.u64();
  r.pos = tocOffset;
  const nSections = checkCount(r.u64(), 'section');
  const sections = {};
  for (let i = 0; i < nSections; i++) {
    const nameBytes = r.bytes(16);
    const name = String.fromCharCode(...nameBytes.subarray(0, nameBytes.indexOf(0) < 0 ? 16 : nameBytes.indexOf(0)));
    sections[name] = { start: r.i64(), size: r.i64() };
  }
  for (const s of ['TOKENS', 'STRINGS', 'FIELDS', 'FIELDSETS', 'PATHS', 'SPECS']) if (!sections[s]) throw new Error(`The USDC file has no ${s} section.`);

  const compressedInts = (count, wide) => {
    const size = r.u64();
    const data = r.bytes(size);
    return decodeInts(fastDecompress(data, intsBound(count, wide)), count, wide);
  };

  // TOKENS
  r.pos = sections.TOKENS.start;
  const nTokens = checkCount(r.u64(), 'token');
  let tokenBytes;
  if (atLeast(0, 4)) {
    const raw = r.u64();
    const comp = r.u64();
    tokenBytes = fastDecompress(r.bytes(comp), raw);
  } else {
    tokenBytes = r.bytes(r.u64());
  }
  const tokens = new Array(nTokens);
  {
    const td = new TextDecoder('utf-8');
    let start = 0, k = 0;
    for (let i = 0; i < tokenBytes.length && k < nTokens; i++) if (tokenBytes[i] === 0) { tokens[k++] = td.decode(tokenBytes.subarray(start, i)); start = i + 1; }
    while (k < nTokens) tokens[k++] = '';
  }
  const tok = (i) => { if (i < 0 || i >= tokens.length) throw new Error(`The USDC file names token ${i} of ${tokens.length}.`); return tokens[i]; };

  // STRINGS
  r.pos = sections.STRINGS.start;
  const nStrings = checkCount(r.u64(), 'string');
  const strings = new Array(nStrings);
  for (let i = 0; i < nStrings; i++) strings[i] = r.u32();
  const str = (i) => { if (i < 0 || i >= strings.length) throw new Error(`The USDC file names string ${i} of ${strings.length}.`); return tok(strings[i]); };

  // FIELDS
  r.pos = sections.FIELDS.start;
  let fieldTokens, fieldReps;
  if (atLeast(0, 4)) {
    const n = checkCount(r.u64(), 'field');
    fieldTokens = compressedInts(n, false);
    const repSize = r.u64();
    const repBytes = fastDecompress(r.bytes(repSize), n * 8);
    const dv = new DataView(repBytes.buffer, repBytes.byteOffset, repBytes.byteLength);
    fieldReps = new Array(n);
    for (let i = 0; i < n; i++) fieldReps[i] = mkRep(dv.getUint32(i * 8, true), dv.getUint32(i * 8 + 4, true));
  } else {
    const n = checkCount(r.u64(), 'field');
    fieldTokens = new Int32Array(n); fieldReps = new Array(n);
    for (let i = 0; i < n; i++) { fieldTokens[i] = r.u32(); r.pos += 4; fieldReps[i] = r.rep(); }
  }

  // FIELDSETS
  r.pos = sections.FIELDSETS.start;
  let fieldSets;
  if (atLeast(0, 4)) { const n = checkCount(r.u64(), 'field set'); fieldSets = compressedInts(n, false); } else { const n = checkCount(r.u64(), 'field set'); fieldSets = new Int32Array(n); for (let i = 0; i < n; i++) fieldSets[i] = r.u32() | 0; }

  // PATHS
  r.pos = sections.PATHS.start;
  const nPaths = checkCount(r.u64(), 'path');
  const paths = new Array(nPaths).fill('');
  const appendElem = (parent, t) => (t[0] === '{' || t[0] === '[' || parent.endsWith('}') && parent !== '/' ? parent + t : parent === '/' ? '/' + t : parent + '/' + t);
  if (atLeast(0, 4)) {
    const n = checkCount(r.u64(), 'encoded path');
    const pathIdx = compressedInts(n, false), elemIdx = compressedInts(n, false), jumps = compressedInts(n, false);
    // Iterative form of the depth-first decode: a stack of [index, parent path] for pending siblings.
    const stack = [[0, '']];
    let guard = 0;
    while (stack.length) {
      let [cur, parent] = stack.pop();
      let more = true;
      while (more) {
        if (cur < 0 || cur >= n || ++guard > n * 2 + 10) throw new Error('The USDC path table is damaged.');
        const i = cur++;
        let p;
        if (!parent) p = '/';
        else { const e = elemIdx[i]; const t = tok(Math.abs(e)); p = e < 0 ? parent + '.' + t : appendElem(parent, t); }
        if (pathIdx[i] < 0 || pathIdx[i] >= nPaths) throw new Error('The USDC path table is damaged.');
        paths[pathIdx[i]] = p;
        if (!parent) parent = '/';
        const j = jumps[i];
        const hasChild = j > 0 || j === -1, hasSibling = j >= 0;
        if (hasChild) { if (hasSibling) stack.push([i + j, parent]); parent = p; }
        more = hasChild || hasSibling;
      }
    }
  } else {
    // 0.0.1 to 0.3.x: path item headers { index u32, element token u32, bits u8 } padded to 12 bytes; a sibling
    // offset (int64) follows a header that has both a child and a sibling.
    const stack = [[r.pos, '']];
    let guard = 0;
    while (stack.length) {
      let [at, parent] = stack.pop();
      r.pos = at;
      let more = true;
      while (more) {
        if (++guard > nPaths * 2 + 10) throw new Error('The USDC path table is damaged.');
        const index = r.u32(), elem = r.u32(), bits = r.u8(); r.pos += 3;
        let p;
        if (!parent) p = '/';
        else { const t = tok(elem); p = bits & 4 ? parent + '.' + t : appendElem(parent, t); }
        if (index >= nPaths) throw new Error('The USDC path table is damaged.');
        paths[index] = p;
        if (!parent) parent = '/';
        const hasChild = !!(bits & 1), hasSibling = !!(bits & 2);
        if (hasChild) { if (hasSibling) { const off = r.i64(); stack.push([off, parent]); } parent = p; }
        more = hasChild || hasSibling;
      }
    }
  }

  // SPECS
  r.pos = sections.SPECS.start;
  const specs = new Map();
  {
    let pIdx, fsIdx, types;
    if (atLeast(0, 4)) {
      const n = checkCount(r.u64(), 'spec');
      pIdx = compressedInts(n, false); fsIdx = compressedInts(n, false); types = compressedInts(n, false);
    } else {
      const n = checkCount(r.u64(), 'spec');
      pIdx = new Int32Array(n); fsIdx = new Int32Array(n); types = new Int32Array(n);
      const pad = vnum < 1 ? 4 : 0; // 0.0.1 wrote the spec type as a padded 8-byte field
      for (let i = 0; i < n; i++) { pIdx[i] = r.u32(); fsIdx[i] = r.u32(); types[i] = r.u32(); r.pos += pad; }
    }
    for (let i = 0; i < pIdx.length; i++) {
      const fields = new Map();
      for (let k = fsIdx[i]; k < fieldSets.length && fieldSets[k] !== -1; k++) {
        const f = fieldSets[k];
        if (f < 0 || f >= fieldReps.length) throw new Error('The USDC field set table is damaged.');
        fields.set(tok(fieldTokens[f]), fieldReps[f]);
      }
      specs.set(paths[pIdx[i]], { type: types[i], fields });
    }
  }

  // ---------- values ----------
  const readNum = (kind) => {
    switch (kind) {
      case 'b': return r.u8() !== 0;
      case 'u8': return r.u8();
      case 'i32': return r.i32();
      case 'u32': return r.u32();
      case 'i64': return r.i64();
      case 'u64': return r.u64();
      case 'f16': { r.need(2); const v = half(r.dv.getUint16(r.pos, true)); r.pos += 2; return v; }
      case 'f32': { r.need(4); const v = r.dv.getFloat32(r.pos, true); r.pos += 4; return v; }
      default: return r.f64();
    }
  };
  const shapeScalar = (name, comps) => {
    if (name.startsWith('quat')) return [comps[3], comps[0], comps[1], comps[2]]; // stored i, j, k, real
    if (name.startsWith('matrix')) { const n = Math.round(Math.sqrt(comps.length)); const rows = []; for (let i = 0; i < n; i++) rows.push(comps.slice(i * n, i * n + n)); return rows; }
    return comps.length === 1 ? comps[0] : comps;
  };
  const vec = (n, fn) => { const out = new Array(n); for (let i = 0; i < n; i++) out[i] = fn(); return out; };
  const readListOp = (itemFn) => {
    const h = r.u8();
    const items = {};
    const list = () => { const n = checkCount(r.u64(), 'list op item'); return vec(n, itemFn); };
    if (h & 2) items.explicit = list();
    if (h & 4) items.add = list();
    if (h & 32) items.prepend = list();
    if (h & 64) items.append = list();
    if (h & 8) items.delete = list();
    if (h & 16) items.order = list();
    return new ListOp(!!(h & 1), items);
  };
  const readLayerOffset = () => ({ offset: r.f64(), scale: r.f64() });
  const readDict = () => {
    const n = checkCount(r.u64(), 'dictionary entry');
    const entries = [];
    for (let i = 0; i < n; i++) {
      const key = str(r.u32());
      const at = r.pos;
      const off = r.i64();
      r.pos = at + off;
      const rep = r.rep();
      const back = at + off + 8; // the value rep sits after its out-of-line data; the next entry follows it
      const v = unpack(rep);
      r.pos = back;
      entries.push([key, dictType(rep), v]);
    }
    return new Dict(entries);
  };
  const readReference = () => {
    const asset = str(r.u32());
    const path = paths[r.u32()] || '';
    const lo = readLayerOffset();
    const customData = readDict();
    return new Ref({ asset, path, offset: lo.offset, scale: lo.scale, customData: customData.entries.length ? customData : null });
  };
  const readPayload = () => {
    const asset = str(r.u32());
    const path = paths[r.u32()] || '';
    const lo = atLeast(0, 8) ? readLayerOffset() : { offset: 0, scale: 1 };
    return new Ref({ asset, path, offset: lo.offset, scale: lo.scale });
  };
  const readTimeSamples = () => {
    const at = r.pos;
    const off = r.i64();
    r.pos = at + off;
    const timesRep = r.rep();
    const afterTimes = r.pos;
    const times = unpack(timesRep);
    r.pos = afterTimes;
    const at2 = r.pos;
    const off2 = r.i64();
    r.pos = at2 + off2;
    const n = checkCount(r.u64(), 'time sample');
    const reps = vec(n, () => r.rep());
    const ts = Array.from(times || []);
    const out = [];
    for (let i = 0; i < n; i++) out.push([ts[i], unpack(reps[i])]);
    return out;
  };

  function inlined(rep) {
    const name = TYPE_NAMES[rep.type];
    const lo = rep.lo;
    switch (name) {
      case 'bool': return lo !== 0;
      case 'uchar': return lo & 0xff;
      case 'int': case 'int64': return lo | 0;
      case 'uint': case 'uint64': return lo >>> 0;
      case 'half': return half(lo & 0xffff);
      case 'float': case 'double': case 'timecode': { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, lo, true); return b.getFloat32(0, true); }
      case 'string': return str(lo);
      case 'token': return tok(lo);
      case 'asset': return new Asset(tok(lo));
      case 'Specifier': return SPECIFIERS[lo] || 'def';
      case 'Variability': return VARIABILITY[lo] || '';
      case 'Permission': return lo ? 'private' : 'public';
      case 'ValueBlock': case 'AnimationBlock': return BLOCK;
      case 'dictionary': return new Dict([]);
      case 'TokenVector': case 'PathVector': case 'StringVector': case 'DoubleVector': case 'LayerOffsetVector': return [];
      default: {
        const num = NUMERIC[name];
        if (num) {
          // Vectors: one int8 per component. Matrices: the diagonal, one int8 per row.
          const bytes = [0, 1, 2, 3].map((k) => { const b = (rep.payload / 2 ** (8 * k)) & 0xff; return b > 127 ? b - 256 : b; });
          if (name.startsWith('matrix')) { const n = Math.round(Math.sqrt(num[1])); const rows = []; for (let i = 0; i < n; i++) { const row = new Array(n).fill(0); row[i] = bytes[i]; rows.push(row); } return rows; }
          const comps = bytes.slice(0, num[1]);
          return shapeScalar(name, comps);
        }
        return null;
      }
    }
  }

  function readArray(rep, name) {
    if (!rep.payload) return emptyArray(name);
    r.pos = rep.payload;
    if (!atLeast(0, 5)) r.u32(); // shape rank, no longer written from 0.5.0
    const n = checkCount(atLeast(0, 7) ? r.u64() : r.u32(), 'array element');
    const num = NUMERIC[name];
    if (num) {
      const [kind, comps] = num;
      const total = n * comps;
      if (rep.compressed && (kind === 'i32' || kind === 'u32' || kind === 'i64' || kind === 'u64')) {
        const ints = compressedInts(n, kind === 'i64' || kind === 'u64');
        return kind === 'i32' ? ints : kind === 'u32' ? Uint32Array.from(ints, (x) => x >>> 0) : Float64Array.from(ints);
      }
      if (rep.compressed && (kind === 'f16' || kind === 'f32' || kind === 'f64') && comps === 1) {
        const code = String.fromCharCode(r.u8());
        const out = kind === 'f64' ? new Float64Array(n) : new Float32Array(n);
        if (code === 'i') { const ints = compressedInts(n, false); for (let i = 0; i < n; i++) out[i] = ints[i]; return out; }
        if (code === 't') {
          const lutSize = r.u32();
          const lut = vec(lutSize, () => readNum(kind));
          const idx = compressedInts(n, false);
          for (let i = 0; i < n; i++) out[i] = lut[idx[i]];
          return out;
        }
        throw new Error(`The USDC file has an unknown float array code "${code}".`);
      }
      r.need(total * KSIZE[kind]);
      let flat;
      const start = r.buf.byteOffset + r.pos;
      if (kind === 'f32') flat = start % 4 === 0 ? new Float32Array(r.buf.buffer.slice(start, start + total * 4)) : Float32Array.from(vec(total, () => readNum('f32')));
      else if (kind === 'f64') flat = Float64Array.from(vec(total, () => readNum('f64')));
      else if (kind === 'i32') flat = Int32Array.from(vec(total, () => readNum('i32')));
      else if (kind === 'u32') flat = Uint32Array.from(vec(total, () => readNum('u32')));
      else if (kind === 'f16') flat = Float32Array.from(vec(total, () => readNum('f16')));
      else if (kind === 'b') return vec(total, () => readNum('b'));
      else if (kind === 'u8') flat = Uint8Array.from(vec(total, () => readNum('u8')));
      else flat = Float64Array.from(vec(total, () => readNum(kind)));
      if (kind === 'f32') r.pos += total * 4;
      if (comps === 1) return flat;
      if (name.startsWith('quat')) { const q = new (flat.constructor)(flat.length); for (let i = 0; i < n; i++) { q[i * 4] = flat[i * 4 + 3]; q[i * 4 + 1] = flat[i * 4]; q[i * 4 + 2] = flat[i * 4 + 1]; q[i * 4 + 3] = flat[i * 4 + 2]; } return new Tuples(q, 4); }
      if (name.startsWith('matrix')) { const out = []; for (let i = 0; i < n; i++) out.push(shapeScalar(name, Array.from(flat.subarray(i * comps, i * comps + comps)))); return out; }
      return new Tuples(flat, comps);
    }
    if (name === 'string') return vec(n, () => str(r.u32()));
    if (name === 'token') return vec(n, () => tok(r.u32()));
    if (name === 'asset') return vec(n, () => new Asset(tok(r.u32())));
    if (name === 'PathExpression') return vec(n, () => str(r.u32()));
    throw new Error(`Arrays of ${name || 'type ' + rep.type} are not supported.`);
  }

  function unpack(rep) {
    const name = TYPE_NAMES[rep.type];
    if (!name) return null;
    if (rep.inlined) return rep.array ? emptyArray(name) : inlined(rep);
    if (rep.array) return readArray(rep, name);
    r.pos = rep.payload;
    const num = NUMERIC[name];
    if (num) return shapeScalar(name, vec(num[1], () => readNum(num[0])));
    switch (name) {
      case 'string': return str(r.u32());
      case 'token': return tok(r.u32());
      case 'asset': return new Asset(tok(r.u32()));
      case 'dictionary': return readDict();
      case 'TokenListOp': return readListOp(() => tok(r.u32()));
      case 'StringListOp': return readListOp(() => str(r.u32()));
      case 'PathListOp': return readListOp(() => new SdfPath(paths[r.u32()] || ''));
      case 'ReferenceListOp': return readListOp(readReference);
      case 'PayloadListOp': return readListOp(readPayload);
      case 'IntListOp': return readListOp(() => r.i32());
      case 'UIntListOp': return readListOp(() => r.u32());
      case 'Int64ListOp': return readListOp(() => r.i64());
      case 'UInt64ListOp': return readListOp(() => r.u64());
      case 'PathVector': { const n = checkCount(r.u64(), 'path'); return vec(n, () => new SdfPath(paths[r.u32()] || '')); }
      case 'TokenVector': { const n = checkCount(r.u64(), 'token'); return vec(n, () => tok(r.u32())); }
      case 'StringVector': { const n = checkCount(r.u64(), 'string'); return vec(n, () => str(r.u32())); }
      case 'DoubleVector': { const n = checkCount(r.u64(), 'double'); return Float64Array.from(vec(n, () => r.f64())); }
      case 'LayerOffsetVector': { const n = checkCount(r.u64(), 'layer offset'); return vec(n, readLayerOffset); }
      case 'VariantSelectionMap': { const n = checkCount(r.u64(), 'variant selection'); const e = []; for (let i = 0; i < n; i++) { const k = str(r.u32()); e.push([k, 'string', str(r.u32())]); } return new Dict(e); }
      case 'TimeSamples': return readTimeSamples();
      case 'Payload': return readPayload();
      case 'Specifier': return SPECIFIERS[r.u32()] || 'def';
      case 'Variability': return VARIABILITY[r.u32()] || '';
      case 'Permission': return r.u32() ? 'private' : 'public';
      case 'ValueBlock': case 'AnimationBlock': return BLOCK;
      case 'PathExpression': return str(r.u32());
      case 'Value': { const at = r.pos; const off = r.i64(); r.pos = at + off; return unpack(r.rep()); }
      case 'UnregisteredValue': { const at = r.pos; const off = r.i64(); r.pos = at + off; const v = unpack(r.rep()); return typeof v === 'string' ? new Raw(v) : v; }
      default: return null;
    }
  }

  const warnings = [];
  const value = (rep, where) => {
    try { return unpack(rep); } catch (e) { warnings.push(`${where}: ${e.message}`); return null; }
  };

  // ---------- model ----------
  const layer = new Layer('usdc', ver.join('.'));
  layer.warnings = warnings;
  const rootSpec = specs.get('/');
  const fieldVal = (spec, name, where) => (spec && spec.fields.has(name) ? value(spec.fields.get(name), where) : undefined);
  if (rootSpec) {
    for (const [k, rep] of rootSpec.fields) {
      if (k === 'primChildren' || k === 'subLayerOffsets') continue;
      const v = value(rep, `layer ${k}`);
      if (k === 'subLayers') {
        const offs = fieldVal(rootSpec, 'subLayerOffsets', 'layer subLayerOffsets') || [];
        layer.meta.set('subLayers', (v || []).map((a, i) => ({ asset: a, offset: offs[i] ? offs[i].offset : 0, scale: offs[i] ? offs[i].scale : 1 })));
      } else layer.meta.set(k === 'documentation' ? 'doc' : k, v);
    }
  }
  const PRIM_SKIP = new Set(['specifier', 'typeName', 'primChildren', 'properties', 'variantSetChildren', 'variantChildren', 'primOrder', 'propertyOrder']);
  const PROP_SKIP = new Set(['typeName', 'default', 'timeSamples', 'variability', 'custom', 'connectionPaths', 'targetPaths', 'connectionChildren', 'targetChildren']);
  const metaName = (k) => ({ documentation: 'doc', variantSelection: 'variants', variantSetNames: 'variantSets', inheritPaths: 'inherits' })[k] || k;
  let built = 0;
  function fill(prim, specPath, depth) {
    if (depth > 200) throw new Error('The USDC prim tree is nested too deeply.');
    const spec = specs.get(specPath);
    if (!spec) return;
    built++;
    const sp = fieldVal(spec, 'specifier', specPath);
    if (sp) prim.specifier = sp;
    const tn = fieldVal(spec, 'typeName', specPath);
    if (tn) prim.typeName = tn;
    for (const [k, rep] of spec.fields) {
      if (PRIM_SKIP.has(k)) continue;
      let v = value(rep, `${specPath} ${k}`);
      if (v instanceof Ref) v = new ListOp(true, { explicit: [v] }); // a single payload (older files) as a list op
      prim.meta.set(metaName(k), v);
    }
    const po = fieldVal(spec, 'primOrder', specPath); if (po) prim.nameOrder = po;
    const pro = fieldVal(spec, 'propertyOrder', specPath); if (pro) prim.propOrder = pro;
    for (const name of fieldVal(spec, 'properties', specPath) || []) {
      const pp = specPath + '.' + name;
      const ps = specs.get(pp);
      const prop = new Prop(name, ps && ps.type === SPEC.relationship ? 'relationship' : 'attribute');
      if (ps) {
        prop.typeName = fieldVal(ps, 'typeName', pp) || '';
        const d = fieldVal(ps, 'default', pp); if (d !== undefined) prop.value = d;
        const ts = fieldVal(ps, 'timeSamples', pp); if (ts !== undefined) prop.timeSamples = ts;
        prop.variability = fieldVal(ps, 'variability', pp) || '';
        prop.custom = !!fieldVal(ps, 'custom', pp);
        const c = fieldVal(ps, 'connectionPaths', pp); if (c !== undefined) prop.connect = c;
        const t = fieldVal(ps, 'targetPaths', pp); if (t !== undefined) prop.targets = t;
        for (const [k, rep] of ps.fields) if (!PROP_SKIP.has(k)) prop.meta.set(metaName(k), value(rep, `${pp} ${k}`));
      }
      prim.props.push(prop);
    }
    for (const name of fieldVal(spec, 'primChildren', specPath) || []) {
      const cp = specPath === '/' ? '/' + name : specPath.endsWith('}') ? specPath + name : specPath + '/' + name;
      const c = new Prim(name, cp);
      fill(c, cp, depth + 1);
      prim.children.push(c);
    }
    for (const setName of fieldVal(spec, 'variantSetChildren', specPath) || []) {
      const setPath = `${specPath}{${setName}=}`;
      const vs = { name: setName, variants: [] };
      for (const vName of fieldVal(specs.get(setPath), 'variantChildren', setPath) || []) {
        const vp = `${specPath}{${setName}=${vName}}`;
        const vprim = new Prim(vName, vp);
        vprim.specifier = '';
        fill(vprim, vp, depth + 1);
        vs.variants.push({ name: vName, prim: vprim });
      }
      prim.variantSets.push(vs);
    }
  }
  fill(layer.root, '/', 0);
  layer.root.specifier = '';
  if (opts.raw) layer.rawSpecs = [...specs].map(([p, sp]) => [p, sp.type, [...sp.fields].map(([k, rep]) => `${k}:${TYPE_NAMES[rep.type] || rep.type}${rep.array ? '[]' : ''}${rep.inlined ? '(i)' : ''}${rep.compressed ? '(z)' : ''}`)]);
  layer.counts = { tokens: nTokens, strings: nStrings, fields: fieldReps.length, paths: nPaths, specs: specs.size, specsBuilt: built };
  return layer;
}

function emptyArray(name) {
  const num = NUMERIC[name];
  if (!num) return [];
  const [kind, comps] = num;
  if (comps > 1 && !name.startsWith('matrix')) return new Tuples(kind === 'f64' ? new Float64Array(0) : kind === 'i32' ? new Int32Array(0) : new Float32Array(0), comps);
  if (name.startsWith('matrix') || kind === 'b') return [];
  return kind === 'f64' ? new Float64Array(0) : kind === 'i32' ? new Int32Array(0) : kind === 'u32' ? new Uint32Array(0) : new Float32Array(0);
}

/** The USDA value type name of a crate value rep (for dictionary entries). */
function dictType(rep) {
  const n = TYPE_NAMES[rep.type] || '';
  if (n === 'TokenVector') return 'token[]';
  if (n === 'StringVector') return 'string[]';
  if (n === 'DoubleVector') return 'double[]';
  if (n === 'dictionary') return 'dictionary';
  if (n === 'ValueBlock') return 'None';
  return n + (rep.array ? '[]' : '');
}

module.exports = { readUsdc, isUsdc, TYPE, TYPE_NAMES, NUMERIC, half };
