'use strict';
// The layer model shared by the USDA parser and the USDC reader: a pseudo-root prim with child prims, each with
// properties (attributes and relationships), metadata and variant sets. Field names follow the USDA keywords
// (variants, variantSets, doc), so the text writer prints them as they are.

class Prop {
  constructor(name, kind) {
    this.name = name;
    this.kind = kind; // 'attribute' | 'relationship'
    this.typeName = '';
    this.variability = ''; // '' (varying) | 'uniform' | 'config'
    this.custom = false;
    this.value = undefined; // default value
    this.timeSamples = null; // [[time, value]]
    this.connect = null; // ListOp of SdfPath (attribute connections)
    this.targets = null; // ListOp of SdfPath (relationship targets)
    this.meta = new Map();
  }
}

class Prim {
  constructor(name, path) {
    this.name = name;
    this.path = path;
    this.specifier = 'def';
    this.typeName = '';
    this.meta = new Map();
    this.props = [];
    this.children = [];
    this.variantSets = []; // [{ name, variants: [{ name, prim }] }]
    this.nameOrder = null; // reorder nameChildren
    this.propOrder = null; // reorder properties
  }
  prop(name) { return this.props.find((p) => p.name === name) || null; }
  child(name) { return this.children.find((c) => c.name === name) || null; }
}

class Layer {
  constructor(format, version) {
    this.format = format; // 'usda' | 'usdc'
    this.version = version || '';
    this.meta = new Map();
    this.root = new Prim('', '/');
    this.root.specifier = '';
    this.warnings = [];
  }
  /** Prim at an absolute path in this layer (no composition), or null. */
  primAt(path) {
    if (!path || path === '/') return this.root;
    let cur = this.root;
    for (const part of String(path).split('/').filter(Boolean)) { cur = cur.child(part); if (!cur) return null; }
    return cur;
  }
  /** defaultPrim, or the first root prim when none is set. */
  defaultPrim() {
    const d = this.meta.get('defaultPrim');
    if (typeof d === 'string' && d) return this.primAt('/' + d.replace(/^\//, ''));
    return this.root.children.find((c) => c.specifier === 'def') || this.root.children[0] || null;
  }
}

function childPath(parent, name) { return parent === '/' ? '/' + name : parent + '/' + name; }

/** Calls fn(prim, depth) for every prim under root (depth first, in file order), variants included when asked. */
function walk(root, fn, withVariants = false, depth = 0) {
  for (const c of root.children) {
    if (fn(c, depth) === false) continue;
    walk(c, fn, withVariants, depth + 1);
    if (withVariants) for (const vs of c.variantSets) for (const v of vs.variants) { if (fn(v.prim, depth + 1) !== false) walk(v.prim, fn, true, depth + 1); }
  }
}

/** Counts for the toolbar and the checker. */
function layerStats(layer) {
  const s = { prims: 0, meshes: 0, attributes: 0, relationships: 0, types: new Map() };
  walk(layer.root, (p) => {
    if (p.path.endsWith('}')) return; // a variant, not a prim
    s.prims++;
    if (p.typeName === 'Mesh') s.meshes++;
    if (p.typeName) s.types.set(p.typeName, (s.types.get(p.typeName) || 0) + 1);
    for (const pr of p.props) if (pr.kind === 'attribute') s.attributes++; else s.relationships++;
  }, true);
  return s;
}

module.exports = { Prop, Prim, Layer, childPath, walk, layerStats };
