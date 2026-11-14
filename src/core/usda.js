'use strict';
// USDA text layer parser. A pull lexer (no token array, so multi-megabyte files with long number lists stay fast)
// and a recursive descent parser for the layer header, metadata, prims, attributes (default values, time samples,
// connections), relationships and variant sets. Output: the shared layer model (model.js) with the same value
// classes the USDC reader produces. Errors name the line and column.
const { Asset, SdfPath, BLOCK, Tuples, ListOp, Ref, Dict, typeInfo } = require('./types');
const { Prop, Prim, Layer } = require('./model');

const LISTOP_KEYS = new Set(['references', 'payload', 'inherits', 'specializes', 'apiSchemas', 'variantSets']);
const OP_WORDS = { add: 'add', prepend: 'prepend', append: 'append', delete: 'delete', reorder: 'order' };
const SPECIFIERS = new Set(['def', 'over', 'class']);
const VARIABILITY = new Set(['varying', 'uniform', 'config']);

class Lexer {
  constructor(text) { this.s = text; this.i = 0; this.peeked = null; }
  error(msg, at) {
    const pos = at === undefined ? this.i : at;
    const before = this.s.slice(0, pos);
    const line = (before.match(/\n/g) || []).length + 1;
    const col = pos - before.lastIndexOf('\n');
    const e = new Error(`USDA line ${line}, column ${col}: ${msg}`);
    e.line = line; e.column = col;
    return e;
  }
  skip() {
    const s = this.s;
    for (;;) {
      const c = s.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13) { this.i++; continue; }
      if (c === 35) { const j = s.indexOf('\n', this.i); this.i = j < 0 ? s.length : j + 1; continue; } // #
      if (c === 47 && s.charCodeAt(this.i + 1) === 47) { const j = s.indexOf('\n', this.i); this.i = j < 0 ? s.length : j + 1; continue; } // //
      if (c === 47 && s.charCodeAt(this.i + 1) === 42) { const j = s.indexOf('*/', this.i + 2); this.i = j < 0 ? s.length : j + 2; continue; } // /* */
      return;
    }
  }
  peek() { if (!this.peeked) this.peeked = this.read(); return this.peeked; }
  next() { const t = this.peek(); this.peeked = null; return t; }
  read() {
    this.skip();
    const s = this.s;
    const start = this.i;
    if (start >= s.length) return { t: 'eof', at: start };
    const c = s[start];
    if (c === '"' || c === "'") {
      const triple = s.startsWith(c.repeat(3), start);
      const q = triple ? c.repeat(3) : c;
      let j = start + q.length;
      let out = '';
      for (;;) {
        if (j >= s.length) throw this.error('a string has no closing quote', start);
        if (s.startsWith(q, j)) break;
        const ch = s[j];
        if (ch === '\\') {
          const n = s[j + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };
          if (n === 'x') { out += String.fromCharCode(parseInt(s.substr(j + 2, 2), 16)); j += 4; continue; }
          out += n in map ? map[n] : n;
          j += 2;
          continue;
        }
        if (!triple && ch === '\n') throw this.error('a string runs past the end of its line', start);
        out += ch;
        j++;
      }
      this.i = j + q.length;
      return { t: 'str', v: out, at: start };
    }
    if (c === '@') {
      if (s.startsWith('@@@', start)) {
        const j = s.indexOf('@@@', start + 3);
        if (j < 0) throw this.error('an asset path has no closing @@@', start);
        this.i = j + 3;
        return { t: 'asset', v: s.slice(start + 3, j), at: start };
      }
      const j = s.indexOf('@', start + 1);
      if (j < 0) throw this.error('an asset path has no closing @', start);
      this.i = j + 1;
      return { t: 'asset', v: s.slice(start + 1, j), at: start };
    }
    if (c === '<') {
      const j = s.indexOf('>', start + 1);
      if (j < 0) throw this.error('a path has no closing >', start);
      this.i = j + 1;
      return { t: 'path', v: s.slice(start + 1, j), at: start };
    }
    const code = s.charCodeAt(start);
    if ((code >= 48 && code <= 57) || ((c === '-' || c === '+' || c === '.') && /[\d.]/.test(s[start + 1] || ''))) {
      let j = start + 1;
      while (j < s.length && /[\d.eE+\-]/.test(s[j])) { if ((s[j] === '+' || s[j] === '-') && !/[eE]/.test(s[j - 1])) break; j++; }
      this.i = j;
      const raw = s.slice(start, j);
      const v = Number(raw);
      if (Number.isNaN(v)) throw this.error(`"${raw}" is not a number`, start);
      return { t: 'num', v, raw, at: start };
    }
    if (c === '-' && /^-inf\b/.test(s.slice(start, start + 5))) { this.i = start + 4; return { t: 'num', v: -Infinity, raw: '-inf', at: start }; }
    if (/[A-Za-z_]/.test(c)) {
      let j = start + 1;
      while (j < s.length && /[\w:.]/.test(s[j])) j++;
      // a trailing ':' or '.' belongs to the next token (dictionary "key:" never happens in USDA, but be safe)
      while (j > start + 1 && /[:.]/.test(s[j - 1])) j--;
      this.i = j;
      return { t: 'id', v: s.slice(start, j), at: start };
    }
    if ('()[]{}=,;:&'.includes(c)) { this.i = start + 1; return { t: 'p', v: c, at: start }; }
    throw this.error(`unexpected character "${c}"`, start);
  }
  is(v) { const t = this.peek(); return t.t === 'p' && t.v === v; }
  isId(v) { const t = this.peek(); return t.t === 'id' && (v === undefined || t.v === v); }
  expect(v) { const t = this.next(); if (t.t !== 'p' || t.v !== v) throw this.error(`expected "${v}" but found ${describe(t)}`, t.at); return t; }
  accept(v) { if (this.is(v)) { this.next(); return true; } return false; }
}
function describe(t) { return t.t === 'eof' ? 'the end of the file' : t.t === 'str' ? `the string "${t.v.slice(0, 30)}"` : `"${t.raw || t.v}"`; }

// ---------- values ----------
function parseNumber(lx) {
  const t = lx.next();
  if (t.t === 'num') return t.v;
  if (t.t === 'id') {
    if (t.v === 'inf') return Infinity;
    if (t.v === 'nan') return NaN;
    if (t.v === 'true') return 1;
    if (t.v === 'false') return 0;
  }
  throw lx.error(`expected a number but found ${describe(t)}`, t.at);
}
function parseBool(lx) {
  const t = lx.next();
  if (t.t === 'num') return t.v !== 0;
  if (t.t === 'id' && (t.v === 'true' || t.v === 'false')) return t.v === 'true';
  throw lx.error(`expected true, false, 1 or 0 but found ${describe(t)}`, t.at);
}
function parseTuple(lx, n, out, off) {
  lx.expect('(');
  for (let k = 0; k < n; k++) { if (k) lx.expect(','); out[off + k] = parseNumber(lx); }
  lx.accept(',');
  lx.expect(')');
}
function parseMatrix(lx, rows) {
  lx.expect('(');
  const out = [];
  for (let r = 0; r < rows; r++) { if (r) lx.expect(','); const row = new Array(rows); parseTuple(lx, rows, row, 0); out.push(row); }
  lx.accept(',');
  lx.expect(')');
  return out;
}
function arrayCtor(base) { return base === 'd' ? Float64Array : base === 'f' || base === 'h' ? Float32Array : base === 'i' ? Int32Array : base === 'ui' ? Uint32Array : base === 'uc' ? Uint8Array : Float64Array; }

/** One value of a declared type. */
function parseTyped(lx, typeName) {
  if (lx.isId('None')) { lx.next(); return BLOCK; }
  const ti = typeInfo(typeName);
  if (ti.array) {
    lx.expect('[');
    const items = [];
    if (ti.base === 'm') { while (!lx.is(']')) { items.push(parseMatrix(lx, ti.rows)); if (!lx.accept(',')) break; } lx.expect(']'); return items; }
    if (ti.n > 1 || ti.base === 'q') {
      const flat = [];
      let k = 0;
      while (!lx.is(']')) { parseTuple(lx, ti.n, flat, k); k += ti.n; if (!lx.accept(',')) break; }
      lx.expect(']');
      return new Tuples(arrayCtor(ti.base === 'q' ? ti.elem : ti.base).from(flat), ti.n);
    }
    while (!lx.is(']')) { items.push(scalarOf(lx, ti)); if (!lx.accept(',')) break; }
    lx.expect(']');
    if (['d', 'f', 'h', 'i', 'ui', 'uc'].includes(ti.base)) return arrayCtor(ti.base).from(items);
    return items;
  }
  return scalarOf(lx, ti);
}
function scalarOf(lx, ti) {
  switch (ti.base) {
    case 'b': return parseBool(lx);
    case 's': case 't': { const t = lx.next(); if (t.t !== 'str') throw lx.error(`expected a quoted ${ti.name} but found ${describe(t)}`, t.at); return t.v; }
    case 'a': { const t = lx.next(); if (t.t !== 'asset') throw lx.error(`expected an @asset path@ but found ${describe(t)}`, t.at); return new Asset(t.v); }
    case 'm': return parseMatrix(lx, ti.rows);
    case 'unknown': case 'none': return parseGeneric(lx);
    default:
      if (ti.n > 1) { const out = new Array(ti.n); parseTuple(lx, ti.n, out, 0); return out; }
      return parseNumber(lx);
  }
}

/** A value with no declared type (metadata). */
function parseGeneric(lx) {
  const t = lx.peek();
  if (t.t === 'str') { lx.next(); return t.v; }
  if (t.t === 'num') { lx.next(); return t.v; }
  if (t.t === 'asset') { lx.next(); return new Asset(t.v); }
  if (t.t === 'path') { lx.next(); return new SdfPath(t.v); }
  if (t.t === 'id') {
    lx.next();
    if (t.v === 'None') return BLOCK;
    if (t.v === 'true' || t.v === 'false') return t.v === 'true';
    if (t.v === 'inf') return Infinity;
    if (t.v === 'nan') return NaN;
    return t.v;
  }
  if (t.t === 'p' && t.v === '[') {
    lx.next();
    const items = [];
    while (!lx.is(']')) { items.push(parseGeneric(lx)); if (!lx.accept(',')) break; }
    lx.expect(']');
    return items;
  }
  if (t.t === 'p' && t.v === '(') {
    lx.next();
    const items = [];
    while (!lx.is(')')) { items.push(parseGeneric(lx)); if (!lx.accept(',')) break; }
    lx.expect(')');
    return items;
  }
  if (t.t === 'p' && t.v === '{') return parseDict(lx);
  throw lx.error(`unexpected ${describe(t)}`, t.at);
}

/** { type key = value ... } */
function parseDict(lx) {
  lx.expect('{');
  const entries = [];
  while (!lx.is('}')) {
    const tt = lx.next();
    if (tt.t !== 'id') throw lx.error(`expected a value type in a dictionary but found ${describe(tt)}`, tt.at);
    let type = tt.v;
    if (lx.is('[')) { lx.next(); lx.expect(']'); type += '[]'; }
    const kt = lx.next();
    if (kt.t !== 'id' && kt.t !== 'str') throw lx.error(`expected a dictionary key but found ${describe(kt)}`, kt.at);
    lx.expect('=');
    const v = type === 'dictionary' ? parseDict(lx) : parseTyped(lx, type);
    entries.push([kt.v, type, v]);
    lx.accept(';'); lx.accept(',');
  }
  lx.expect('}');
  return new Dict(entries);
}

function parseLayerOffset(lx, ref) {
  // ( offset = 1; scale = 2 )
  lx.expect('(');
  while (!lx.is(')')) {
    const k = lx.next();
    lx.expect('=');
    if (k.v === 'customData') ref.customData = parseDict(lx);
    else { const v = parseNumber(lx); if (k.v === 'offset') ref.offset = v; else if (k.v === 'scale') ref.scale = v; }
    lx.accept(';');
  }
  lx.expect(')');
}
function parseRefItem(lx) {
  const ref = new Ref();
  const t = lx.peek();
  if (t.t === 'asset') { lx.next(); ref.asset = t.v; if (lx.peek().t === 'path') ref.path = lx.next().v; } else if (t.t === 'path') { lx.next(); ref.path = t.v; } else throw lx.error(`expected an @asset@ or a <path> but found ${describe(t)}`, t.at);
  if (lx.is('(')) parseLayerOffset(lx, ref);
  return ref;
}
function parseListItems(lx, one) {
  if (lx.isId('None')) { lx.next(); return []; }
  if (lx.is('[')) {
    lx.next();
    const items = [];
    while (!lx.is(']')) { items.push(one()); if (!lx.accept(',')) break; }
    lx.expect(']');
    return items;
  }
  return [one()];
}
function parsePathItem(lx) { const t = lx.next(); if (t.t !== 'path') throw lx.error(`expected a <path> but found ${describe(t)}`, t.at); return new SdfPath(t.v); }

/** Metadata in "( ... )" into a Map. layer: layer-level keys (subLayers). */
function parseMetaBlock(lx, meta, isLayer) {
  lx.expect('(');
  while (!lx.is(')')) {
    const t = lx.peek();
    if (t.t === 'str') { lx.next(); meta.set(isLayer ? 'comment' : 'doc', t.v); lx.accept(';'); continue; }
    if (t.t !== 'id') throw lx.error(`expected a metadata name but found ${describe(t)}`, t.at);
    lx.next();
    let op = null, key = t.v;
    if (OP_WORDS[key] && lx.peek().t === 'id') { op = OP_WORDS[key]; key = lx.next().v; }
    lx.expect('=');
    let v;
    if (key === 'references' || key === 'payload') v = parseListItems(lx, () => parseRefItem(lx));
    else if (key === 'inherits' || key === 'specializes') v = parseListItems(lx, () => parsePathItem(lx));
    else if (key === 'variantSets' || key === 'apiSchemas') v = parseListItems(lx, () => { const s = lx.next(); if (s.t !== 'str') throw lx.error(`expected a quoted name but found ${describe(s)}`, s.at); return s.v; });
    else if (key === 'subLayers' && isLayer) {
      v = parseListItems(lx, () => { const a = lx.next(); if (a.t !== 'asset') throw lx.error(`expected an @asset@ but found ${describe(a)}`, a.at); const r = { asset: a.v, offset: 0, scale: 1 }; if (lx.is('(')) parseLayerOffset(lx, r); return r; });
    } else if (key === 'variants') v = parseDict(lx);
    else if (key === 'doc' || key === 'documentation') { const s = lx.next(); v = s.v; key = 'doc'; } else v = parseGeneric(lx);
    if (LISTOP_KEYS.has(key)) {
      const prev = meta.get(key) instanceof ListOp ? meta.get(key) : new ListOp(false, {});
      if (op) { prev.items[op] = v; } else { prev.explicit = true; prev.items.explicit = v; }
      meta.set(key, prev);
    } else meta.set(key, v);
    lx.accept(';');
  }
  lx.expect(')');
}

// ---------- prims ----------
function childPathOf(parent, name) { return parent === '/' ? '/' + name : parent.endsWith('}') ? parent + name : parent + '/' + name; }

function parsePrim(lx, parentPath, depth) {
  if (depth > 400) throw lx.error('prims are nested too deeply');
  const spec = lx.next().v;
  let typeName = '';
  if (lx.peek().t === 'id') typeName = lx.next().v;
  const nt = lx.next();
  if (nt.t !== 'str') throw lx.error(`expected the prim name in quotes but found ${describe(nt)}`, nt.at);
  const prim = new Prim(nt.v, childPathOf(parentPath, nt.v));
  prim.specifier = spec;
  prim.typeName = typeName;
  if (lx.is('(')) parseMetaBlock(lx, prim.meta, false);
  lx.expect('{');
  parseBody(lx, prim, depth);
  lx.expect('}');
  return prim;
}

function parseBody(lx, prim, depth) {
  while (!lx.is('}')) {
    const t = lx.peek();
    if (t.t === 'eof') throw lx.error(`the prim "${prim.name}" has no closing }`);
    if (t.t !== 'id') throw lx.error(`expected a prim, a property or a variant set but found ${describe(t)}`, t.at);
    if (SPECIFIERS.has(t.v)) { prim.children.push(parsePrim(lx, prim.path, depth + 1)); continue; }
    if (t.v === 'variantSet') { parseVariantSet(lx, prim, depth); continue; }
    if (t.v === 'reorder') {
      lx.next();
      const what = lx.peek();
      if (what.t === 'id' && (what.v === 'nameChildren' || what.v === 'properties')) {
        lx.next(); lx.expect('=');
        const names = parseListItems(lx, () => lx.next().v);
        if (what.v === 'nameChildren') prim.nameOrder = names; else prim.propOrder = names;
        lx.accept(';');
        continue;
      }
      parseProperty(lx, prim, 'order');
      continue;
    }
    if (OP_WORDS[t.v]) { lx.next(); parseProperty(lx, prim, OP_WORDS[t.v]); continue; }
    parseProperty(lx, prim, null);
  }
}

function parseVariantSet(lx, prim, depth) {
  lx.next();
  const nt = lx.next();
  if (nt.t !== 'str') throw lx.error(`expected the variant set name in quotes but found ${describe(nt)}`, nt.at);
  lx.expect('=');
  lx.expect('{');
  let vs = prim.variantSets.find((x) => x.name === nt.v);
  if (!vs) { vs = { name: nt.v, variants: [] }; prim.variantSets.push(vs); }
  while (!lx.is('}')) {
    const vt = lx.next();
    if (vt.t !== 'str') throw lx.error(`expected a variant name in quotes but found ${describe(vt)}`, vt.at);
    const vprim = new Prim(vt.v, `${prim.path}{${nt.v}=${vt.v}}`);
    vprim.specifier = '';
    if (lx.is('(')) parseMetaBlock(lx, vprim.meta, false);
    lx.expect('{');
    parseBody(lx, vprim, depth + 1);
    lx.expect('}');
    vs.variants.push({ name: vt.v, prim: vprim });
  }
  lx.expect('}');
}

function getProp(prim, name, kind) {
  let p = prim.prop(name);
  if (!p) { p = new Prop(name, kind); prim.props.push(p); }
  return p;
}

function parseProperty(lx, prim, op) {
  let custom = false, variability = '';
  if (lx.isId('custom')) { lx.next(); custom = true; }
  if (lx.peek().t === 'id' && VARIABILITY.has(lx.peek().v)) { const v = lx.next().v; variability = v === 'varying' ? '' : v; }
  const tt = lx.next();
  if (tt.t !== 'id') throw lx.error(`expected a property type but found ${describe(tt)}`, tt.at);
  if (tt.v === 'rel') {
    const nt = lx.next();
    if (nt.t !== 'id') throw lx.error(`expected a relationship name but found ${describe(nt)}`, nt.at);
    const name = nt.v.replace(/\.default$/, '');
    const p = getProp(prim, name, 'relationship');
    p.custom = p.custom || custom;
    if (variability === 'config') p.variability = 'config';
    if (lx.accept('=')) {
      const items = parseListItems(lx, () => parsePathItem(lx));
      if (!p.targets) p.targets = new ListOp(false, {});
      if (op) p.targets.items[op] = items; else { p.targets.explicit = true; p.targets.items.explicit = items; }
    }
    if (lx.is('(')) parseMetaBlock(lx, p.meta, false);
    lx.accept(';');
    return;
  }
  let typeName = tt.v;
  if (lx.is('[')) { lx.next(); lx.expect(']'); typeName += '[]'; }
  const nt = lx.next();
  if (nt.t !== 'id') throw lx.error(`expected an attribute name after "${typeName}" but found ${describe(nt)}`, nt.at);
  let name = nt.v, suffix = '';
  const m = /^(.*)\.(connect|timeSamples|spline|default)$/.exec(name);
  if (m) { name = m[1]; suffix = m[2]; }
  const p = getProp(prim, name, 'attribute');
  p.typeName = typeName;
  if (custom) p.custom = true;
  if (variability) p.variability = variability;
  if (suffix === 'connect') {
    lx.expect('=');
    const items = parseListItems(lx, () => parsePathItem(lx));
    if (!p.connect) p.connect = new ListOp(false, {});
    if (op) p.connect.items[op] = items; else { p.connect.explicit = true; p.connect.items.explicit = items; }
  } else if (suffix === 'timeSamples') {
    lx.expect('=');
    lx.expect('{');
    const samples = [];
    while (!lx.is('}')) {
      const time = parseNumber(lx);
      lx.expect(':');
      samples.push([time, parseTyped(lx, typeName)]);
      if (!lx.accept(',')) break;
    }
    lx.expect('}');
    p.timeSamples = samples;
  } else if (suffix === 'spline') {
    // Spline animation (USD 25.x): kept as unparsed text of its block.
    lx.expect('=');
    skipBlock(lx);
  } else if (lx.accept('=')) {
    p.value = parseTyped(lx, typeName);
  }
  if (lx.is('(')) parseMetaBlock(lx, p.meta, false);
  lx.accept(';');
}
function skipBlock(lx) {
  lx.expect('{');
  let depth = 1;
  while (depth) { const t = lx.next(); if (t.t === 'eof') throw lx.error('a block has no closing }'); if (t.t === 'p' && t.v === '{') depth++; if (t.t === 'p' && t.v === '}') depth--; }
}

function isUsda(buf) {
  const head = Buffer.from(buf.buffer ? buf.subarray(0, 16) : buf.slice(0, 16)).toString('latin1');
  return /^\s*#(usda|sdf)\s/.test(head.replace(/^﻿/, ''));
}

/** Parses USDA text into a Layer. Throws an Error that names the line and column. */
function parseUsda(text) {
  if (typeof text !== 'string') text = Buffer.from(text.buffer || text, text.byteOffset || 0, text.byteLength || text.length).toString('utf8');
  text = text.replace(/^﻿/, '');
  const m = /^\s*#(usda|sdf)\s+([\d.]+)[^\n]*/.exec(text);
  if (!m) throw new Error('This is not a USDA text layer: the first line must be "#usda 1.0".');
  const layer = new Layer('usda', m[2]);
  const lx = new Lexer(text);
  lx.i = m[0].length;
  if (lx.is('(')) parseMetaBlock(lx, layer.meta, true);
  for (;;) {
    const t = lx.peek();
    if (t.t === 'eof') break;
    if (t.t === 'id' && SPECIFIERS.has(t.v)) { layer.root.children.push(parsePrim(lx, '/', 0)); continue; }
    if (t.t === 'id' && t.v === 'reorder') { lx.next(); lx.next(); lx.expect('='); layer.root.nameOrder = parseListItems(lx, () => lx.next().v); continue; }
    throw lx.error(`expected def, over or class but found ${describe(t)}`, t.at);
  }
  if (layer.meta.has('subLayers') && Array.isArray(layer.meta.get('subLayers'))) {
    layer.meta.set('subLayers', layer.meta.get('subLayers').map((x) => (typeof x === 'object' && 'asset' in x ? x : { asset: x instanceof Asset ? x.asset : String(x), offset: 0, scale: 1 })));
  }
  return layer;
}

module.exports = { parseUsda, isUsda, Lexer };
