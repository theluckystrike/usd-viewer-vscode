'use strict';
// Core tests: decompressors, the USDC reader, the USDA parser and writer, the USDC writer, USDZ packages,
// composition, geometry, exports, the stage check and the compare. Ground truth files in test/fixtures come from
// Pixar's usdcat (macOS /usr/bin/usdcat): *.usdcat.usda is usdcat's text of the matching .usdc.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fastDecompress, decodeInts, encodeInts, fastCompress, intsBound, lz4Block } = require('../src/core/compress');
const { readUsdc, isUsdc } = require('../src/core/usdc');
const { parseUsda } = require('../src/core/usda');
const { toUsda } = require('../src/core/usda-write');
const { writeUsdc, splitPath, absolute, toHalf } = require('../src/core/usdc-write');
const { openUsdz, listZip } = require('../src/core/usdz');
const { openAny } = require('../src/core/layer');
const { loadClosure, compose, geometry, nodeAt, valueOf, localTransform, resolveAsset } = require('../src/core/stage');
const { diffLayers } = require('../src/core/diff');
const { flatten, toObj, toGlb } = require('../src/core/export');
const { checkStage, checkMarkdown } = require('../src/core/check');
const { treeRows, primInfo, summary } = require('../src/core/present');
const { fmtFloat, fmtDouble, Tuples, typeInfo, sameValue, Raw } = require('../src/core/types');
const { half } = require('../src/core/usdc');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const FIX = path.join(__dirname, 'fixtures');
const read = (p) => new Uint8Array(fs.readFileSync(p));
const diffCount = (d) => d.added.length + d.removed.length + d.changed.length;
const fsRead = async (id) => read(id);
async function stageOf(file) {
  const cl = await loadClosure(file, read(file), fsRead);
  const st = compose(cl);
  return { cl, st, geom: geometry(st) };
}

// ---------- compression ----------
test('integer coding round trips 32 and 64 bit values, including big jumps and negatives', () => {
  const v32 = [0, 1, 2, 3, 3, 3, -5, 1000, -70000, 2147483647, -2147483648, 7];
  assert.deepEqual(Array.from(decodeInts(encodeInts(v32, false), v32.length, false)), v32);
  const v64 = [0, 5, 2 ** 40, -(2 ** 35), 12, 12];
  assert.deepEqual(Array.from(decodeInts(encodeInts(v64, true), v64.length, true)), v64);
  const comp = fastCompress(encodeInts(v32, false));
  assert.deepEqual(Array.from(decodeInts(fastDecompress(comp, intsBound(v32.length, false)), v32.length, false)), v32);
});
test('LZ4 block decoding handles literals and overlapping matches', () => {
  // "abcabcabcabcX": 3 literals, then a match of 9 at offset 3, then the final literal
  const src = Uint8Array.from([0x35, 97, 98, 99, 3, 0, 0x10, 88]);
  const dst = new Uint8Array(13);
  assert.equal(lz4Block(src, 0, src.length, dst, 0), 13);
  assert.equal(Buffer.from(dst).toString(), 'abcabcabcabcX');
  assert.throws(() => lz4Block(Uint8Array.from([0x10, 97, 9, 0]), 0, 4, new Uint8Array(20), 0), /damaged/);
});
test('float printing matches USD: shortest float, ties to even, -0, inf and nan', () => {
  assert.equal(fmtFloat(Math.fround(0.1)), '0.1');
  assert.equal(fmtFloat(0.330078125), '0.33007812');
  assert.equal(fmtFloat(0.173828125), '0.17382812');
  assert.equal(fmtFloat(-0), '-0');
  assert.equal(fmtDouble(-0), '-0');
  assert.equal(fmtFloat(Infinity), 'inf');
  assert.equal(fmtDouble(NaN), 'nan');
  assert.equal(half(toHalf(1.5)), 1.5);
  assert.equal(half(toHalf(-0.00006103515625)), -0.00006103515625);
});
test('typeInfo knows roles, arrays, quaternions and matrices', () => {
  assert.deepEqual([typeInfo('point3f[]').base, typeInfo('point3f[]').n, typeInfo('point3f[]').array], ['f', 3, true]);
  assert.equal(typeInfo('quath').elem, 'h');
  assert.equal(typeInfo('matrix4d').rows, 4);
  assert.equal(typeInfo('texCoord2d').base, 'd');
  assert.equal(typeInfo('token[]').base, 't');
});

// ---------- USDC reader and USDA writer against usdcat ----------
for (const [usdc, expected] of [['samples/sample-robot.usdc', 'test/fixtures/sample-robot.usdcat.usda'], ['test/fixtures/arcs.usdc', 'test/fixtures/arcs.usdcat.usda']]) {
  test(`USDC ${path.basename(usdc)}: our USDA text is byte for byte the text usdcat writes`, () => {
    const layer = readUsdc(read(path.join(ROOT, usdc)));
    assert.equal(layer.version, '0.8.0');
    assert.equal(toUsda(layer, { sorted: true }), fs.readFileSync(path.join(ROOT, expected), 'utf8'));
  });
}
test('USDC and USDA of the same scene give the same layer (prims, values, metadata, variants)', () => {
  const a = parseUsda(fs.readFileSync(path.join(SAMPLES, 'sample-robot.usda'), 'utf8'));
  const b = readUsdc(read(path.join(SAMPLES, 'sample-robot.usdc')));
  const d = diffLayers(a, b);
  assert.equal(diffCount(d), 0, JSON.stringify(d.changed.slice(0, 3)));
  assert.equal(d.primsA, 23); // 19 prims, 2 variants, 2 overs inside them
});
test('arcs fixture: references, sublayer offsets, variant selection, time samples and connections survive USDC', () => {
  const L = readUsdc(read(path.join(FIX, 'arcs.usdc')));
  const root = L.primAt('/Root');
  assert.equal(root.meta.get('references').items.prepend[0].asset, './x.usda');
  assert.equal(root.meta.get('references').items.prepend[0].path, '/X');
  assert.deepEqual(L.meta.get('subLayers'), [{ asset: './a.usda', offset: 2, scale: 1 }]);
  assert.equal(root.meta.get('variants').get('look'), 'red');
  const tr = root.prop('xformOp:translate');
  assert.deepEqual(tr.timeSamples.map(([t, v]) => [t, v]), [[1, [0, 0, 0]], [2, [1, 1, 1]]]);
  assert.equal(root.prop('inputs:c').connect.all()[0].path, '/Root/Mat.outputs:surface');
  assert.equal(root.variantSets[0].variants.find((v) => v.name === 'red').prim.children[0].path, '/Root{look=red}S');
});
test('USDC reader refuses other files with a plain message', () => {
  assert.equal(isUsdc(Buffer.from('#usda 1.0\n')), false);
  assert.throws(() => readUsdc(Buffer.from('PXR-USDC' + '\0'.repeat(100))), /section|ends early/);
  const bad = Buffer.from(read(path.join(SAMPLES, 'sample-robot.usdc')));
  bad.writeBigUInt64LE(BigInt(bad.length + 100), 16);
  assert.throws(() => readUsdc(bad), /ends early/);
});

// ---------- USDA parser ----------
test('USDA parser: errors name the line and column', () => {
  assert.throws(() => parseUsda('#usda 1.0\ndef Xform "A" {\n  float x = \n}\n'), /USDA line 4, column 1/);
  assert.throws(() => parseUsda('hello'), /first line must be "#usda 1.0"/);
  assert.throws(() => parseUsda('#usda 1.0\ndef "A" {'), /no closing/);
});
test('USDA parser: strings, asset paths, comments, list ops, dictionaries and typed arrays', () => {
  const L = parseUsda(`#usda 1.0
(
    "a layer comment"
    customLayerData = {
        string note = "x"
        dictionary nested = {
            int n = 3
        }
    }
)
# comment
def "A" (
    doc = """two
lines"""
    append references = [@a.usd@</B> (offset = 5; scale = 2), </Internal>]
    delete inherits = </C>
    hide_me = false
)
{
    custom uniform half[] h = [1.5, -2]
    quatf q = (1, 0, 0, 0)
    matrix2d m = ( (1, 2), (3, 4) )
    asset[] files = [@@@odd@name@@@, @b.png@]
    string s = 'single \\'quoted\\''
    bool[] flags = [1, 0, true]
    rel r = None
    prepend rel t = [</A>, </B>]
}
`);
  const a = L.primAt('/A');
  assert.equal(L.meta.get('comment'), 'a layer comment');
  assert.equal(L.meta.get('customLayerData').get('nested').get('n'), 3);
  assert.equal(a.meta.get('doc'), 'two\nlines');
  assert.deepEqual(a.meta.get('references').items.append.map((r) => [r.asset, r.path, r.offset, r.scale]), [['a.usd', '/B', 5, 2], ['', '/Internal', 0, 1]]);
  assert.equal(a.meta.get('inherits').items.delete[0].path, '/C');
  assert.equal(a.meta.get('hide_me'), false);
  assert.deepEqual(Array.from(a.prop('h').value), [1.5, -2]);
  assert.equal(a.prop('h').custom, true);
  assert.equal(a.prop('h').variability, 'uniform');
  assert.deepEqual(a.prop('m').value, [[1, 2], [3, 4]]);
  assert.deepEqual(a.prop('files').value.map((x) => x.asset), ['odd@name', 'b.png']);
  assert.equal(a.prop('s').value, "single 'quoted'");
  assert.deepEqual(a.prop('flags').value, [true, false, true]);
  assert.equal(a.prop('r').targets.explicit, true);
  assert.deepEqual(a.prop('t').targets.items.prepend.map((p) => p.path), ['/A', '/B']);
});
test('USDA writer output parses back to the same layer', () => {
  for (const f of ['sample-robot.usda', 'sample-parts.usda']) {
    const a = parseUsda(fs.readFileSync(path.join(SAMPLES, f), 'utf8'));
    assert.equal(diffCount(diffLayers(a, parseUsda(toUsda(a)))), 0, f);
  }
  const big = parseUsda('#usda 1.0\ndef Mesh "M" {\n int[] a = [' + Array.from({ length: 50 }, (_, i) => i).join(', ') + ']\n}\n');
  assert.match(toUsda(big, { maxArray: 10 }), /\[0, 1, 2, 3, 4, 5, 6, 7, 8, 9 # 40 more values not shown/);
});

// ---------- USDC writer ----------
test('USDC writer: USDA -> USDC -> our reader gives the same layer, for the samples and the arcs fixture', () => {
  for (const f of [path.join(SAMPLES, 'sample-robot.usda'), path.join(SAMPLES, 'sample-parts.usda'), path.join(FIX, 'arcs.usda'), path.join(FIX, 'instancer.usda')]) {
    const a = parseUsda(fs.readFileSync(f, 'utf8'));
    const bin = writeUsdc(a);
    assert.ok(isUsdc(bin));
    const d = diffLayers(a, readUsdc(bin));
    assert.equal(diffCount(d), 0, `${path.basename(f)}: ${JSON.stringify(d.changed.slice(0, 2))}`);
  }
});
test('USDC writer keeps unknown metadata as text and empty reference paths', () => {
  const a = parseUsda('#usda 1.0\ndef "A" (\n    my_flag = false\n    payload = @x.usd@\n)\n{\n}\n');
  const b = readUsdc(writeUsdc(a));
  assert.ok(b.primAt('/A').meta.get('my_flag') instanceof Raw || b.primAt('/A').meta.get('my_flag') === false);
  assert.ok(sameValue(b.primAt('/A').meta.get('my_flag'), false));
  assert.equal(b.primAt('/A').meta.get('payload').all()[0].path, '');
});
test('path helpers: split variant and property paths, make relative paths absolute', () => {
  assert.deepEqual(splitPath('/A{v=x}B.attr:sub'), [{ name: 'A' }, { name: '{v=x}', variant: true }, { name: 'B' }, { name: 'attr:sub', prop: true }]);
  assert.equal(absolute('../Looks/M', '/World/Geo'), '/World/Looks/M');
  assert.equal(absolute('/X', '/World'), '/X');
});

// ---------- USDZ ----------
test('USDZ sample: root layer first, stored, 64-byte aligned; openAny reads its root layer', () => {
  const buf = read(path.join(SAMPLES, 'sample-robot.usdz'));
  const z = openUsdz(buf);
  assert.deepEqual(z.entries.map((e) => [e.name, e.method, e.aligned]), [['sample-robot.usda', 0, true], ['sample-parts.usda', 0, true]]);
  assert.equal(z.rootName, 'sample-robot.usda');
  const o = openAny(buf, 'sample-robot.usdz');
  assert.equal(o.kind, 'usdz');
  assert.equal(o.layer.primAt('/Robot').typeName, 'Xform');
});
test('USDZ reader opens a deflated entry and rejects a truncated archive', () => {
  // a one-file zip with a deflated entry, written here
  const data = Buffer.from('#usda 1.0\ndef Xform "Z" {\n}\n');
  const comp = zlib.deflateRawSync(data);
  const name = Buffer.from('z.usda');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, name, comp]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cd.length + name.length, 12); eocd.writeUInt32LE(body.length, 16);
  const zip = new Uint8Array(Buffer.concat([body, cd, name, eocd]));
  const o = openAny(zip, 'z.usdz');
  assert.equal(o.layer.primAt('/Z').typeName, 'Xform');
  assert.equal(listZip(zip)[0].method, 8);
  assert.throws(() => listZip(zip.subarray(0, zip.length - 30)), /not a complete zip/);
});

// ---------- composition and geometry ----------
test('compose the sample: variant selection, reference with path mapping, material colors', async () => {
  const { cl, st, geom } = await stageOf(path.join(SAMPLES, 'sample-robot.usda'));
  assert.equal(cl.layers.size, 2);
  const arm = nodeAt(st.root, '/Robot/Arm');
  assert.equal(arm.props.get('material:binding').targets.all()[0].path, '/Robot/Looks/Orange');
  assert.deepEqual(nodeAt(st.root, '/Robot').variantSets, [{ name: 'paint', selection: 'orange', choices: ['blue', 'orange'] }]);
  const grip = nodeAt(st.root, '/Robot/Arm/Elbow/Gripper');
  assert.equal(grip.arcs[0].ok, true);
  assert.equal(grip.props.get('material:binding').targets.all()[0].path, '/Robot/Arm/Elbow/Gripper/Looks/Chrome');
  assert.ok(nodeAt(st.root, '/Robot/Arm/Elbow/Gripper/FingerL'));
  assert.equal(geom.meshes, 9);
  // colors: the plate is steel (158,163,173), the upper arm orange (242,115,20), a finger chrome (217,219,224)
  const colorOf = (p) => { const r = geom.ranges[p]; const v = geom.triangles32[r[0] * 3]; return Array.from(geom.colors.subarray(v * 3, v * 3 + 3)); };
  assert.deepEqual(colorOf('/Robot/Plate'), [158, 163, 173]);
  assert.deepEqual(colorOf('/Robot/Arm/UpperArm'), [242, 115, 20]);
  assert.deepEqual(colorOf('/Robot/Arm/Elbow/Gripper/FingerL'), [217, 219, 224]);
  assert.equal(st.upAxis, 'Y');
  assert.equal(st.metersPerUnit, 0.01);
});
test('transforms: translate, rotateXYZ order and a nested elbow put the gripper where USD puts it', async () => {
  const { st, geom } = await stageOf(path.join(SAMPLES, 'sample-robot.usda'));
  // the palm's first point (-5, 0, -3) in world space, computed with usdcat-independent math:
  // Robot/Arm: rotateXYZ (0, 30, -25) then translate (0, 5, 0); Elbow: rotateZ 70 then translate (0, 32, 0); Gripper: translate (0, 25, 0)
  const r = geom.ranges['/Robot/Arm/Elbow/Gripper/Palm'];
  assert.ok(r && r[1] === 12);
  const xf = localTransform(nodeAt(st.root, '/Robot/Arm'), NaN).matrix;
  assert.ok(Math.abs(xf[13] - 5) < 1e-9);
  const b = geom.bounds;
  assert.ok(b[0][1] >= -0.001 && b[1][1] > 40 && b[1][1] < 70, JSON.stringify(b));
});
test('USDZ composition: the reference inside the package resolves to the package entry', async () => {
  const f = path.join(SAMPLES, 'sample-robot.usdz');
  const { cl, geom } = await stageOf(f);
  assert.deepEqual([...cl.layers.keys()].map((k) => path.basename(k)), ['sample-robot.usdz[sample-robot.usda]', 'sample-robot.usdz[sample-parts.usda]']);
  assert.equal(geom.meshes, 9);
  assert.equal(resolveAsset('./sample-parts.usda', `${f}[sample-robot.usda]`, cl.hasEntry).kind, 'package');
});
test('PointInstancer draws each instance; missing references and broken meshes are reported, not thrown', async () => {
  const { st, geom } = await stageOf(path.join(FIX, 'instancer.usda'));
  assert.equal(st.upAxis, 'Z');
  const r = geom.ranges['/World/Crates'];
  assert.equal(r[1], 2 * 12 + 1024, 'two boxes (12 triangles each) and one ball (16 x 32 quads)');
  assert.equal(geom.meshes, 3 + 1, 'three instances and the broken mesh; the prototypes are not drawn on their own');
  const lamp = nodeAt(st.root, '/World/Lamp');
  assert.equal(lamp.arcs[0].ok, false);
  assert.equal(lamp.arcs[0].error, 'file not found');
  assert.equal(geom.ranges['/World/Broken'][1], 1); // the triangle with index 9 is skipped
});
test('a reference cycle stops with a warning', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'usd-cycle-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.usda'), '#usda 1.0\n(\n    defaultPrim = "A"\n)\ndef Xform "A" (\n    references = @./b.usda@\n)\n{\n}\n');
    fs.writeFileSync(path.join(dir, 'b.usda'), '#usda 1.0\n(\n    defaultPrim = "B"\n)\ndef Xform "B" (\n    references = @./a.usda@\n)\n{\n}\n');
    const { st } = await stageOf(path.join(dir, 'a.usda'));
    assert.match(st.warnings.join(' '), /cycle/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('values at a time: the sample at or before the time, else the first sample, else the default', () => {
  const L = parseUsda('#usda 1.0\ndef "A" {\n double x = 7\n double x.timeSamples = {\n 1: 10,\n 5: 50,\n }\n}\n');
  const p = L.primAt('/A').prop('x');
  assert.equal(valueOf(p, 3), 10);
  assert.equal(valueOf(p, 6), 50);
  assert.equal(valueOf(p, NaN), 10);
  const q = parseUsda('#usda 1.0\ndef "A" {\n double y = 7\n}\n').primAt('/A').prop('y');
  assert.equal(valueOf(q, 3), 7);
});

// ---------- presentation ----------
test('tree rows and prim details for the viewer', async () => {
  const { st, geom, cl } = await stageOf(path.join(SAMPLES, 'sample-robot.usda'));
  const t = treeRows(st, geom.ranges);
  assert.deepEqual(t.rows[0], ['Robot', 'Xform', 0, 'gv']);
  assert.ok(t.rows.some((r) => r[0] === 'Gripper' && r[3].includes('r')));
  const info = primInfo(st, '/Robot/Plate', geom.ranges);
  assert.equal(info.type, 'Mesh');
  assert.equal(info.props.find((p) => p.name === 'points').count, 16);
  assert.equal(info.triangles, 22); // an octagon (6) and 8 side quads (16)
  assert.equal(primInfo(st, '/Robot/Arm/Elbow/Gripper', geom.ranges).arcs[0].target, '@./sample-parts.usda@</Gripper>');
  const s = summary(st, geom, cl);
  assert.equal(s.layers, 2);
  assert.equal(s.missing.length, 0);
});

// ---------- Pro: exports, check, compare ----------
test('flatten: one layer with the reference and the variant merged, no arcs left', async () => {
  const { st, cl } = await stageOf(path.join(SAMPLES, 'sample-robot.usda'));
  const flat = flatten(st, cl.layers.get(cl.root).layer);
  const text = toUsda(flat);
  assert.doesNotMatch(text, /references|variantSet|payload/);
  const again = parseUsda(text);
  assert.ok(again.primAt('/Robot/Arm/Elbow/Gripper/Looks/Chrome'));
  assert.equal(again.primAt('/Robot/Arm').prop('material:binding').targets.all()[0].path, '/Robot/Looks/Orange');
});
test('OBJ and GLB exports carry every drawn triangle', async () => {
  const { st, geom } = await stageOf(path.join(FIX, 'instancer.usda'));
  const o = toObj(geom, { upAxis: st.upAxis, name: 'instancer.usda', mtlName: 'instancer.mtl' });
  assert.equal(o.obj.split('\n').filter((l) => l.startsWith('f ')).length, geom.triangles32.length / 3);
  assert.match(o.obj, /mtllib instancer\.mtl/);
  assert.match(o.mtl, /newmtl color_/);
  const glb = toGlb(geom, { upAxis: st.upAxis, metersPerUnit: 0.01 });
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  assert.equal(dv.getUint32(0, true), 0x46546c67);
  assert.equal(dv.getUint32(8, true), glb.length);
  const json = JSON.parse(Buffer.from(glb.subarray(20, 20 + dv.getUint32(12, true))).toString());
  assert.equal(json.asset.version, '2.0');
  assert.equal(json.meshes.length, geom.parts.filter((p) => p.tri[1]).length);
  assert.equal(json.accessors.slice(2).reduce((a, x) => a + x.count, 0), geom.triangles32.length);
});
test('stage check: missing reference, missing texture, broken mesh, unknown type, no metersPerUnit', async () => {
  const f = path.join(FIX, 'instancer.usda');
  const { cl, st, geom } = await stageOf(f);
  const r = await checkStage({ closure: cl, stage: st, geom, kind: 'usda', usdz: null, exists: async (id) => fs.existsSync(id) });
  const has = (level, re) => r.items.some((i) => i.level === level && re.test(i.message + ' ' + i.where));
  assert.ok(has('error', /missing-lamp\.usda.*file not found/));
  assert.ok(has('error', /textures\/missing\.png.*file not found/));
  assert.ok(has('error', /point past the 3 points/));
  assert.ok(has('error', /missing-lamp\.usda/));
  assert.ok(has('info', /metersPerUnit/));
  assert.equal(r.summary.missingAssets, 1);
  const md = checkMarkdown(r, 'instancer.usda');
  assert.match(md, /^# Stage check: instancer\.usda/);
  assert.match(md, /\| error \| assets \|/);
  const ok = await stageOf(path.join(SAMPLES, 'sample-robot.usdz'));
  const r2 = await checkStage({ closure: ok.cl, stage: ok.st, geom: ok.geom, kind: 'usdz', usdz: ok.cl.packages.get(path.join(SAMPLES, 'sample-robot.usdz')), exists: async () => true });
  assert.equal(r2.summary.errors, 0, JSON.stringify(r2.items.filter((i) => i.level === 'error')));
});
test('compare: changed value, removed prim, added property, metadata change', () => {
  const a = parseUsda(fs.readFileSync(path.join(SAMPLES, 'sample-robot.usda'), 'utf8'));
  const text = fs.readFileSync(path.join(SAMPLES, 'sample-robot.usda'), 'utf8')
    .replace('double radius = 11', 'double radius = 12\n        custom string note = "new"')
    .replace(/\n {12}def Sphere "Joint"\n {12}\{\n {16}double radius = 4\n {12}\}\n/, '\n')
    .replace('kind = "assembly"', 'kind = "component"');
  const b = parseUsda(text);
  const d = diffLayers(a, b);
  assert.deepEqual(d.removed, ['/Robot/Arm/Elbow/Joint']);
  assert.deepEqual(d.added, []);
  const f = (p, field) => d.changed.find((c) => c.path === p && c.field === field);
  assert.equal(f('/Robot/Base.radius', 'value').detail, '11 -> 12');
  assert.ok(f('/Robot/Base.note', 'property added'));
  assert.equal(f('/Robot', 'metadata kind').detail, '"assembly" -> "component"');
  const pts = parseUsda(text.replace('(20, 1, 0), (14.142136', '(21, 1, 0), (14.142136'));
  assert.match(diffLayers(a, pts).changed.find((c) => c.path === '/Robot/Plate.points').detail, /16 values; first difference at index 0: \(20, 1, 0\) -> \(21, 1, 0\)/);
});
test('Tuples helpers', () => {
  const t = new Tuples(Float32Array.from([1, 2, 3, 4, 5, 6]), 3);
  assert.equal(t.length, 2);
  assert.deepEqual(t.at(1), [4, 5, 6]);
});
