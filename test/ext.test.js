'use strict';
// Extension tests with the vscode stub: listing, activation, the custom editor, the text view, the Pro tools and
// their free tries, the webview HTML and the README.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadExtension, tmpDir, cleanup } = require('./support/vscode-stub');
const { editorHtml, panelHtml } = require('../src/html');
const { readUsdc } = require('../src/core/usdc');
const { parseUsda } = require('../src/core/usda');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
test.after(() => cleanup());

function activate(folder) {
  const s = loadExtension();
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  s.api = s.ext.activate(s.context);
  return s;
}
function tmpWs() {
  const dir = tmpDir('usd-ws-');
  fs.mkdirSync(path.join(dir, 'usd'), { recursive: true });
  for (const f of fs.readdirSync(SAMPLES)) fs.copyFileSync(path.join(SAMPLES, f), path.join(dir, 'usd', f));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'instancer.usda'), path.join(dir, 'usd', 'instancer.usda'));
  fs.writeFileSync(path.join(dir, 'usd', 'broken.usdc'), 'PXR-USDC broken');
  return dir;
}
function fakePanel() {
  let onMsg;
  const posted = [];
  return {
    posted, viewColumn: 1, active: true,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), reveal() {},
    send: (m) => onMsg(m),
  };
}
async function openEditor(s, file) {
  const prov = s.providers.custom.p;
  const handle = await prov.openCustomDocument(s.vscode.Uri.file(file));
  const panel = fakePanel();
  await prov.resolveCustomEditor(handle, panel);
  await panel.send({ type: 'ready' });
  return { prov, handle, panel, doc: handle._doc };
}

// ---------- package.json and listing ----------
test('listing: display name, phrase first, 5 keywords, engines low enough for Cursor and Windsurf', () => {
  assert.equal(pkg.displayName, 'USD Viewer: USDA, USDC, USDZ');
  assert.ok(pkg.displayName.length <= 30);
  assert.ok(pkg.description.startsWith('USD viewer'));
  assert.deepEqual(pkg.keywords, ['usd', 'usdz', 'openusd', '3d', 'pixar usd']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.equal(pkg.name, 'zovo-usd-viewer');
  assert.equal(pkg.publisher, 'zovo');
  assert.deepEqual(pkg.contributes.customEditors.map((e) => [e.viewType, e.priority, e.selector.map((x) => x.filenamePattern).join(' ')]), [['usdViewer.editor', 'default', '*.usdc *.usdz *.usd'], ['usdViewer.usdaPreview', 'option', '*.usda']]);
  assert.ok(fs.existsSync(path.join(ROOT, pkg.contributes.grammars[0].path)));
});
test('every contributed command is registered, and every registered usdViewer command is contributed', () => {
  const s = activate();
  const contributed = pkg.contributes.commands.map((c) => c.command);
  for (const c of contributed) assert.ok(s.commands.has(c), `not registered: ${c}`);
  for (const c of s.commands.keys()) if (c.startsWith('usdViewer.')) assert.ok(contributed.includes(c), `not in package.json: ${c}`);
  const menus = Object.values(pkg.contributes.menus).flat().map((m) => m.command);
  for (const c of menus) assert.ok(contributed.includes(c), `menu names an unknown command: ${c}`);
});
test('activation shows nothing: no message, no panel, no editor', () => {
  const s = activate();
  assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length, 0);
  assert.equal(s.log.panel, undefined);
  assert.equal(s.log.opened.length, 0);
  assert.equal(s.log.external.length, 0);
});

// ---------- the viewer ----------
test('viewer: the USDZ sample sends meta (tree, counts, files) and the geometry', async () => {
  const s = activate();
  const { panel } = await openEditor(s, path.join(SAMPLES, 'sample-robot.usdz'));
  const meta = panel.posted.find((m) => m.type === 'meta');
  const geom = panel.posted.find((m) => m.type === 'geom');
  assert.equal(meta.kind, 'usdz');
  assert.equal(meta.fmt, 'USDZ · USDA');
  assert.equal(meta.stats.meshes, 9);
  assert.equal(meta.stats.layers, 2);
  assert.deepEqual(meta.files.map((f) => f.name), ['sample-robot.usda', 'sample-parts.usda']);
  assert.deepEqual(meta.tree[0], ['Robot', 'Xform', 0, 'gv']);
  assert.ok(geom.positions instanceof Float32Array && geom.tri instanceof Uint32Array && geom.tri.length % 3 === 0);
  assert.equal(geom.upAxis, 'Y');
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.ok(panel.webview.options.enableCommandUris.includes('usdViewer.convert'));
});
test('viewer: prim details on request, copy to the clipboard, text view request', async () => {
  const s = activate();
  const { panel } = await openEditor(s, path.join(SAMPLES, 'sample-robot.usdc'));
  await panel.send({ type: 'prim', path: '/Robot/Base' });
  const info = panel.posted.find((m) => m.type === 'prim').info;
  assert.equal(info.type, 'Cylinder');
  assert.ok(info.props.some((p) => p.name === 'radius' && p.value === '11'));
  await panel.send({ type: 'copy', text: '/Robot/Base' });
  assert.equal(s.log.clipboard, '/Robot/Base');
  await panel.send({ type: 'text' });
  await tick(10);
  assert.ok(s.log.commands.some((c) => c[0] === 'usdViewer.showText'));
});
test('viewer: a broken file shows the reason, never throws', async () => {
  const dir = tmpWs();
  const s = activate();
  const { panel } = await openEditor(s, path.join(dir, 'usd', 'broken.usdc'));
  const meta = panel.posted.find((m) => m.type === 'meta');
  assert.match(meta.error, /USDC/);
  assert.equal(panel.posted.filter((m) => m.type === 'geom').length, 0);
});
test('viewer: maxFileSizeMB refuses big files with a message', async () => {
  const s = activate();
  s.config.maxFileSizeMB = 1;
  const big = path.join(tmpDir('usd-big-'), 'big.usda');
  fs.writeFileSync(big, '#usda 1.0\n' + '#'.repeat(1100000) + '\n');
  const { panel } = await openEditor(s, big);
  assert.match(panel.posted.find((m) => m.type === 'meta').error, /maxFileSizeMB/);
});
test('viewer: followReferences off shows only the opened layer', async () => {
  const s = activate();
  s.config.followReferences = false;
  const { panel } = await openEditor(s, path.join(SAMPLES, 'sample-robot.usda'));
  const meta = panel.posted.find((m) => m.type === 'meta');
  assert.equal(meta.stats.missing.length, 1);
  assert.match(meta.stats.missing[0].error, /followReferences/);
});
test('text view: USDC shown as USDA text with a header line, the USDZ entry too', async () => {
  const s = activate();
  const ed = await s.commands.get('usdViewer.showText')(s.vscode.Uri.file(path.join(SAMPLES, 'sample-robot.usdc')));
  const text = ed.document.getText();
  assert.match(text, /^#usda 1\.0\n# Read-only USDA text of sample-robot\.usdc \(USDC 0\.8\.0\)/);
  assert.ok(parseUsda(text).primAt('/Robot/Arm/Elbow/Gripper'));
  assert.equal(ed.document.languageId, 'usda');
  const ed2 = await s.commands.get('usdViewer.showText')(s.vscode.Uri.file(path.join(SAMPLES, 'sample-robot.usdz')), 'sample-parts.usda');
  assert.match(ed2.document.getText(), /def Xform "Gripper"/);
});

// ---------- HTML ----------
test('webview HTML: strict CSP, nonce scripts, no remote URLs', () => {
  for (const html of [editorHtml({ cspSource: 'vscode-resource:', scriptUri: 'a.js', styleUri: 'a.css', title: '<x>' }), panelHtml({ cspSource: 'vscode-resource:', scriptUri: 'p.js', styleUri: 'p.css', title: 't' })]) {
    const csp = /content="([^"]+)"/.exec(html)[1];
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /connect-src|unsafe-eval|https?:/);
    const nonce = /'nonce-([^']+)'/.exec(csp)[1];
    for (const m of html.matchAll(/<script([^>]*)>/g)) assert.match(m[1], new RegExp(`nonce="${nonce}"`));
    assert.doesNotMatch(html, /<x>/);
  }
});
test('viewer CSS lets the hidden attribute win', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'media', 'viewer.css'), 'utf8'), /\[hidden\] \{ display: none !important; \}/);
});
test('media scripts load nothing remote and set no inline style attributes in HTML strings', () => {
  for (const f of ['viewer.js', 'panel.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'media', f), 'utf8');
    assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|WebSocket|https?:\/\//);
    assert.doesNotMatch(src, /style="/);
  }
});

// ---------- Pro tools ----------
test('Pro convert: USDC to USDA text; a try counts after the file is written', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const uri = s.vscode.Uri.file(path.join(dir, 'usd', 'sample-robot.usdc'));
  s.ui.quick.push((items) => items.find((i) => i.id === 'usda'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'usd', 'out.usda')));
  const r = await s.api.tools.convertTool(uri);
  assert.equal(r.kind, 'usda');
  assert.equal(fs.readFileSync(path.join(dir, 'usd', 'out.usda'), 'utf8'), fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-robot.usdcat.usda'), 'utf8'));
  assert.equal(s.api.pro.left('convert'), 2);
});
test('Pro convert: USDA to USDC binary reads back the same; OBJ and GLB exports', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const uri = s.vscode.Uri.file(path.join(dir, 'usd', 'sample-robot.usda'));
  s.ui.quick.push((items) => items.find((i) => i.id === 'usdc'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'usd', 'robot.usdc')));
  await s.api.tools.convertTool(uri);
  assert.equal(readUsdc(fs.readFileSync(path.join(dir, 'usd', 'robot.usdc'))).primAt('/Robot/Arm/Elbow').children.length, 3);
  s.ui.quick.push((items) => items.find((i) => i.id === 'obj'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'usd', 'robot.obj')));
  const r = await s.api.tools.convertTool(uri);
  assert.deepEqual(r.files.map((f) => path.basename(f.fsPath)), ['robot.obj', 'robot.mtl']);
  assert.match(fs.readFileSync(path.join(dir, 'usd', 'robot.obj'), 'utf8'), /mtllib robot\.mtl/);
  s.ui.quick.push((items) => items.find((i) => i.id === 'glb'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'usd', 'robot.glb')));
  await s.api.tools.convertTool(uri);
  assert.equal(fs.readFileSync(path.join(dir, 'usd', 'robot.glb')).readUInt32LE(0), 0x46546c67);
  assert.equal(s.api.pro.left('convert'), 0);
});
test('Pro tools: Escape uses no try; the 4th use goes to the Zovo Pro panel and writes nothing', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const uri = s.vscode.Uri.file(path.join(dir, 'usd', 'sample-robot.usda'));
  s.ui.quick.push(undefined);
  await s.api.tools.convertTool(uri);
  assert.equal(s.api.pro.left('convert'), 3);
  for (let i = 0; i < 3; i++) { s.ui.quick.push((items) => items.find((x) => x.id === 'flat')); s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'usd', `flat${i}.usda`))); await s.api.tools.convertTool(uri); }
  assert.equal(s.api.pro.left('convert'), 0);
  assert.ok(parseUsda(fs.readFileSync(path.join(dir, 'usd', 'flat0.usda'), 'utf8')).primAt('/Robot/Arm/Elbow/Gripper/Palm'));
  s.ui.quick.push((items) => items.find((x) => x.id === 'flat'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'usd', 'flat9.usda')));
  const r = await s.api.tools.convertTool(uri);
  assert.equal(r, undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'usd', 'flat9.usda')));
  assert.equal(s.api.pro.left('check'), 3);
});
test('Pro check: report in a panel, try counted only when the panel says shown, Markdown saved', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const data = await s.api.tools.checkTool(s.vscode.Uri.file(path.join(dir, 'usd', 'instancer.usda')));
  assert.equal(data.kind, 'check');
  assert.ok(data.summary.errors >= 3);
  assert.equal(s.api.pro.left('check'), 3);
  await tick(10);
  const panel = s.log.panel;
  assert.equal(panel.posted[0].type, 'data');
  await panel.send({ type: 'shown' });
  assert.equal(s.api.pro.left('check'), 2);
  const dest = path.join(dir, 'check.md');
  s.ui.save.push(s.vscode.Uri.file(dest));
  await panel.send({ type: 'action', id: 'md' });
  assert.match(fs.readFileSync(dest, 'utf8'), /^# Stage check: instancer\.usda/);
});
test('Pro compare: USDA against USDC of the same scene finds no difference; a changed copy does', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  s.ui.open.push([s.vscode.Uri.file(path.join(dir, 'usd', 'sample-robot.usdc'))]);
  const same = await s.api.tools.compareTool(s.vscode.Uri.file(path.join(dir, 'usd', 'sample-robot.usda')));
  assert.equal(same.added.length + same.removed.length + same.changed.length, 0);
  fs.writeFileSync(path.join(dir, 'usd', 'changed.usda'), fs.readFileSync(path.join(SAMPLES, 'sample-robot.usda'), 'utf8').replace('double radius = 5', 'double radius = 6'));
  s.ui.open.push([s.vscode.Uri.file(path.join(dir, 'usd', 'changed.usda'))]);
  const d = await s.api.tools.compareTool(s.vscode.Uri.file(path.join(dir, 'usd', 'sample-robot.usda')));
  assert.deepEqual(d.changed.map((c) => [c.path, c.detail]), [['/Robot/Arm/Shoulder.radius', '5 -> 6']]);
  await tick(10);
  await s.log.panel.send({ type: 'shown' });
  assert.equal(s.api.pro.left('compare'), 2);
});
test('Pro tools from the toolbar row pass the toolbar surface; other commands are refused', async () => {
  const s = activate();
  const { panel } = await openEditor(s, path.join(SAMPLES, 'sample-robot.usdz'));
  s.ui.quick.push(undefined);
  await panel.send({ type: 'command', id: 'usdViewer.convert' });
  await tick(20);
  assert.ok(s.log.lastPick.items.some((i) => i.id === 'glb'));
  await panel.send({ type: 'command', id: 'workbench.action.quit' });
  assert.ok(!s.log.commands.some((c) => c[0] === 'workbench.action.quit'));
});

// ---------- README and text ----------
test('README: first screen has the main use, a screenshot of this product, the free list and the price', () => {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const first = md.split('\n').slice(0, 30).join('\n');
  assert.match(first, /^# USD Viewer for USDA, USDC and USDZ/);
  assert.match(first, /images\/screenshot\.png/);
  assert.match(first, /Zovo Pro: USD 19 once/);
  assert.match(md, /by Zovo/);
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'screenshot.png')));
});
test('support links name this listing and related Zovo tools', () => {
  const support = require('../src/support');
  assert.equal(support.SELF_ID, 'zovo.zovo-usd-viewer');
  assert.ok(support.RELATED.length >= 3 && !support.RELATED.includes(support.SELF_ID));
  assert.equal(support.PRO.getPro, 'usdViewer.getPro');
});
