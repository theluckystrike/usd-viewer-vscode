'use strict';
// Pro "Stage check": problems a USD file has before it goes to a renderer, a game engine or AR Quick Look.
// Works on the closure and composed stage the viewer already built; `exists(id)` tells whether an asset file is on
// disk (async). Items: { level: 'error' | 'warning' | 'info', area, where, message }.
const path = require('path');
const { resolveAsset, splitPackage, eachNode, nodeAt, listItems, valueOf } = require('./stage');
const { walk } = require('./model');
const { Asset, Tuples, Dict } = require('./types');

// Prim types of the schemas that ship with USD (UsdGeom, UsdShade, UsdLux, UsdSkel, UsdPhysics, UsdRender, UsdMedia,
// UsdVol, UsdUI, UsdProc, UsdRi, UsdHydra, UsdSemantics) and common Apple AR types.
const KNOWN = new Set(('Xform Scope Mesh GeomSubset Points BasisCurves NurbsCurves NurbsPatch HermiteCurves PointInstancer Camera Cube Sphere Cylinder Cylinder_1 Cone Capsule Capsule_1 Plane TetMesh ' +
  'Material Shader NodeGraph DistantLight DomeLight DomeLight_1 RectLight SphereLight DiskLight CylinderLight GeometryLight PortalLight PluginLight LightFilter PluginLightFilter ' +
  'SkelRoot Skeleton SkelAnimation BlendShape PhysicsScene PhysicsCollisionGroup PhysicsFilteredPairsAPI PhysicsRevoluteJoint PhysicsPrismaticJoint PhysicsSphericalJoint PhysicsDistanceJoint PhysicsFixedJoint PhysicsJoint ' +
  'RenderSettings RenderProduct RenderVar RenderPass SpatialAudio Volume OpenVDBAsset Field3DAsset GenerativeProcedural Backdrop RiMaterialAPI ' +
  'Preliminary_AnchoringAPI Preliminary_ReferenceImage Preliminary_Text Preliminary_Trigger Preliminary_Action Preliminary_Behavior Preliminary_PhysicsGravitationalForce Preliminary_InfiniteColliderPlane').split(' '));
const USDZ_TYPES = /\.(usda|usdc|usd|png|jpe?g|exr|avif|m4a|mp3|wav)$/i;

async function checkStage({ closure, stage, geom, kind, usdz, exists }) {
  const items = [];
  const add = (level, area, where, message) => items.push({ level, area, where, message });
  const rootLayer = closure.layers.get(closure.root).layer;
  const short = (id) => (splitPackage(id) ? `${path.basename(splitPackage(id).pkg)}[${splitPackage(id).entry}]` : path.basename(id));

  // layers
  const layerRows = [];
  for (const [id, e] of closure.layers) {
    if (e.alias) continue;
    layerRows.push({ layer: short(id), kind: e.kind || '', status: e.error ? e.error : 'opened' });
    if (e.error) add(/plug-in/.test(e.error) ? 'warning' : 'error', 'layers', short(id), `Not opened: ${e.error}.`);
    if (e.layer && e.layer.warnings && e.layer.warnings.length) for (const w of e.layer.warnings.slice(0, 20)) add('warning', 'layers', short(id), `Value not read: ${w}`);
  }
  // composition arcs that failed
  const arcSeen = new Set();
  const arcProblem = (n, a) => {
    const key = `${n.path}|${a.kind}|${a.asset}|${a.path}`;
    if (arcSeen.has(key)) return;
    arcSeen.add(key);
    add('error', 'composition', n.path, `${a.kind} ${a.asset ? '@' + a.asset + '@' : ''}${a.path ? '<' + a.path + '>' : ''}: ${a.error}.`);
  };
  for (const a of stage.root.arcs) if (!a.ok) arcProblem(stage.root, a);
  eachNode(stage.root, (n) => { for (const a of n.arcs) if (!a.ok) arcProblem(n, a); });
  for (const w of stage.warnings) add('warning', 'composition', '', w);

  // layer metadata
  const dp = rootLayer.meta.get('defaultPrim');
  if (!dp) add('warning', 'metadata', '(root layer)', 'No defaultPrim: other files that reference this one without a prim path find nothing, and AR viewers may show nothing.');
  else if (!nodeAt(stage.root, '/' + String(dp).replace(/^\//, ''))) add('error', 'metadata', '(root layer)', `defaultPrim "${dp}" names a prim that does not exist.`);
  if (!stage.upAxisSet) add('warning', 'metadata', '(root layer)', 'No upAxis: tools fall back to their own default (Y in most, Z in some).');
  if (!stage.metersSet) add('info', 'metadata', '(root layer)', 'No metersPerUnit: USD then assumes centimeters (0.01).');

  // prims
  const unknownTypes = new Map();
  eachNode(stage.root, (n) => {
    if (n.typeName && !KNOWN.has(n.typeName)) unknownTypes.set(n.typeName, (unknownTypes.get(n.typeName) || []).concat(n.path));
    for (const p of n.props.values()) {
      if (p.kind === 'relationship' && p.targets) {
        for (const t of listItems(p.targets)) {
          const tp = String(t.path || '');
          if (!tp.startsWith('/')) continue;
          const primPart = tp.replace(/\.[^/]*$/, '');
          if (!nodeAt(stage.root, primPart)) add(p.name.startsWith('material:binding') ? 'warning' : 'info', 'targets', `${n.path}.${p.name}`, `Targets ${tp}, which is not on the stage.`);
        }
      }
      if (p.connect) {
        for (const t of listItems(p.connect)) {
          const tp = String(t.path || '');
          const owner = tp.replace(/\.[^/]*$/, '');
          const prop = tp.slice(owner.length + 1);
          const o = nodeAt(stage.root, owner);
          if (!o) add('warning', 'connections', `${n.path}.${p.name}`, `Connects to ${tp}, whose prim is not on the stage.`);
          else if (prop && !o.props.has(prop)) add('info', 'connections', `${n.path}.${p.name}`, `Connects to ${tp}, a property that is not authored there.`);
        }
      }
    }
    if (n.typeName === 'Mesh') {
      const P = valueOf(n.props.get('points'), stage.startTime);
      const C = valueOf(n.props.get('faceVertexCounts'), stage.startTime);
      const X = valueOf(n.props.get('faceVertexIndices'), stage.startTime);
      const np = P instanceof Tuples ? P.length : 0;
      if (!np) add('warning', 'meshes', n.path, 'A Mesh with no points.');
      if (C && X) {
        let sum = 0, bad = 0;
        for (const c of C) sum += c;
        for (const i of X) if (i < 0 || i >= np) bad++;
        if (sum !== X.length) add('error', 'meshes', n.path, `faceVertexCounts add up to ${sum.toLocaleString('en-US')}, but faceVertexIndices has ${X.length.toLocaleString('en-US')} entries.`);
        if (bad && np) add('error', 'meshes', n.path, `${bad.toLocaleString('en-US')} face vertex indices point past the ${np.toLocaleString('en-US')} points.`);
        let degenerate = 0;
        for (const c of C) if (c < 3) degenerate++;
        if (degenerate) add('warning', 'meshes', n.path, `${degenerate.toLocaleString('en-US')} faces have fewer than 3 vertices.`);
      } else if (np) add('error', 'meshes', n.path, 'A Mesh with points but no faceVertexCounts or faceVertexIndices.');
      const ext = valueOf(n.props.get('extent'), stage.startTime);
      if (!ext) add('info', 'meshes', n.path, 'No extent: renderers compute bounds at load time.');
    }
    return true;
  });
  for (const [t, ps] of unknownTypes) add('info', 'schemas', ps[0], `Prim type "${t}" (${ps.length} prim${ps.length > 1 ? 's' : ''}) is not one of the schemas that ship with USD; it needs its plug-in to mean anything.`);

  // asset paths (textures and other files) in every opened layer
  const assets = [];
  const seenAsset = new Set();
  for (const [id, e] of closure.layers) {
    if (!e.layer) continue;
    const visit = (prim) => {
      for (const p of prim.props) {
        const vals = [];
        const collect = (v) => { if (v instanceof Asset) vals.push(v.asset); else if (Array.isArray(v)) for (const x of v) if (x instanceof Asset) vals.push(x.asset); };
        collect(p.value);
        if (p.timeSamples) for (const [, v] of p.timeSamples) collect(v);
        for (const a of vals) {
          if (!a) continue;
          const key = `${id}|${a}`;
          if (seenAsset.has(key)) continue;
          seenAsset.add(key);
          assets.push({ layerId: id, layer: short(id), prim: prim.path, prop: p.name, asset: a });
        }
      }
    };
    walk(e.layer.root, (pr) => { visit(pr); return true; }, true);
  }
  const textures = [];
  for (const a of assets) {
    const probe = a.asset.replace(/<UDIM>/gi, '1001');
    const r = resolveAsset(probe, a.layerId, closure.hasEntry);
    let found = false, note = '';
    if (r.error) note = r.error;
    else if (r.kind === 'package') { const sp = splitPackage(r.id); found = !!(closure.packages.get(sp.pkg) && closure.packages.get(sp.pkg).has(sp.entry)); if (!found) note = 'not in the package'; } else { try { found = await exists(r.id); } catch (e) { found = false; } if (!found) note = 'file not found'; }
    textures.push({ asset: a.asset, layer: a.layer, prim: a.prim, prop: a.prop, found, note });
    if (!found) add(r.error ? 'warning' : 'error', 'assets', `${a.prim}.${a.prop}`, `@${a.asset}@ (in ${a.layer}): ${note}.`);
  }

  // USDZ packaging
  if (kind === 'usdz' && usdz) {
    if (!usdz.firstIsLayer) add('error', 'usdz', usdz.entries[0] ? usdz.entries[0].name : '(empty)', 'The first file in a USDZ package must be the root layer (.usda, .usdc or .usd).');
    for (const e of usdz.entries) {
      if (e.method !== 0) add('error', 'usdz', e.name, 'Compressed in the zip; USDZ files must be stored without compression.');
      if (!e.aligned) add('warning', 'usdz', e.name, 'Its data does not start on a 64-byte boundary; some readers map USDZ files and need the alignment.');
      if (!USDZ_TYPES.test(e.name)) add('warning', 'usdz', e.name, 'File type outside the USDZ list (usda, usdc, usd, png, jpeg, exr, avif, m4a, mp3, wav).');
    }
  }

  const count = (l) => items.filter((i) => i.level === l).length;
  return {
    kind: 'check',
    summary: { errors: count('error'), warnings: count('warning'), infos: count('info'), layers: layerRows.length, assets: textures.length, missingAssets: textures.filter((t) => !t.found).length, meshes: geom ? geom.meshes : 0, triangles: geom ? geom.triangles : 0 },
    items, layers: layerRows, textures,
  };
}

function checkMarkdown(r, title) {
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const s = r.summary;
  const lines = [`# Stage check: ${title}`, '', `${s.errors} errors, ${s.warnings} warnings, ${s.infos} notes. ${s.layers} layers, ${s.assets} asset paths (${s.missingAssets} missing), ${s.meshes} meshes, ${s.triangles.toLocaleString('en-US')} triangles.`, ''];
  lines.push('## Problems', '', '| Level | Area | Where | What |', '|---|---|---|---|');
  for (const i of r.items) lines.push(`| ${i.level} | ${i.area} | ${esc(i.where)} | ${esc(i.message)} |`);
  if (!r.items.length) lines.push('| - | - | - | Nothing found. |');
  lines.push('', '## Layers', '', '| Layer | Format | Status |', '|---|---|---|');
  for (const l of r.layers) lines.push(`| ${esc(l.layer)} | ${l.kind} | ${esc(l.status)} |`);
  lines.push('', '## Asset paths', '', '| Asset | Used by | Layer | Found |', '|---|---|---|---|');
  for (const t of r.textures) lines.push(`| ${esc(t.asset)} | ${esc(t.prim + '.' + t.prop)} | ${esc(t.layer)} | ${t.found ? 'yes' : 'no: ' + esc(t.note)} |`);
  return lines.join('\n') + '\n';
}

module.exports = { checkStage, checkMarkdown, KNOWN, Dict };
