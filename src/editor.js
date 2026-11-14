'use strict';
// Read-only custom editor for .usda, .usdc, .usd and .usdz. The extension host reads the file and every layer it
// references from disk (or from inside the USDZ), composes the stage and sends the webview the prim tree, the
// summary and the triangles for the 3D view. Nothing leaves the computer; the webview has no network access
// (CSP default-src 'none').
const vscode = require('vscode');
const path = require('path');
const { loadClosure, compose, geometry } = require('./core/stage');
const { treeRows, primInfo, summary, shortId } = require('./core/present');
const { toUsda } = require('./core/usda-write');
const { openAny } = require('./core/layer');
const { editorHtml } = require('./html');
const support = require('./support');

const VIEW_TYPE = 'usdViewer.editor';
const PREFIX = 'usdViewer';
const TEXT_SCHEME = 'usdviewer-text';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

/** Layer ids are file system paths for file: URIs and URI paths for other schemes. */
function idOf(uri) { return uri.scheme === 'file' ? uri.fsPath : uri.path; }
function uriOf(id, like) { return like.scheme === 'file' ? vscode.Uri.file(id) : like.with({ path: id }); }

/** Reads a USD file and everything it can reach; the result the viewer, the text view and the Pro tools share. */
async function loadStage(uri, opts = {}) {
  const max = Math.max(1, Number(setting('maxFileSizeMB', 512)) || 512) * 1048576;
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > max) throw new Error(`This file is ${(stat.size / 1048576).toFixed(0)} MB, more than the ${max / 1048576} MB set in "usdViewer.maxFileSizeMB".`);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const rootId = idOf(uri);
  const follow = opts.followReferences !== undefined ? opts.followReferences : setting('followReferences', true) !== false;
  let total = bytes.length;
  const read = async (id) => {
    if (!follow) throw Object.assign(new Error('not opened: "usdViewer.followReferences" is off'), { code: 'OFF' });
    const u = uriOf(id, uri);
    const st = await vscode.workspace.fs.stat(u);
    total += st.size;
    if (total > max * 2) throw new Error('not opened: the referenced layers together are larger than twice usdViewer.maxFileSizeMB');
    return vscode.workspace.fs.readFile(u);
  };
  const closure = await loadClosure(rootId, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), read);
  const stage = compose(closure);
  const geom = geometry(stage, { maxTriangles: Math.max(1000, Number(setting('maxTriangles', 3000000)) || 3000000) });
  const rootEntry = closure.layers.get(closure.root);
  const first = closure.packages.get(rootId);
  return { uri, bytes: bytes.length, closure, stage, geom, layer: rootEntry.layer, kind: first ? 'usdz' : rootEntry.kind, usdz: first || null, rootId };
}

class UsdDocument {
  constructor(uri) { this.uri = uri; this.data = null; this.error = ''; this.panels = new Set(); this.listeners = []; }
  async load() {
    this.data = null; this.error = '';
    try { this.data = await loadStage(this.uri); } catch (e) { this.error = String((e && e.message) || e); }
  }
  dispose() { for (const l of this.listeners) l.dispose(); }
}

function metaOf(doc) {
  const d = doc.data;
  if (!d) return { type: 'meta', error: doc.error || 'The file could not be read.' };
  const s = summary(d.stage, d.geom, d.closure);
  const fmt = d.kind === 'usdz' ? `USDZ · ${d.layer.format.toUpperCase()} ${d.layer.format === 'usdc' ? d.layer.version : ''}`.trim() : d.layer.format === 'usdc' ? `USDC ${d.layer.version}` : `USDA ${d.layer.version}`;
  const tree = treeRows(d.stage, d.geom.ranges);
  const warnings = [...d.stage.warnings, ...d.layer.warnings.slice(0, 20)];
  if (d.geom.truncated) warnings.push(`The 3D view shows the first ${d.geom.drawnTriangles.toLocaleString('en-US')} of ${d.geom.triangles.toLocaleString('en-US')} triangles (setting usdViewer.maxTriangles).`);
  return {
    type: 'meta', name: path.posix.basename(doc.uri.path), fmt, kind: d.kind,
    upAxis: d.stage.upAxis, metersPerUnit: d.stage.metersPerUnit, metersSet: d.stage.metersSet, upAxisSet: d.stage.upAxisSet,
    defaultPrim: d.stage.defaultPrim, startTime: d.stage.startTime, endTime: d.stage.endTime,
    stats: s, tree: tree.rows, treeTruncated: tree.truncated,
    layers: [...d.closure.layers].filter(([, e]) => !e.alias).map(([id, e]) => ({ name: shortId(id), kind: e.kind || '', error: e.error || '' })),
    files: d.usdz ? d.usdz.entries.map((e) => ({ name: e.name, size: e.size, method: e.method, aligned: e.aligned })) : null,
    skipped: d.geom.skipped, warnings,
  };
}

function geomOf(doc) {
  const g = doc.data.geom;
  return { type: 'geom', positions: g.positions, colors: g.colors, tri: g.triangles32, lines: g.lines32, bounds: g.bounds, ranges: g.ranges, upAxis: doc.data.stage.upAxis };
}

class UsdEditorProvider {
  constructor(context, hooks = {}) {
    this.context = context;
    this.hooks = hooks;
    this.docs = new Set();
    this.active = null;
    this._success = new WeakSet();
  }

  async openCustomDocument(uri) {
    const doc = new UsdDocument(uri);
    await doc.load();
    this.docs.add(doc);
    if (uri.scheme === 'file') {
      try {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), path.posix.basename(uri.path)));
        let timer = null;
        const reload = () => { clearTimeout(timer); timer = setTimeout(async () => { await doc.load(); for (const p of doc.panels) this.post(doc, p.webview); }, 300); };
        doc.listeners.push(w, w.onDidChange(reload), w.onDidCreate(reload));
      } catch (e) { /* no watcher: the view still works */ }
    }
    return { uri, dispose: () => { this.docs.delete(doc); doc.dispose(); if (this.active === doc) this.active = null; }, _doc: doc };
  }

  async resolveCustomEditor(handle, panel) {
    const doc = handle._doc;
    doc.panels.add(panel);
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const reach = this.hooks.reach ? this.hooks.reach() : null;
    panel.webview.options = {
      enableScripts: true, localResourceRoots: [media],
      enableCommandUris: (reach ? reach.commandIds() : []).concat(support.commandUris(PREFIX)),
    };
    panel.webview.html = editorHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css')).toString(),
      title: path.posix.basename(doc.uri.path),
      head: reach ? (n) => reach.headHtml(n) : undefined,
      showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    const setActive = () => { if (panel.active) { this.active = doc; this.activePanel = panel; } };
    setActive();
    panel.onDidChangeViewState(setActive);
    panel.onDidDispose(() => { doc.panels.delete(panel); if (this.activePanel === panel) { this.activePanel = null; if (this.active === doc) this.active = null; } });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') this.post(doc, panel.webview);
      else if (m.type === 'prim' && typeof m.path === 'string' && doc.data) send(panel.webview, { type: 'prim', info: primInfo(doc.data.stage, m.path, doc.data.geom.ranges) });
      else if (m.type === 'copy' && typeof m.text === 'string') { await vscode.env.clipboard.writeText(m.text.slice(0, 10000)); vscode.window.setStatusBarMessage(`Copied ${m.text.length > 60 ? m.text.slice(0, 57) + '...' : m.text}`, 3000); }
      else if (m.type === 'text') vscode.commands.executeCommand(`${PREFIX}.showText`, doc.uri, typeof m.entry === 'string' ? m.entry : undefined);
      else if (m.type === 'command' && typeof m.id === 'string' && /^usdViewer\.(convert|check|compare)$/.test(m.id)) vscode.commands.executeCommand(m.id, { surface: 'toolbar' });
    });
  }

  /** Sends meta and the geometry to one webview. */
  post(doc, webview) {
    send(webview, metaOf(doc));
    if (!doc.data) { if (this.hooks.onFailure) this.hooks.onFailure(doc); return; }
    send(webview, geomOf(doc));
    if (!this._success.has(doc)) { this._success.add(doc); if (this.hooks.onSuccess) this.hooks.onSuccess(doc); }
  }
}

function send(webview, msg) { try { const r = webview.postMessage(msg); if (r && r.then) r.then(undefined, () => false); } catch (e) { /* disposed */ } }

/** Read-only USDA text of a layer (the root layer, or one layer file inside a USDZ). */
class UsdTextProvider {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChange = this.emitter.event; }
  static uriFor(source, entry) {
    const base = entry ? path.posix.basename(entry) : path.posix.basename(source.path);
    const name = base.replace(/\.(usdc|usdz|usd)$/i, '') + (/\.usda$/i.test(base) ? '' : '.usda');
    return vscode.Uri.from({ scheme: TEXT_SCHEME, path: '/' + name, query: JSON.stringify({ src: source.toString(), entry: entry || '' }) });
  }
  async provideTextDocumentContent(uri) {
    let q;
    try { q = JSON.parse(uri.query); } catch (e) { return '# This text view lost its source file. Open the USD file again.\n'; }
    const src = vscode.Uri.parse(q.src);
    const bytes = await vscode.workspace.fs.readFile(src);
    let o = openAny(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), src.path);
    if (q.entry && o.usdz) o = openAny(o.usdz.read(q.entry), q.entry);
    const max = Math.max(100, Number(setting('textMaxArray', 20000)) || 20000);
    const head = o.layer.format === 'usdc' ? `# Read-only USDA text of ${q.entry || path.posix.basename(src.path)} (USDC ${o.layer.version}), written by USD Viewer by Zovo. Arrays longer than ${max.toLocaleString('en-US')} values are shortened here.\n` : '';
    return toUsda(o.layer, { sorted: o.layer.format === 'usdc', maxArray: max }).replace(/^#usda 1\.0\n/, (m) => m + head);
  }
}

module.exports = { UsdEditorProvider, UsdDocument, UsdTextProvider, VIEW_TYPE, TEXT_SCHEME, metaOf, geomOf, loadStage, idOf, uriOf };
