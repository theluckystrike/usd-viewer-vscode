'use strict';
// What the webview shows, built from a composed stage: the prim tree rows, the details of one prim and the summary
// line. Pure functions (no vscode), so the tests call them directly.
const path = require('path');
const { eachNode, nodeAt, listItems } = require('./stage');
const { typed, generic } = require('./usda-write');
const { Tuples, ListOp, Dict, Block, Ref, valueLength, typeInfo } = require('./types');

const MAX_ROWS = 60000;

/** Tree rows in depth-first order: [name, type, depth, flags]. flags: g geometry below, r reference or payload,
 *  v variant sets, i inactive, c class, o over only, p instance prototype. */
function treeRows(stage, ranges) {
  const rows = [];
  let truncated = false;
  eachNode(stage.root, (n, depth) => {
    if (rows.length >= MAX_ROWS) { truncated = true; return false; }
    let f = '';
    if (ranges && ranges[n.path]) f += 'g';
    if (n.arcs.some((a) => a.kind === 'reference' || a.kind === 'payload')) f += 'r';
    if (n.arcs.some((a) => !a.ok)) f += 'x';
    if (n.variantSets.length) f += 'v';
    if (n.meta.get('active') === false) f += 'i';
    if (n.specifier === 'class') f += 'c';
    if (n.specifier === 'over') f += 'o';
    rows.push([n.name, n.typeName || '', depth, f]);
    return true;
  });
  return { rows, truncated };
}

function shortValue(p) {
  const v = p.value;
  if (v === undefined) return '';
  if (v instanceof Block) return 'None';
  try {
    if (p.kind === 'attribute' && p.typeName) return typed(v, p.typeName, { maxArray: 6 }).replace(/\s*#.*\n\s*/, ' ...');
    return generic(v);
  } catch (e) { return String(v); }
}

function metaText(v) {
  if (v instanceof ListOp) {
    const parts = [];
    if (v.explicit) parts.push(listText(v.items.explicit || []));
    for (const [k, w] of [['prepend', 'prepend'], ['add', 'add'], ['append', 'append'], ['delete', 'delete'], ['order', 'reorder']]) if (v.items[k] && v.items[k].length) parts.push(`${w} ${listText(v.items[k])}`);
    return parts.join('; ');
  }
  let s;
  try { s = generic(v); } catch (e) { s = String(v); }
  return s.replace(/\s+/g, ' ').slice(0, 400);
}
function listText(items) { return items.map((x) => (x instanceof Ref ? generic(x) : generic(x))).join(', '); }

const shortId = (id) => path.basename(String(id).replace(/\]$/, '').replace(/\[/, '/'));

/** Everything the details panel shows for one prim. */
function primInfo(stage, primPath, ranges) {
  const n = nodeAt(stage.root, primPath);
  if (!n) return null;
  const props = [...n.props.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
    const ti = typeInfo(p.typeName);
    const o = { name: p.name, kind: p.kind === 'relationship' ? 'rel' : 'attr', type: p.kind === 'relationship' ? 'rel' : (p.variability === 'uniform' ? 'uniform ' : '') + (p.typeName || ''), value: shortValue(p) };
    if (ti.array && p.value !== undefined && !(p.value instanceof Block)) o.count = valueLength(p.value);
    if (p.timeSamples && p.timeSamples.length) o.samples = p.timeSamples.length;
    if (p.connect) o.connect = listItems(p.connect).map((x) => x.path).join(', ');
    if (p.targets) o.targets = listItems(p.targets).map((x) => x.path).join(', ');
    const meta = [];
    for (const [k, v] of p.meta) meta.push(`${k} = ${metaText(v)}`);
    if (meta.length) o.meta = meta.join('; ');
    return o;
  });
  const meta = [];
  for (const [k, v] of n.meta) if (!['variants', 'variantSets', 'references', 'payload', 'inherits', 'specializes'].includes(k)) meta.push([k, metaText(v)]);
  const r = ranges && ranges[n.path];
  let children = 0, desc = 0;
  for (const c of n.children.values()) { children++; void c; }
  eachNode(n, () => { desc++; });
  return {
    path: n.path, name: n.name, type: n.typeName, specifier: n.specifier,
    meta, props,
    arcs: n.arcs.map((a) => ({ kind: a.kind, target: `${a.asset ? '@' + a.asset + '@' : ''}${a.path ? '<' + a.path + '>' : ''}`, ok: a.ok, error: a.error })),
    variantSets: n.variantSets.map((v) => ({ name: v.name, selection: v.selection, choices: v.choices })),
    layers: n.sources.map(shortId),
    triangles: r ? r[1] : 0, children, descendants: desc,
  };
}

/** One line for the toolbar and the counts the checker reports. */
function summary(stage, geom, closure) {
  let prims = 0;
  const types = new Map();
  eachNode(stage.root, (n) => { prims++; if (n.typeName) types.set(n.typeName, (types.get(n.typeName) || 0) + 1); });
  const layers = [...closure.layers].filter(([, e]) => !e.alias);
  return {
    prims, types: [...types].sort((a, b) => b[1] - a[1]),
    meshes: geom ? geom.meshes : 0, triangles: geom ? geom.triangles : 0, points: geom ? geom.points : 0,
    layers: layers.length, missing: layers.filter(([, e]) => e.error).map(([id, e]) => ({ id: shortId(id), error: e.error })),
  };
}

module.exports = { treeRows, primInfo, summary, metaText, shortValue, shortId, MAX_ROWS, Tuples, Dict };
