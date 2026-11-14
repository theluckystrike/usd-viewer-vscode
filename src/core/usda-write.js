'use strict';
// Writes a layer (from either parser) as USDA text: the readable view of USDC files and the Pro converter's output.
// opts.maxArray shortens long arrays for the read-only view (a "# N more values" comment closes the list); the
// converter writes every value.
const { Raw, Asset, SdfPath, Block, Tuples, ListOp, Ref, Dict, typeInfo, numFmt, fmtDouble } = require('./types');

const IND = '    ';

function quote(s) {
  s = String(s);
  if (s.includes('\n')) return '"""' + s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""') + '"""';
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}
function assetText(a) { const s = a instanceof Asset ? a.asset : String(a); return s.includes('@') ? '@@@' + s + '@@@' : '@' + s + '@'; }
function pathText(p) { return '<' + (p instanceof SdfPath ? p.path : String(p)) + '>'; }

/** Value text for a declared type (attributes, typed dictionary entries). */
function typed(v, typeName, opts = {}) {
  if (v instanceof Block) return 'None';
  if (v == null) return 'None';
  const ti = typeInfo(typeName);
  if (ti.array) {
    const max = opts.maxArray || Infinity;
    let items = [];
    const n = v instanceof Tuples ? v.length : v.length;
    const show = Math.min(n, max);
    const one = { ...ti, array: false };
    if (v instanceof Tuples) for (let i = 0; i < show; i++) items.push(scalar(v.data.subarray(i * v.n, i * v.n + v.n), one));
    else for (let i = 0; i < show; i++) items.push(scalar(v[i], one));
    let s = '[' + items.join(', ');
    if (show < n) s += ` # ${(n - show).toLocaleString('en-US')} more values not shown\n${IND}`;
    return s + ']';
  }
  return scalar(v, ti);
}

function scalar(v, ti) {
  if (v instanceof Block) return 'None';
  const f = numFmt(ti.base);
  switch (ti.base) {
    case 'b': return v === true || v === 1 ? '1' : '0';
    case 's': case 't': return quote(v);
    case 'a': return assetText(v);
    case 'm': {
      const rows = Array.isArray(v) && Array.isArray(v[0]) ? v : chunk(Array.from(v), ti.rows);
      return '( ' + rows.map((r) => '(' + Array.from(r).map(fmtDouble).join(', ') + ')').join(', ') + ' )';
    }
    case 'q': { const fq = numFmt(ti.elem || 'f'); return '(' + Array.from(v).map(fq).join(', ') + ')'; }
    default:
      if (ti.n > 1) return '(' + Array.from(v).map(f).join(', ') + ')';
      if (typeof v === 'number') return f(v);
      if (Array.isArray(v) || ArrayBuffer.isView(v)) return '(' + Array.from(v).map(f).join(', ') + ')';
      return generic(v);
  }
}
function chunk(a, n) { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }

/** Value text with no declared type (prim and layer metadata). */
function generic(v, depth = 1) {
  if (v === undefined || v === null || v instanceof Block) return 'None';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Raw) return v.text;
  if (typeof v === 'number') return fmtDouble(v);
  if (typeof v === 'string') return quote(v);
  if (v instanceof Asset) return assetText(v);
  if (v instanceof SdfPath) return pathText(v);
  if (v instanceof Ref) return refText(v);
  if (v instanceof Dict) return dictText(v, depth);
  if (v instanceof Tuples) return '[' + Array.from({ length: v.length }, (_, i) => '(' + v.at(i).map(fmtDouble).join(', ') + ')').join(', ') + ']';
  if (ArrayBuffer.isView(v)) return '[' + Array.from(v).map(fmtDouble).join(', ') + ']';
  if (Array.isArray(v)) {
    if (v.length && Array.isArray(v[0])) return '(' + v.map((x) => generic(x, depth)).join(', ') + ')';
    return '[' + v.map((x) => (x && typeof x === 'object' && 'offset' in x && 'asset' in x && !(x instanceof Ref) ? layerItem(x) : generic(x, depth))).join(', ') + ']';
  }
  if (v instanceof ListOp) return generic(v.all(), depth);
  if (typeof v === 'object' && 'offset' in v && 'scale' in v) return `(offset = ${fmtDouble(v.offset)}; scale = ${fmtDouble(v.scale)})`;
  return quote(String(v));
}
function offsetText(o, s) {
  const parts = [];
  if (o) parts.push(`offset = ${fmtDouble(o)}`);
  if (s !== 1 && s !== undefined) parts.push(`scale = ${fmtDouble(s)}`);
  return parts.length ? ` (${parts.join('; ')})` : '';
}
function refText(r) { return (r.asset ? assetText(r.asset) : '') + (r.path ? pathText(r.path) : '') + offsetText(r.offset, r.scale); }
function layerItem(x) { return assetText(x.asset) + offsetText(x.offset, x.scale); }
function dictText(d, depth) {
  if (!d.entries.length) return '{\n' + IND.repeat(depth - 1) + '}';
  const pad = IND.repeat(depth);
  const lines = d.entries.map(([k, t, v]) => {
    const key = /^[A-Za-z_][\w:]*$/.test(k) ? k : quote(k);
    if (t === 'dictionary' || v instanceof Dict) return `${pad}dictionary ${key} = ${dictText(v instanceof Dict ? v : new Dict([]), depth + 1)}`;
    const tn = t && t !== 'None' ? t : guessType(v);
    return `${pad}${tn} ${key} = ${tn === 'None' ? 'None' : typed(v, tn)}`;
  });
  return '{\n' + lines.join('\n') + '\n' + IND.repeat(depth - 1) + '}';
}
function guessType(v) {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (typeof v === 'string') return 'string';
  if (v instanceof Asset) return 'asset';
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return 'string[]';
  return 'string';
}

const BARE_SINGLE = new Set(['references', 'payload', 'inherits', 'specializes', 'variantSets']);
const OPS = [['delete', 'delete'], ['add', 'add'], ['prepend', 'prepend'], ['append', 'append'], ['order', 'reorder']];
function listItems(key, items, depth) {
  if (!items.length) return 'None';
  const one = (x) => (x instanceof Ref ? refText(x) : generic(x, depth));
  if (items.length === 1 && BARE_SINGLE.has(key)) return one(items[0]);
  if (items.some((x) => x instanceof Ref) && items.length > 1) return '[\n' + items.map((x) => IND.repeat(depth + 1) + one(x)).join(',\n') + '\n' + IND.repeat(depth) + ']';
  return '[' + items.map(one).join(', ') + ']';
}

/** Metadata lines inside "( ... )" for a prim or the layer. */
function metaLines(meta, depth, isLayer, sorted) {
  const pad = IND.repeat(depth);
  const out = [];
  const entries = sorted ? [...meta].sort((a, b) => dictLess(a[0], b[0])) : meta;
  for (const [k, v] of entries) {
    if (v === undefined) continue;
    if (k === 'comment' && isLayer) { out.push(`${pad}${quote(v)}`); continue; }
    if (k === 'doc') { out.push(`${pad}doc = ${quote(v)}`); continue; }
    if (k === 'subLayers' && isLayer) {
      out.push(`${pad}subLayers = [\n${(v || []).map((x) => pad + IND + layerItem(x)).join(',\n')}\n${pad}]`);
      continue;
    }
    if (v instanceof ListOp) {
      if (v.explicit) out.push(`${pad}${k} = ${listItems(k, v.items.explicit || [], depth)}`);
      for (const [field, word] of OPS) if (v.items[field] && v.items[field].length) out.push(`${pad}${word} ${k} = ${listItems(k, v.items[field], depth)}`);
      continue;
    }
    if (v instanceof Ref) { out.push(`${pad}${k} = ${refText(v)}`); continue; }
    if (v instanceof Dict) { out.push(`${pad}${k} = ${dictText(v, depth + 1)}`); continue; }
    out.push(`${pad}${k} = ${generic(v, depth + 1)}`);
  }
  return out;
}

function propLines(p, depth, opts) {
  const pad = IND.repeat(depth);
  const out = [];
  const meta = metaLines(p.meta, depth + 1, false, opts.sorted);
  const metaBlock = meta.length ? ` (\n${meta.join('\n')}\n${pad})` : '';
  if (p.kind === 'relationship') {
    const decl = `${p.custom ? 'custom ' : ''}${p.variability === 'config' ? 'config ' : ''}rel ${p.name}`;
    const t = p.targets;
    if (!t) out.push(pad + decl + metaBlock);
    else {
      const items = (x) => (x.length === 1 ? pathText(x[0]) : '[\n' + x.map((y) => pad + IND + pathText(y)).join(',\n') + '\n' + pad + ']');
      let wrote = false;
      if (t.explicit) { out.push(`${pad}${decl} = ${(t.items.explicit || []).length ? items(t.items.explicit) : 'None'}${metaBlock}`); wrote = true; }
      for (const [field, word] of OPS) if (t.items[field] && t.items[field].length) { out.push(`${pad}${word} ${decl} = ${items(t.items[field])}${wrote ? '' : metaBlock}`); wrote = true; }
      if (!wrote) out.push(pad + decl + metaBlock);
    }
    return out;
  }
  const decl = `${p.custom ? 'custom ' : ''}${p.variability ? p.variability + ' ' : ''}${p.typeName || 'float'} ${p.name}`;
  const hasDefault = p.value !== undefined;
  if (hasDefault || (!p.timeSamples && !p.connect)) out.push(pad + decl + (hasDefault ? ' = ' + typed(p.value, p.typeName, opts) : '') + metaBlock);
  else if (metaBlock) out.push(pad + decl + metaBlock);
  if (p.timeSamples) {
    const lines = p.timeSamples.map(([t, v]) => `${pad}${IND}${fmtDouble(t)}: ${typed(v, p.typeName, opts)},`);
    out.push(`${pad}${decl}.timeSamples = {\n${lines.join('\n')}\n${pad}}`);
  }
  if (p.connect) {
    const c = p.connect instanceof ListOp ? p.connect : new ListOp(true, { explicit: p.connect });
    const items = (x) => (x.length === 1 ? pathText(x[0]) : '[' + x.map(pathText).join(', ') + ']');
    if (c.explicit) out.push(`${pad}${decl}.connect = ${(c.items.explicit || []).length ? items(c.items.explicit) : 'None'}`);
    for (const [field, word] of OPS) if (c.items[field] && c.items[field].length) out.push(`${pad}${word} ${decl}.connect = ${items(c.items[field])}`);
  }
  return out;
}

function bodyLines(prim, depth, opts) {
  const pad = IND.repeat(depth);
  const blocks = [];
  if (prim.nameOrder) blocks.push([`${pad}reorder nameChildren = [${prim.nameOrder.map(quote).join(', ')}]`]);
  if (prim.propOrder) blocks.push([`${pad}reorder properties = [${prim.propOrder.map(quote).join(', ')}]`]);
  const props = [];
  const list = opts.sorted ? prim.props.slice().sort((a, b) => dictLess(a.name, b.name)) : prim.props;
  for (const p of list) props.push(...propLines(p, depth, opts));
  if (props.length) blocks.push(props);
  for (const c of prim.children) blocks.push(primLines(c, depth, opts));
  const vsLines = [];
  for (const vs of prim.variantSets) {
    // usdcat layout: no blank line before a variant set, variants by name, a blank line closes each variant body
    vsLines.push(`${pad}variantSet ${quote(vs.name)} = {`);
    const variants = opts.sorted ? vs.variants.slice().sort((x, y) => dictLess(x.name, y.name)) : vs.variants;
    for (const v of variants) {
      const meta = metaLines(v.prim.meta, depth + 2, false, opts.sorted);
      vsLines.push(`${pad}${IND}${quote(v.name)}${meta.length ? ` (\n${meta.join('\n')}\n${pad}${IND})` : ''} {`);
      vsLines.push(...bodyLines(v.prim, depth + 2, opts));
      vsLines.push('');
      vsLines.push(`${pad}${IND}}`);
    }
    vsLines.push(`${pad}}`);
  }
  const out = [];
  blocks.forEach((b, i) => { if (i) out.push(''); out.push(...b); });
  out.push(...vsLines);
  return out;
}

function primLines(prim, depth, opts) {
  const pad = IND.repeat(depth);
  const head = `${pad}${prim.specifier || 'def'} ${prim.typeName ? prim.typeName + ' ' : ''}${quote(prim.name)}`;
  const meta = metaLines(prim.meta, depth + 1, false, opts.sorted);
  const out = [meta.length ? `${head} (\n${meta.join('\n')}\n${pad})` : head, `${pad}{`];
  out.push(...bodyLines(prim, depth + 1, opts));
  out.push(`${pad}}`);
  return out;
}

/** Name order USD uses when it writes text (case-insensitive, digit runs by value). */
function dictLess(a, b) {
  const ca = String(a).match(/\d+|\D+/g) || [], cb = String(b).match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const x = ca[i], y = cb[i];
    const dx = /^\d/.test(x), dy = /^\d/.test(y);
    if (dx && dy) { const d = Number(x) - Number(y); if (d) return d; continue; }
    const lx = x.toLowerCase(), ly = y.toLowerCase();
    if (lx !== ly) return lx < ly ? -1 : 1;
  }
  if (ca.length !== cb.length) return ca.length - cb.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The whole layer as USDA text. opts: { sorted (usdcat order for USDC sources), maxArray } */
function toUsda(layer, opts = {}) {
  const lines = ['#usda 1.0'];
  let lm = layer.meta;
  if (opts.sorted) {
    // usdcat order: the comment, the other fields by name, subLayers last
    const rank = (k) => (k === 'comment' ? 0 : k === 'subLayers' ? 3 : 2);
    lm = new Map([...layer.meta].sort((a, b) => rank(a[0]) - rank(b[0]) || dictLess(a[0], b[0])));
  }
  const meta = metaLines(lm, 1, true);
  if (meta.length) lines.push('(', ...meta, ')');
  for (const c of layer.root.children) { lines.push(''); lines.push(...primLines(c, 0, opts)); }
  return lines.join('\n') + '\n\n';
}

module.exports = { dictLess, toUsda, typed, generic, quote, assetText, pathText };
