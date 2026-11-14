'use strict';
// A small USD composition for viewing: the root layer, its sublayers, the selected variants, references, payloads,
// inherits and specializes, merged strongest first into one prim tree. Layer offsets, relocates, value clips,
// list-op deletes across layers and per-time composition are not modelled (see RELEASE.md).
//
// loadClosure() reads every layer the root layer can reach (async, through a read function), compose() builds the
// tree, and geometry() turns Mesh and the simple shapes (Cube, Sphere, Cylinder, Cone, Capsule, Plane) into world
// space triangles for the 3D view.
const path = require('path');
const { openAny } = require('./layer');
const { Asset, Block, Tuples, ListOp, Ref, Dict } = require('./types');
const { walk } = require('./model');

const MAX_LAYERS = 300;
const MAX_DEPTH = 64;

// ---------- asset resolution ----------
/** Layer ids: an absolute file path, or "<usdz path>[<entry>]" for a layer inside a package. */
function splitPackage(id) {
  const m = /^(.*\.usdz)\[(.+)\]$/i.exec(id);
  return m ? { pkg: m[1], entry: m[2] } : null;
}

/**
 * Where an asset path written in layer `fromId` points. Returns { id, kind: 'file'|'package' } or { error }.
 * hasEntry(pkg, entry) tells whether a package holds an entry (so a path inside a USDZ prefers the package).
 */
function resolveAsset(asset, fromId, hasEntry) {
  let a = String(asset || '').trim();
  if (!a) return { error: 'empty asset path' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a) && !/^file:/i.test(a)) return { error: 'not a local path (a URL or a custom resolver path)' };
  a = a.replace(/^file:(\/\/)?/i, '');
  const inner = /^(.*?)\[(.+)\]$/.exec(a);
  const from = splitPackage(fromId);
  if (from) {
    // relative to the layer inside the package first
    if (!path.isAbsolute(a) && !inner) {
      const entry = path.posix.normalize(path.posix.join(path.posix.dirname(from.entry), a)).replace(/^\.\//, '');
      if (!entry.startsWith('../') && hasEntry && hasEntry(from.pkg, entry)) return { id: `${from.pkg}[${entry}]`, kind: 'package' };
    }
    fromId = from.pkg;
  }
  const base = path.dirname(fromId);
  if (inner) {
    const pkg = path.isAbsolute(inner[1]) ? inner[1] : path.join(base, inner[1]);
    return { id: `${pkg}[${inner[2]}]`, kind: 'package' };
  }
  return { id: path.isAbsolute(a) ? path.normalize(a) : path.join(base, a), kind: 'file' };
}

/** Every external asset path a layer names in sublayers, references and payloads. */
function layerArcs(layer) {
  const out = [];
  for (const s of layer.meta.get('subLayers') || []) out.push({ kind: 'sublayer', asset: typeof s === 'string' ? s : s.asset, where: '/' });
  const fromMeta = (p) => {
    for (const k of ['references', 'payload']) {
      const v = p.meta.get(k);
      const items = v instanceof ListOp ? v.all() : v instanceof Ref ? [v] : [];
      for (const r of items) if (r instanceof Ref && r.asset) out.push({ kind: k === 'payload' ? 'payload' : 'reference', asset: r.asset, path: r.path, where: p.path });
    }
  };
  walk(layer.root, fromMeta, true);
  return out;
}

/**
 * Reads the root layer and every layer it can reach. read(id) -> Promise<Uint8Array> (throws when missing).
 * Returns { root: id, layers: Map(id -> { layer, kind, usdz, error }) }.
 */
async function loadClosure(rootId, rootBytes, read, opts = {}) {
  const layers = new Map();
  const packages = new Map(); // usdz path -> openUsdz result
  const maxLayers = opts.maxLayers || MAX_LAYERS;
  const hasEntry = (pkg, entry) => { const p = packages.get(pkg); return !!(p && p.has(entry)); };
  async function readId(id) {
    const sp = splitPackage(id);
    if (!sp) return read(id);
    let pkg = packages.get(sp.pkg);
    if (!pkg) {
      const bytes = await read(sp.pkg);
      const { openUsdz } = require('./usdz');
      pkg = openUsdz(bytes);
      packages.set(sp.pkg, pkg);
    }
    return pkg.read(sp.entry);
  }
  // the root
  const first = openAny(rootBytes, rootId);
  let rootKey = rootId;
  if (first.kind === 'usdz') {
    packages.set(rootId, first.usdz);
    rootKey = `${rootId}[${first.rootName}]`;
  }
  layers.set(rootKey, { layer: first.layer, kind: first.kind === 'usdz' ? first.rootKind : first.kind });
  const queue = [rootKey];
  while (queue.length) {
    const id = queue.shift();
    const entry = layers.get(id);
    if (!entry.layer) continue;
    for (const arc of layerArcs(entry.layer)) {
      const r = resolveAsset(arc.asset, id, hasEntry);
      arc.id = r.id || '';
      if (r.error) continue;
      if (layers.has(r.id)) continue;
      const ext = (/\.([A-Za-z0-9]+)(\]|$)/.exec(r.id) || [])[1] || '';
      if (ext && !/^usd[acz]?$/i.test(ext)) { layers.set(r.id, { error: `a .${ext} file, which needs a USD file format plug-in (not read here)` }); continue; }
      if (layers.size >= maxLayers) { layers.set(r.id, { error: `not opened: more than ${maxLayers} layers` }); continue; }
      try {
        const bytes = await readId(r.id);
        const o = openAny(bytes, r.id);
        if (o.kind === 'usdz') {
          packages.set(r.id, o.usdz);
          const innerId = `${r.id}[${o.rootName}]`;
          layers.set(r.id, { alias: innerId });
          if (!layers.has(innerId)) { layers.set(innerId, { layer: o.layer, kind: o.rootKind }); queue.push(innerId); }
        } else {
          layers.set(r.id, { layer: o.layer, kind: o.kind });
          queue.push(r.id);
        }
      } catch (e) {
        layers.set(r.id, { error: /ENOENT|not found|FileNotFound|EntryNotFound|is not in this USDZ/i.test(String(e && (e.code || e.message))) ? 'file not found' : String((e && e.message) || e) });
      }
    }
  }
  return { root: rootKey, layers, packages, hasEntry };
}

// ---------- composition ----------
class Node {
  constructor(name, p) {
    this.name = name;
    this.path = p;
    this.typeName = '';
    this.specifier = '';
    this.meta = new Map();
    this.props = new Map();
    this.children = new Map();
    this.variantSets = []; // [{ name, selection, choices }]
    this.arcs = []; // [{ kind, asset, path, ok, error, layer }]
    this.sources = []; // layer ids with opinions
  }
}

function listItems(v) { return v instanceof ListOp ? listResult(v) : v instanceof Ref ? [v] : Array.isArray(v) ? v : []; }
function listResult(op) {
  if (op.explicit) return (op.items.explicit || []).slice();
  const del = new Set((op.items.delete || []).map(keyOf));
  return [...(op.items.prepend || []), ...(op.items.add || []), ...(op.items.append || [])].filter((x) => !del.has(keyOf(x)));
}
function keyOf(x) { return x instanceof Ref ? `${x.asset}<${x.path}>` : x && x.path !== undefined ? x.path : String(x); }

/** Path translation across a reference: paths under `from` in the referenced layer name prims under `to`. */
function swapMap(from, to, outer) {
  if (from === to && !outer) return null;
  return (p) => {
    if (p === from || p.startsWith(from + '/') || p.startsWith(from + '.') || p.startsWith(from + '{')) return to + p.slice(from.length);
    return outer ? outer(p) : p;
  };
}
function mapList(op, fn) {
  if (!(op instanceof ListOp)) return op;
  const items = {};
  for (const [k, list] of Object.entries(op.items)) items[k] = (list || []).map((x) => (x && typeof x.path === 'string' && !(x instanceof Ref) ? new (x.constructor)(fn(x.path)) : x));
  return new ListOp(op.explicit, items);
}
function copyProp(p) {
  const o = Object.assign(Object.create(Object.getPrototypeOf(p)), p);
  o.meta = new Map(p.meta);
  return o;
}

/** Composes the closure into a Node tree. Returns { root: Node, upAxis, metersPerUnit, startTime, warnings }. */
function compose(closure, opts = {}) {
  const { layers } = closure;
  const getLayer = (id) => { let e = layers.get(id); if (e && e.alias) e = layers.get(e.alias); return e || null; };
  const rootEntry = getLayer(closure.root);
  const rootLayer = rootEntry.layer;
  const warnings = [];
  let merges = 0;
  const stacks = new Map();
  /** A layer and its sublayers, strongest first: [{ id, layer }]. */
  function stackOf(id, seen = new Set()) {
    if (stacks.has(id)) return stacks.get(id);
    const out = [];
    let e = layers.get(id);
    let realId = id;
    if (e && e.alias) { realId = e.alias; e = layers.get(e.alias); }
    if (!e || !e.layer || seen.has(realId)) return out;
    seen.add(realId);
    out.push({ id: realId, layer: e.layer });
    for (const sl of e.layer.meta.get('subLayers') || []) {
      const res = resolveAsset(typeof sl === 'string' ? sl : sl.asset, realId, closure.hasEntry);
      if (!res.error) out.push(...stackOf(res.id, seen));
    }
    stacks.set(id, out);
    return out;
  }
  const maxMerges = opts.maxMerges || 400000;
  const stack = new Set();

  function mergeLocal(node, spec, ctx) {
    if (!node.typeName && spec.typeName) node.typeName = spec.typeName;
    if (spec.specifier === 'def' || (!node.specifier && spec.specifier)) node.specifier = spec.specifier === 'def' || node.specifier === 'def' ? 'def' : spec.specifier || node.specifier;
    for (const [k, v] of spec.meta) {
      if (!node.meta.has(k)) node.meta.set(k, v);
      else if (k === 'variants' && v instanceof Dict) {
        const cur = node.meta.get(k);
        const merged = new Dict(cur.entries.slice());
        for (const e of v.entries) if (merged.get(e[0]) === undefined) merged.entries.push(e);
        node.meta.set(k, merged);
      } else if (k === 'apiSchemas' && v instanceof ListOp && node.meta.get(k) instanceof ListOp) {
        const all = [...new Set([...listResult(node.meta.get(k)), ...listResult(v)])];
        node.meta.set(k, new ListOp(true, { explicit: all }));
      }
    }
    for (const p of spec.props) {
      const cur = node.props.get(p.name);
      const targets = p.targets && ctx.map ? mapList(p.targets, ctx.map) : p.targets;
      const connect = p.connect && ctx.map ? mapList(p.connect, ctx.map) : p.connect;
      if (!cur) { const c = copyProp(p); c.layer = ctx.id; c.targets = targets; c.connect = connect; node.props.set(p.name, c); continue; }
      if (cur.value === undefined && p.value !== undefined) cur.value = p.value;
      if (!cur.timeSamples && p.timeSamples) cur.timeSamples = p.timeSamples;
      if (!cur.typeName && p.typeName) cur.typeName = p.typeName;
      if (!cur.connect && connect) cur.connect = connect;
      if (!cur.targets && targets) cur.targets = targets;
      for (const [k, v] of p.meta) if (!cur.meta.has(k)) cur.meta.set(k, v);
    }
    if (!node.sources.includes(ctx.id)) node.sources.push(ctx.id);
  }

  function mergeSpec(node, spec, ctx, depth) {
    if (!spec) return;
    if (++merges > maxMerges) { if (merges === maxMerges + 1) warnings.push(`Stopped composing after ${maxMerges.toLocaleString('en-US')} prim opinions.`); return; }
    const key = `${ctx.id}|${spec.path}`;
    if (stack.has(key)) { warnings.push(`A composition cycle at ${spec.path} in ${path.basename(ctx.id)} was skipped.`); return; }
    if (depth > MAX_DEPTH) { warnings.push(`Composition deeper than ${MAX_DEPTH} arcs at ${node.path} was skipped.`); return; }
    stack.add(key);
    try {
      mergeLocal(node, spec, ctx);
      for (const c of spec.children) {
        let child = node.children.get(c.name);
        if (!child) { child = new Node(c.name, node.path === '/' ? '/' + c.name : node.path + '/' + c.name); node.children.set(c.name, child); }
        mergeSpec(child, c, ctx, depth);
      }
      // variants: the strongest selection seen so far, else the selection on this spec; no selection = no variant
      for (const vs of spec.variantSets) {
        const selDict = node.meta.get('variants');
        const sel = selDict instanceof Dict ? selDict.get(vs.name) : undefined;
        let rec = node.variantSets.find((x) => x.name === vs.name);
        if (!rec) { rec = { name: vs.name, selection: sel || '', choices: [] }; node.variantSets.push(rec); }
        for (const v of vs.variants) if (!rec.choices.includes(v.name)) rec.choices.push(v.name);
        if (!rec.selection && sel) rec.selection = sel;
        const chosen = vs.variants.find((v) => v.name === rec.selection);
        if (chosen) mergeSpec(node, chosen.prim, ctx, depth + 1);
      }
      // references and payloads
      for (const k of ['references', 'payload']) {
        for (const r of listItems(spec.meta.get(k))) {
          if (!(r instanceof Ref)) continue;
          const arc = { kind: k === 'payload' ? 'payload' : 'reference', asset: r.asset, path: r.path, ok: false, error: '', layer: '' };
          node.arcs.push(arc);
          if (!r.asset) {
            const target = ctx.layer.primAt(r.path);
            if (!target) { arc.error = `no prim at ${r.path}`; continue; }
            arc.ok = true; arc.layer = ctx.id;
            mergeSpec(node, target, { ...ctx, map: swapMap(target.path, node.path, ctx.map) }, depth + 1);
            continue;
          }
          const res = resolveAsset(r.asset, ctx.id, closure.hasEntry);
          if (res.error) { arc.error = res.error; continue; }
          const ls = stackOf(res.id);
          if (!ls.length) { const e = getLayer(res.id); arc.error = (e && e.error) || 'file not found'; continue; }
          // the target: the prim path, else defaultPrim of the referenced layer stack, else its first root prim
          let tpath = r.path;
          if (!tpath) {
            const withDefault = ls.find((x) => typeof x.layer.meta.get('defaultPrim') === 'string' && x.layer.meta.get('defaultPrim'));
            if (withDefault) tpath = '/' + String(withDefault.layer.meta.get('defaultPrim')).replace(/^\//, '');
            else { const firstRoot = ls.map((x) => x.layer.root.children[0]).find(Boolean); tpath = firstRoot ? firstRoot.path : ''; }
          }
          const specs = tpath ? ls.map((x) => ({ x, spec: x.layer.primAt(tpath) })).filter((y) => y.spec) : [];
          if (!specs.length) { arc.error = r.path ? `no prim at ${r.path} in that layer` : 'that layer has no defaultPrim and no root prim'; continue; }
          arc.ok = true; arc.layer = ls[0].id;
          for (const { x, spec: sp } of specs) mergeSpec(node, sp, { id: x.id, layer: x.layer, map: swapMap(tpath, node.path, null) }, depth + 1);
        }
      }
      for (const k of ['inherits', 'specializes']) {
        for (const p of listItems(spec.meta.get(k))) {
          const target = ctx.layer.primAt(p && p.path);
          const arc = { kind: k === 'inherits' ? 'inherit' : 'specialize', asset: '', path: p && p.path, ok: !!target, error: target ? '' : 'class not in this layer', layer: ctx.id };
          node.arcs.push(arc);
          if (target) mergeSpec(node, target, { ...ctx, map: swapMap(target.path, node.path, ctx.map) }, depth + 1);
        }
      }
    } finally { stack.delete(key); }
  }

  const root = new Node('', '/');
  // root layer, then its sublayers (weaker), depth first
  const seenSub = new Set();
  function mergeLayer(id, layer, depth) {
    if (seenSub.has(id) || depth > 32) return;
    seenSub.add(id);
    mergeSpec(root, layer.root, { id, layer }, 0);
    for (const s of layer.meta.get('subLayers') || []) {
      const res = resolveAsset(typeof s === 'string' ? s : s.asset, id, closure.hasEntry);
      const arc = { kind: 'sublayer', asset: typeof s === 'string' ? s : s.asset, path: '', ok: false, error: res.error || '', layer: '' };
      root.arcs.push(arc);
      if (res.error) continue;
      const e = getLayer(res.id);
      if (!e || !e.layer) { arc.error = (e && e.error) || 'file not found'; continue; }
      arc.ok = true; arc.layer = res.id;
      mergeLayer(res.id, e.layer, depth + 1);
    }
  }
  mergeLayer(closure.root, rootLayer, 0);
  const num = (k, d) => { const v = rootLayer.meta.get(k); return typeof v === 'number' ? v : d; };
  const up = rootLayer.meta.get('upAxis');
  return {
    root, warnings,
    upAxis: up === 'Z' ? 'Z' : 'Y', upAxisSet: typeof up === 'string',
    metersPerUnit: num('metersPerUnit', 0.01), metersSet: rootLayer.meta.has('metersPerUnit'),
    startTime: num('startTimeCode', NaN), endTime: num('endTimeCode', NaN),
    defaultPrim: rootLayer.meta.get('defaultPrim') || '',
  };
}

function allNodes(root) { const out = []; eachNode(root, (n) => { out.push(n); }); return out; }
function eachNode(root, fn) {
  const go = (n, depth) => { for (const c of n.children.values()) { if (fn(c, depth) === false) continue; go(c, depth + 1); } };
  go(root, 0);
}
function nodeAt(root, p) {
  if (!p || p === '/') return root;
  let cur = root;
  for (const part of String(p).split('/').filter(Boolean)) { cur = cur.children.get(part); if (!cur) return null; }
  return cur;
}

// ---------- values at a time ----------
/** The value to show: the time sample at or before `time` (the first one when none), else the default. */
function valueOf(prop, time) {
  if (!prop) return undefined;
  if (prop.timeSamples && prop.timeSamples.length) {
    let best = prop.timeSamples[0];
    if (Number.isFinite(time)) for (const s of prop.timeSamples) if (s[0] <= time) best = s;
    if (!(best[1] instanceof Block)) return best[1];
  }
  return prop.value instanceof Block ? undefined : prop.value;
}

// ---------- matrices (row vectors, as USD) ----------
const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]; o[r * 4 + c] = s; }
  return o;
}
function invert(m) {
  const inv = new Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return I4();
  const d = 1 / det;
  inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d; inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d; inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d; inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d; inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d; inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d; inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d; inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d; inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d; inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d; inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d; inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d; inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return inv;
}
const rad = (deg) => (deg * Math.PI) / 180;
function rotAxis(axis, deg) {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  if (axis === 'X') return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  if (axis === 'Y') return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function quatMatrix(q) {
  let [w, x, y, z] = q;
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n; x /= n; y /= n; z /= n;
  // row-vector form (transpose of the column-vector rotation)
  return [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 0,
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 0,
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1];
}
const vec3 = (v, d) => (Array.isArray(v) || ArrayBuffer.isView(v) ? [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0] : typeof v === 'number' ? [v, v, v] : d);
function matFromValue(v) {
  if (!Array.isArray(v)) return I4();
  const flat = v.flat ? v.flat() : v;
  return flat.length === 16 ? flat.map(Number) : I4();
}

/** The local transform of a node from its xformOpOrder. { matrix, reset }. */
function localTransform(node, time) {
  const order = valueOf(node.props.get('xformOpOrder'), time);
  if (!order || !order.length) return { matrix: null, reset: false };
  let reset = false;
  const ops = [];
  for (const raw of order) {
    let name = String(raw);
    if (name === '!resetXformStack!') { reset = true; ops.length = 0; continue; }
    let inv = false;
    if (name.startsWith('!invert!')) { inv = true; name = name.slice(8); }
    const v = valueOf(node.props.get(name), time);
    const kind = (/^xformOp:([A-Za-z]+)/.exec(name) || [])[1] || '';
    let m = I4();
    if (kind === 'translate') { const t = vec3(v, [0, 0, 0]); m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; } else if (kind === 'scale') { const s = vec3(v, [1, 1, 1]); m[0] = s[0]; m[5] = s[1]; m[10] = s[2]; } else if (/^rotate[XYZ]$/.test(kind)) m = rotAxis(kind[6], Number(v) || 0);
    else if (/^rotate[XYZ]{3}$/.test(kind)) { const a = vec3(v, [0, 0, 0]); const idx = { X: 0, Y: 1, Z: 2 }; for (const ax of kind.slice(6)) m = mul(m, rotAxis(ax, a[idx[ax]])); } else if (kind === 'orient') m = Array.isArray(v) || ArrayBuffer.isView(v) ? quatMatrix(Array.from(v).map(Number)) : I4();
    else if (kind === 'transform') m = matFromValue(v);
    if (inv) m = invert(m);
    ops.push(m);
  }
  let M = I4();
  for (let i = ops.length - 1; i >= 0; i--) M = mul(M, ops[i]);
  return { matrix: M, reset };
}

// ---------- materials ----------
function primvarColor(node, time) {
  const v = valueOf(node.props.get('primvars:displayColor'), time);
  if (v instanceof Tuples && v.length) return v.at(0);
  if (Array.isArray(v) && v.length === 3 && typeof v[0] === 'number') return v;
  return null;
}
function boundMaterial(node, root) {
  const rel = node.props.get('material:binding');
  if (!rel || !rel.targets) return null;
  const t = listItems(rel.targets)[0];
  return t ? nodeAt(root, t.path) : null;
}
function materialColor(mat, root, time) {
  if (!mat) return null;
  const out = mat.props.get('outputs:surface') || mat.props.get('outputs:mdl:surface') || mat.props.get('outputs:mtlx:surface');
  const conn = out && out.connect ? listItems(out.connect)[0] : null;
  let shader = conn ? nodeAt(root, String(conn.path).replace(/\.[^/]*$/, '')) : null;
  if (!shader) for (const c of mat.children.values()) if (c.typeName === 'Shader') { shader = c; break; }
  if (!shader) return null;
  for (const name of ['inputs:diffuseColor', 'inputs:base_color', 'inputs:diffuse_color_constant', 'inputs:baseColor']) {
    const p = shader.props.get(name);
    if (!p) continue;
    if (p.connect) return { color: [0.78, 0.78, 0.78], textured: true };
    const v = valueOf(p, time);
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return { color: vec3(v, [0.7, 0.7, 0.7]), textured: false };
  }
  return null;
}

// ---------- shapes ----------
function shapeMesh(node, time) {
  const num = (n, d) => { const v = valueOf(node.props.get(n), time); return typeof v === 'number' ? v : d; };
  const axis = String(valueOf(node.props.get('axis'), time) || 'Z');
  const pts = [], counts = [], idx = [];
  const orient = (x, y, z) => (axis === 'X' ? [z, x, y] : axis === 'Y' ? [y, z, x] : [x, y, z]); // local Z up -> axis
  const seg = 32;
  const ring = (r, h) => { const s = pts.length / 3; for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; pts.push(...orient(r * Math.cos(a), r * Math.sin(a), h)); } return s; };
  const cap = (s, flip) => { counts.push(seg); for (let i = 0; i < seg; i++) idx.push(s + (flip ? seg - 1 - i : i)); };
  const side = (a, b) => { for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; counts.push(4); idx.push(a + i, a + j, b + j, b + i); } };
  switch (node.typeName) {
    case 'Cube': {
      const h = num('size', 2) / 2;
      for (const z of [-h, h]) for (const y of [-h, h]) for (const x of [-h, h]) pts.push(x, y, z);
      for (const f of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) { counts.push(4); idx.push(...f); }
      break;
    }
    case 'Sphere': {
      const r = num('radius', 1), st = 16;
      for (let i = 0; i <= st; i++) { const t = (i / st) * Math.PI; for (let j = 0; j < seg; j++) { const p = (j / seg) * Math.PI * 2; pts.push(r * Math.sin(t) * Math.cos(p), r * Math.cos(t), r * Math.sin(t) * Math.sin(p)); } }
      for (let i = 0; i < st; i++) for (let j = 0; j < seg; j++) { const k = (j + 1) % seg; counts.push(4); idx.push(i * seg + j, i * seg + k, (i + 1) * seg + k, (i + 1) * seg + j); }
      break;
    }
    case 'Cylinder': case 'Cone': case 'Capsule': {
      const r = num('radius', node.typeName === 'Capsule' ? 0.5 : 1), h = num('height', node.typeName === 'Capsule' ? 1 : 2) / 2;
      const bottom = ring(r, -h), top = node.typeName === 'Cone' ? ring(0.0001, h) : ring(r, h);
      side(bottom, top); cap(bottom, true); if (node.typeName !== 'Cone') cap(top, false);
      if (node.typeName === 'Capsule') { // hemispherical ends as two extra rings
        const b2 = ring(r * 0.7, -h - r * 0.7), t2 = ring(r * 0.7, h + r * 0.7);
        side(b2, bottom); side(top, t2); cap(b2, true); cap(t2, false);
      }
      break;
    }
    case 'Plane': {
      const w = num('width', 2) / 2, l = num('length', 2) / 2;
      const ax = String(valueOf(node.props.get('axis'), time) || 'Z');
      const p = [[-w, -l], [w, -l], [w, l], [-w, l]];
      for (const [a, b] of p) pts.push(...(ax === 'X' ? [0, a, b] : ax === 'Y' ? [a, 0, b] : [a, b, 0]));
      counts.push(4); idx.push(0, 1, 2, 3);
      break;
    }
    default: return null;
  }
  return { points: Float32Array.from(pts), counts, indices: idx };
}
const SHAPES = new Set(['Cube', 'Sphere', 'Cylinder', 'Cone', 'Capsule', 'Plane']);

/**
 * World-space triangles and polygon edges for the 3D view.
 * Returns { positions: Float32Array (xyz per vertex), colors: Uint8Array (rgb per vertex), triangles32: Uint32Array
 *   (3 vertex indices per triangle), lines32: Uint32Array (2 per polygon edge), parts: [{ path, tri: [start, count], line: [start, count] }],
 *   ranges: { path: [triStart, triCount, lineStart, lineCount] } for every prim that has geometry below it,
 *   bounds: [min xyz, max xyz] | null, meshes, triangles, points, skipped: [reasons], truncated }
 */
function geometry(stage, opts = {}) {
  const time = Number.isFinite(opts.time) ? opts.time : stage.startTime;
  const maxTris = opts.maxTriangles || 3000000;
  const maxLines = opts.maxLines || 3000000;
  let tris = 0, lineCount = 0;
  let triTotal = 0, pointTotal = 0, meshes = 0;
  const parts = [];
  const skipped = new Map();
  const skip = (why) => skipped.set(why, (skipped.get(why) || 0) + 1);
  let truncated = false;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const ranges = {};
  // Indexed buffers: world-space vertices with an rgb color each, triangle indices and edge (line) indices.
  let vpos = new Float32Array(1 << 16), vcol = new Uint8Array(1 << 16), tidx = new Uint32Array(1 << 16), lidx = new Uint32Array(1 << 16);
  let vn = 0, tn = 0, lnn = 0;
  const grow = (arr, used, n, Ctor) => { if (used + n <= arr.length) return arr; const a = new Ctor(Math.max(arr.length * 2, used + n)); a.set(arr.subarray(0, used)); return a; };
  const rgb = (c) => [0, 1, 2].map((i) => Math.round(Math.min(1, Math.max(0, Number(c[i]) || 0)) * 255));

  function emitMesh(node, world, mesh, baseColor, faceColors) {
    const P = mesh.points;
    const nPts = Math.floor(P.length / 3);
    const W = world;
    const base = vn;
    const bc = rgb(baseColor);
    vpos = grow(vpos, vn * 3, nPts * 3, Float32Array); vcol = grow(vcol, vn * 3, nPts * 3, Uint8Array);
    for (let i = 0; i < nPts; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const X = x * W[0] + y * W[4] + z * W[8] + W[12], Y = x * W[1] + y * W[5] + z * W[9] + W[13], Z = x * W[2] + y * W[6] + z * W[10] + W[14];
      vpos[vn * 3] = X; vpos[vn * 3 + 1] = Y; vpos[vn * 3 + 2] = Z;
      vcol[vn * 3] = bc[0]; vcol[vn * 3 + 1] = bc[1]; vcol[vn * 3 + 2] = bc[2];
      vn++;
      if (X < min[0]) min[0] = X; if (Y < min[1]) min[1] = Y; if (Z < min[2]) min[2] = Z;
      if (X > max[0]) max[0] = X; if (Y > max[1]) max[1] = Y; if (Z > max[2]) max[2] = Z;
    }
    pointTotal += nPts;
    const triStart = tris, lineStart = lineCount;
    let k = 0;
    const counts = mesh.counts, idx = mesh.indices;
    for (let f = 0; f < counts.length; f++) {
      const n = counts[f];
      if (n < 3 || k + n > idx.length) { k += Math.max(0, n); continue; }
      triTotal += n - 2;
      let bad = false;
      for (let e = 0; e < n; e++) { const v = idx[k + e]; if (v < 0 || v >= nPts) { bad = true; break; } }
      if (bad) { k += n; continue; }
      if (tris + n - 2 <= maxTris) {
        const fc = faceColors && faceColors[f] ? rgb(faceColors[f]) : null;
        tidx = grow(tidx, tn, (n - 2) * 3, Uint32Array);
        if (fc) { vpos = grow(vpos, vn * 3, (n - 2) * 9, Float32Array); vcol = grow(vcol, vn * 3, (n - 2) * 9, Uint8Array); }
        for (let t = 1; t < n - 1; t++) {
          for (const v of [idx[k], idx[k + t], idx[k + t + 1]]) {
            if (fc) {
              vpos[vn * 3] = vpos[(base + v) * 3]; vpos[vn * 3 + 1] = vpos[(base + v) * 3 + 1]; vpos[vn * 3 + 2] = vpos[(base + v) * 3 + 2];
              vcol[vn * 3] = fc[0]; vcol[vn * 3 + 1] = fc[1]; vcol[vn * 3 + 2] = fc[2];
              tidx[tn++] = vn++;
            } else tidx[tn++] = base + v;
          }
          tris++;
        }
      } else truncated = true;
      if (lineCount + n <= maxLines) {
        lidx = grow(lidx, lnn, n * 2, Uint32Array);
        for (let e = 0; e < n; e++) { lidx[lnn++] = base + idx[k + e]; lidx[lnn++] = base + idx[k + ((e + 1) % n)]; lineCount++; }
      }
      k += n;
    }
    parts.push({ path: node.path, tri: [triStart, tris - triStart], line: [lineStart, lineCount - lineStart] });
    meshes++;
  }

  const protoSet = new Set();
  for (const n of allNodes(stage.root)) if (n.typeName === 'PointInstancer' && n.props.get('prototypes')) for (const t of listItems(n.props.get('prototypes').targets)) protoSet.add(t.path);
  function visit(node, parentWorld, inherited, asPrototype) {
    if (!asPrototype && protoSet.has(node.path)) return null;
    const active = node.meta.get('active');
    if (active === false) { skip('inactive prims'); return null; }
    if (node.specifier === 'class' || node.specifier === 'over') return null; // not defined on the stage
    if (valueOf(node.props.get('visibility'), time) === 'invisible') { skip('invisible prims'); return null; }
    const purpose = valueOf(node.props.get('purpose'), time);
    if (purpose === 'guide' || purpose === 'proxy') { skip(`${purpose} purpose prims`); return null; }
    const lt = localTransform(node, time);
    const world = lt.reset ? (lt.matrix || I4()) : lt.matrix ? mul(lt.matrix, parentWorld) : parentWorld;
    const startTri = tris, startLine = lineCount;
    const own = primvarColor(node, time);
    const mat = materialColor(boundMaterial(node, stage.root), stage.root, time);
    const color = own || (mat && mat.color) || inherited;
    if (node.typeName === 'Mesh') {
      const P = valueOf(node.props.get('points'), time);
      const C = valueOf(node.props.get('faceVertexCounts'), time);
      const X = valueOf(node.props.get('faceVertexIndices'), time);
      if (P instanceof Tuples && P.length && C && X) {
        let faceColors = null;
        for (const sub of node.children.values()) {
          if (sub.typeName !== 'GeomSubset') continue;
          const m = materialColor(boundMaterial(sub, stage.root), stage.root, time);
          const ids = valueOf(sub.props.get('indices'), time);
          const sc = primvarColor(sub, time) || (m && m.color);
          if (!sc || !ids) continue;
          if (!faceColors) faceColors = new Array(C.length);
          for (const f of ids) if (f >= 0 && f < C.length) faceColors[f] = sc;
        }
        const pts = P.data instanceof Float32Array ? P.data : Float32Array.from(P.data);
        emitMesh(node, world, { points: pts, counts: C, indices: X }, color || [0.72, 0.72, 0.74], faceColors);
      } else skip('meshes without points or faces');
    } else if (SHAPES.has(node.typeName)) {
      const m = shapeMesh(node, time);
      if (m) emitMesh(node, world, m, color || [0.72, 0.72, 0.74], null);
    } else if (node.typeName === 'PointInstancer') {
      instances(node, world, color);
      if (tris > startTri || lineCount > startLine) ranges[node.path] = [startTri, tris - startTri, startLine, lineCount - startLine];
      return null; // prototypes are drawn only through the instancer
    } else if (['BasisCurves', 'NurbsCurves', 'Points', 'NurbsPatch', 'HermiteCurves', 'TetMesh'].includes(node.typeName)) skip(`${node.typeName} prims (not drawn)`);
    for (const c of node.children.values()) if (c.typeName !== 'GeomSubset') visit(c, world, color);
    if (tris > startTri || lineCount > startLine) ranges[node.path] = [startTri, tris - startTri, startLine, lineCount - startLine];
    return null;
  }
  // PointInstancer: each instance draws its prototype (scale, then orientation, then position, then the instancer).
  function instances(node, world, color) {
    const protos = node.props.get('prototypes') ? listItems(node.props.get('prototypes').targets).map((t) => nodeAt(stage.root, t.path)) : [];
    const idx = valueOf(node.props.get('protoIndices'), time);
    const P = valueOf(node.props.get('positions'), time);
    if (!protos.length || !idx || !(P instanceof Tuples)) { skip('PointInstancers without prototypes or positions'); return; }
    const O = valueOf(node.props.get('orientations'), time) || valueOf(node.props.get('orientationsf'), time);
    const S = valueOf(node.props.get('scales'), time);
    const n = Math.min(idx.length, P.length);
    const maxInst = opts.maxInstances || 100000;
    if (n > maxInst) skip(`instances beyond ${maxInst.toLocaleString('en-US')}`);
    for (let i = 0; i < Math.min(n, maxInst); i++) {
      const proto = protos[idx[i]];
      if (!proto) continue;
      let m = I4();
      if (S instanceof Tuples && i < S.length) { const sc = S.at(i); m[0] = sc[0]; m[5] = sc[1]; m[10] = sc[2]; }
      if (O instanceof Tuples && i < O.length) m = mul(m, quatMatrix(O.at(i)));
      const p = P.at(i);
      const t = I4(); t[12] = p[0]; t[13] = p[1]; t[14] = p[2];
      m = mul(mul(m, t), world);
      visit(proto, m, color, true);
      if (tris >= maxTris) break;
    }
  }
  // upAxis Z is handled by the camera; positions stay in stage space
  for (const c of stage.root.children.values()) if (c.specifier !== 'class') visit(c, I4(), null);
  return {
    positions: vpos.slice(0, vn * 3), colors: vcol.slice(0, vn * 3), triangles32: tidx.slice(0, tn), lines32: lidx.slice(0, lnn),
    parts, ranges,
    bounds: Number.isFinite(min[0]) ? [min, max] : null,
    meshes, triangles: triTotal, drawnTriangles: tris, points: pointTotal,
    skipped: [...skipped].map(([k, n]) => `${n} ${k}`), truncated,
  };
}

module.exports = { resolveAsset, splitPackage, layerArcs, loadClosure, compose, eachNode, nodeAt, valueOf, localTransform, geometry, mul, I4, quatMatrix, rotAxis, Node, listItems, Asset };
