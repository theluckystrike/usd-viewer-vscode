'use strict';
// Pro converter outputs built from a composed stage: one flat USDA layer (references, payloads, sublayers and the
// selected variants merged in), and the drawn meshes as OBJ (+ MTL) or glTF binary (GLB). OBJ and GLB are Y up;
// a Z-up stage is turned (x, y, z) -> (x, z, -y). GLB is in meters (metersPerUnit applied), OBJ keeps stage units.
const { Layer, Prim } = require('./model');
const { ListOp } = require('./types');

const ARC_KEYS = new Set(['references', 'payload', 'inherits', 'specializes', 'variantSets', 'variants']);

function flatten(stage, rootLayer) {
  const layer = new Layer('usda', '1.0');
  for (const [k, v] of rootLayer.meta) if (k !== 'subLayers') layer.meta.set(k, v);
  const toPrim = (n) => {
    const p = new Prim(n.name, n.path);
    p.specifier = n.specifier || 'def';
    p.typeName = n.typeName;
    for (const [k, v] of n.meta) if (!ARC_KEYS.has(k)) p.meta.set(k, v instanceof ListOp && k === 'apiSchemas' ? new ListOp(true, { explicit: v.all() }) : v);
    p.props = [...n.props.values()].map((x) => { const c = Object.assign(Object.create(Object.getPrototypeOf(x)), x); delete c.layer; return c; });
    for (const c of n.children.values()) p.children.push(toPrim(c));
    return p;
  };
  for (const c of stage.root.children.values()) layer.root.children.push(toPrim(c));
  return layer;
}

function yUp(x, y, z, up) { return up === 'Z' ? [x, z, -y] : [x, y, z]; }

/** OBJ text and MTL text for the geometry. */
function toObj(geom, opts = {}) {
  const up = opts.upAxis || 'Y';
  const name = opts.name || 'model';
  const P = geom.positions, C = geom.colors, T = geom.triangles32;
  const lines = [`# OBJ written by USD Viewer by Zovo from ${name}`, `# ${geom.parts.length} meshes, ${(T.length / 3).toLocaleString('en-US')} triangles, Y up${up === 'Z' ? ' (turned from Z up)' : ''}, stage units`, `mtllib ${opts.mtlName || 'model.mtl'}`];
  const fmt = (x) => (Math.round(x * 1e6) / 1e6).toString();
  for (let i = 0; i < P.length; i += 3) { const v = yUp(P[i], P[i + 1], P[i + 2], up); lines.push(`v ${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`); }
  const mtl = [`# MTL written by USD Viewer by Zovo`];
  const mats = new Map();
  for (const part of geom.parts) {
    const [start, count] = part.tri;
    if (!count) continue;
    const v0 = T[start * 3];
    const rgb = [C[v0 * 3], C[v0 * 3 + 1], C[v0 * 3 + 2]];
    const key = rgb.join('_');
    if (!mats.has(key)) { const m = `color_${key}`; mats.set(key, m); mtl.push('', `newmtl ${m}`, `Kd ${(rgb[0] / 255).toFixed(4)} ${(rgb[1] / 255).toFixed(4)} ${(rgb[2] / 255).toFixed(4)}`, 'Ka 0 0 0', 'd 1'); }
    lines.push(`g ${part.path.replace(/\s/g, '_')}`, `usemtl ${mats.get(key)}`);
    for (let t = start; t < start + count; t++) lines.push(`f ${T[t * 3] + 1} ${T[t * 3 + 1] + 1} ${T[t * 3 + 2] + 1}`);
  }
  return { obj: lines.join('\n') + '\n', mtl: mtl.join('\n') + '\n' };
}

/** glTF 2.0 binary: one shared vertex buffer (position, color), one mesh and node per drawn USD prim. */
function toGlb(geom, opts = {}) {
  const up = opts.upAxis || 'Y';
  const s = Number(opts.metersPerUnit) > 0 ? Number(opts.metersPerUnit) : 1;
  const P = geom.positions, C = geom.colors, T = geom.triangles32;
  const nv = P.length / 3;
  const pos = new Float32Array(P.length);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) {
    const v = yUp(P[i * 3] * s, P[i * 3 + 1] * s, P[i * 3 + 2] * s, up);
    for (let k = 0; k < 3; k++) { pos[i * 3 + k] = v[k]; if (v[k] < min[k]) min[k] = v[k]; if (v[k] > max[k]) max[k] = v[k]; }
  }
  const col = new Uint8Array(nv * 4);
  for (let i = 0; i < nv; i++) { col[i * 4] = C[i * 3]; col[i * 4 + 1] = C[i * 3 + 1]; col[i * 4 + 2] = C[i * 3 + 2]; col[i * 4 + 3] = 255; }
  const idx = new Uint32Array(T);
  const bin = new Uint8Array(pos.byteLength + col.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(col, pos.byteLength);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength + col.byteLength);
  const gltf = {
    asset: { version: '2.0', generator: 'USD Viewer by Zovo' },
    scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [],
    materials: [{ name: 'vertex color', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: true }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: col.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength + col.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: nv, type: 'VEC3', min: nv ? min : [0, 0, 0], max: nv ? max : [0, 0, 0] },
      { bufferView: 1, componentType: 5121, normalized: true, count: nv, type: 'VEC4' },
    ],
  };
  for (const part of geom.parts) {
    const [start, count] = part.tri;
    if (!count) continue;
    const a = gltf.accessors.length;
    gltf.accessors.push({ bufferView: 2, byteOffset: start * 12, componentType: 5125, count: count * 3, type: 'SCALAR' });
    const m = gltf.meshes.length;
    gltf.meshes.push({ name: part.path, primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, indices: a, material: 0, mode: 4 }] });
    gltf.scenes[0].nodes.push(gltf.nodes.length);
    gltf.nodes.push({ name: part.path, mesh: m });
  }
  let json = new TextEncoder().encode(JSON.stringify(gltf));
  const jpad = (4 - (json.length % 4)) % 4;
  const jsonChunk = new Uint8Array(json.length + jpad).fill(0x20);
  jsonChunk.set(json);
  const bpad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length + bpad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonChunk.length, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonChunk, 20);
  const b0 = 20 + jsonChunk.length;
  dv.setUint32(b0, bin.length + bpad, true); dv.setUint32(b0 + 4, 0x004e4942, true);
  out.set(bin, b0 + 8);
  json = null;
  return out;
}

module.exports = { flatten, toObj, toGlb };
