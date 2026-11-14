'use strict';
// The three Zovo Pro tools: Convert and export, Stage check, Compare two USD files. Each asks pro.allowed() before it
// starts and calls pro.produced() only after its result is on disk or on screen, so Escape, Cancel or an error never
// uses a free try. Everything runs on this computer; nothing is uploaded.
const vscode = require('vscode');
const path = require('path');
const { loadStage, idOf, uriOf } = require('./editor');
const { toUsda } = require('./core/usda-write');
const { writeUsdc } = require('./core/usdc-write');
const { flatten, toObj, toGlb } = require('./core/export');
const { checkStage, checkMarkdown } = require('./core/check');
const { diffLayers } = require('./core/diff');
const { openAny } = require('./core/layer');
const { panelHtml } = require('./html');
const support = require('./support');

const PREFIX = 'usdViewer';
const USD_RE = /\.(usda|usdc|usd|usdz)$/i;
const base = (uri) => path.posix.basename(uri.path);
const stem = (uri) => base(uri).replace(/\.[^.]+$/, '');

function createTools({ context, provider, pro, reach }) {
  const panels = {};

  async function target(arg, title) {
    if (arg && arg.scheme) return arg;
    if (provider.active) return provider.active.uri;
    const ed = vscode.window.activeTextEditor;
    if (ed && USD_RE.test(ed.document.uri.path)) return ed.document.uri;
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Choose', title, filters: { 'USD files': ['usda', 'usdc', 'usd', 'usdz'], 'All files': ['*'] } });
    return r && r[0];
  }
  async function stageFor(uri) {
    for (const d of provider.docs) if (d.uri.toString() === uri.toString() && d.data) return d.data;
    return loadStage(uri);
  }
  async function exists(uri) { try { await vscode.workspace.fs.stat(uri); return true; } catch (e) { return false; } }
  async function saveTo(uri, suffix, label) {
    const ext = suffix.split('.').pop();
    const def = vscode.Uri.joinPath(uri, '..', `${stem(uri)}${suffix}`);
    let u = def;
    if (await exists(def) || uri.toString() === def.toString()) u = vscode.Uri.joinPath(uri, '..', `${stem(uri)}-converted${suffix}`);
    return vscode.window.showSaveDialog({ defaultUri: u, saveLabel: `Save ${label}`, filters: { [label]: [ext] } });
  }

  function openPanel(kind, title) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    let p = panels[kind];
    if (p) { p.panel.title = title; p.panel.reveal(vscode.ViewColumn.Beside, false); return p; }
    const panel = vscode.window.createWebviewPanel(`${PREFIX}.${kind}`, title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
      enableCommandUris: (reach ? reach.commandIds() : []).concat(support.commandUris(PREFIX)),
    });
    panel.webview.html = panelHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css')).toString(),
      title, head: reach ? (n) => reach.headHtml(n) : undefined,
      showSupportLinks: vscode.workspace.getConfiguration(PREFIX).get('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    p = { panel, data: null, ready: false, onShown: null, onAction: null };
    panels[kind] = p;
    panel.onDidDispose(() => { delete panels[kind]; });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') { p.ready = true; if (p.data) panel.webview.postMessage({ type: 'data', data: p.data }); }
      else if (m.type === 'shown' && p.onShown) { const f = p.onShown; p.onShown = null; await f(); }
      else if (m.type === 'action' && p.onAction) await p.onAction(String(m.id || ''));
    });
    return p;
  }
  function show(kind, title, data, feature, onAction) {
    const p = openPanel(kind, title);
    p.data = data;
    p.onAction = onAction || null;
    p.onShown = () => pro.produced(feature);
    if (p.ready) p.panel.webview.postMessage({ type: 'data', data });
    return p;
  }

  // ---------- 1. Convert and export ----------
  async function convertTool(arg) {
    if (!(await pro.allowed('convert', arg))) return undefined;
    const uri = await target(arg, 'Choose a USD file to convert');
    if (!uri) return undefined;
    const data = await stageFor(uri);
    const isText = data.layer.format === 'usda';
    const items = [
      !isText ? { id: 'usda', label: 'Save as USDA text', description: `${data.kind === 'usdz' ? 'the root layer of the package' : 'the binary layer'} as readable text, every value` } : null,
      isText || data.kind === 'usdz' ? { id: 'usdc', label: 'Save as USDC binary', description: 'crate 0.8.0, smaller and faster to load' } : null,
      { id: 'flat', label: 'Save the composed stage as one USDA file', description: `references, payloads, sublayers and selected variants merged (${data.closure.layers.size} layer${data.closure.layers.size > 1 ? 's' : ''})` },
      { id: 'obj', label: 'Export meshes as OBJ', description: `${data.geom.meshes} meshes, ${data.geom.triangles.toLocaleString('en-US')} triangles in world space, with an MTL file of colors` },
      { id: 'glb', label: 'Export meshes as glTF binary (.glb)', description: 'world space, meters, Y up, vertex colors' },
    ].filter(Boolean);
    const pick = await vscode.window.showQuickPick(items, { title: `Convert ${base(uri)}`, placeHolder: 'What to write' });
    if (!pick) return undefined;
    if (!data.geom.meshes && (pick.id === 'obj' || pick.id === 'glb')) { vscode.window.showWarningMessage('This stage has no meshes or shapes the viewer can draw, so there is nothing to export.'); return undefined; }
    const suffix = { usda: '.usda', usdc: '.usdc', flat: '.flat.usda', obj: '.obj', glb: '.glb' }[pick.id];
    const dest = await saveTo(uri, suffix, pick.id === 'glb' ? 'glTF binary' : pick.id === 'obj' ? 'OBJ' : pick.id === 'usdc' ? 'USDC' : 'USDA');
    if (!dest) return undefined;
    const files = [dest];
    if (pick.id === 'usda') await vscode.workspace.fs.writeFile(dest, Buffer.from(toUsda(data.layer, { sorted: true })));
    else if (pick.id === 'usdc') await vscode.workspace.fs.writeFile(dest, Buffer.from(writeUsdc(data.layer)));
    else if (pick.id === 'flat') await vscode.workspace.fs.writeFile(dest, Buffer.from(toUsda(flatten(data.stage, data.layer), { sorted: data.layer.format === 'usdc' })));
    else if (pick.id === 'obj') {
      const mtlUri = vscode.Uri.joinPath(dest, '..', base(dest).replace(/\.obj$/i, '') + '.mtl');
      const o = toObj(data.geom, { upAxis: data.stage.upAxis, name: base(uri), mtlName: base(mtlUri) });
      await vscode.workspace.fs.writeFile(dest, Buffer.from(o.obj));
      await vscode.workspace.fs.writeFile(mtlUri, Buffer.from(o.mtl));
      files.push(mtlUri);
    } else if (pick.id === 'glb') await vscode.workspace.fs.writeFile(dest, Buffer.from(toGlb(data.geom, { upAxis: data.stage.upAxis, metersPerUnit: data.stage.metersPerUnit })));
    // the result first, then the free-try line in the status bar (pro.produced writes it)
    vscode.window.showInformationMessage(`Saved ${base(dest)}${files.length > 1 ? ` and ${base(files[1])}` : ''}.`);
    await pro.produced('convert');
    if (pick.id === 'usda' || pick.id === 'flat') { try { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(dest), { preview: false }); } catch (e) { /* written anyway */ } }
    else if (pick.id === 'usdc') { try { await vscode.commands.executeCommand('vscode.openWith', dest, 'usdViewer.editor'); } catch (e) { /* written anyway */ } }
    return { kind: pick.id, files };
  }

  // ---------- 2. Stage check ----------
  async function checkTool(arg) {
    if (!(await pro.allowed('check', arg))) return undefined;
    const uri = await target(arg, 'Choose a USD file to check');
    if (!uri) return undefined;
    const data = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Checking ${base(uri)}` }, async () => {
      const d = await stageFor(uri);
      const r = await checkStage({ ...d, exists: (id) => exists(uriOf(id, uri)) });
      r.title = base(uri);
      return r;
    });
    show('check', `Stage check: ${base(uri)}`, data, 'check', async (id) => {
      const md = id === 'md';
      const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(uri, '..', `${stem(uri)}-check.${md ? 'md' : 'json'}`), filters: md ? { Markdown: ['md'] } : { JSON: ['json'] } });
      if (!dest) return;
      await vscode.workspace.fs.writeFile(dest, Buffer.from(md ? checkMarkdown(data, base(uri)) : JSON.stringify(data, null, 2) + '\n'));
      vscode.window.setStatusBarMessage(`Saved ${base(dest)}`, 5000);
    });
    return data;
  }

  // ---------- 3. Compare ----------
  async function compareTool(arg, arg2) {
    if (!(await pro.allowed('compare', arg))) return undefined;
    let a = arg && arg.scheme ? arg : null;
    let b = Array.isArray(arg2) && arg2.length === 2 && arg2[0].scheme ? arg2.find((x) => x.toString() !== (a && a.toString())) : null;
    if (!a) a = await target(undefined, 'Choose the first USD file');
    if (!a) return undefined;
    if (!b) {
      const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', title: `Compare ${base(a)} with`, defaultUri: vscode.Uri.joinPath(a, '..'), filters: { 'USD files': ['usda', 'usdc', 'usd', 'usdz'], 'All files': ['*'] } });
      b = r && r[0];
    }
    if (!b) return undefined;
    const read = async (u) => { const bytes = await vscode.workspace.fs.readFile(u); return openAny(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), u.path).layer; };
    const [la, lb] = [await read(a), await read(b)];
    const d = diffLayers(la, lb);
    const data = { kind: 'compare', a: base(a), b: base(b), formatA: la.format, formatB: lb.format, ...d };
    show('compare', `Compare: ${base(a)} and ${base(b)}`, data, 'compare', async () => {
      const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(a, '..', `${stem(a)}-vs-${stem(b)}.md`), filters: { Markdown: ['md'] } });
      if (!dest) return;
      await vscode.workspace.fs.writeFile(dest, Buffer.from(compareMarkdown(data)));
      vscode.window.setStatusBarMessage(`Saved ${base(dest)}`, 5000);
    });
    return data;
  }

  return { convertTool, checkTool, compareTool, panels };
}

function compareMarkdown(d) {
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [`# ${d.a} compared with ${d.b}`, '', `${d.primsA} prims in ${d.a} (${d.formatA}), ${d.primsB} in ${d.b} (${d.formatB}). ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changes, ${d.same} prims unchanged.`, ''];
  if (d.added.length) lines.push('## Added prims', '', ...d.added.map((p) => `- ${p}`), '');
  if (d.removed.length) lines.push('## Removed prims', '', ...d.removed.map((p) => `- ${p}`), '');
  if (d.changed.length) { lines.push('## Changes', '', '| Path | What | Change |', '|---|---|---|'); for (const c of d.changed) lines.push(`| ${esc(c.path)} | ${esc(c.field)} | ${esc(c.detail)} |`); }
  return lines.join('\n') + '\n';
}

module.exports = { createTools, compareMarkdown, idOf };
