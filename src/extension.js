'use strict';
// USD Viewer: USDA, USDC, USDZ by Zovo: opens Pixar USD files in VS Code with a prim tree, details and a 3D view.
// No network, no telemetry. Activation shows nothing: no message, no popup. The viewer opens only for files the user opens.
const vscode = require('vscode');
const { UsdEditorProvider, UsdTextProvider, VIEW_TYPE, TEXT_SCHEME } = require('./editor');
const { createTools } = require('./tools');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');

const PREFIX = 'usdViewer';
const USDA_VIEW_TYPE = 'usdViewer.usdaPreview';
const EXT_ID = 'zovo.zovo-usd-viewer';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

function activate(context) {
  const sub = (d) => context.subscriptions.push(d);
  let rating = { success() {}, failure() {} };
  try { rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'USD Viewer' }); } catch (e) { /* rating is optional */ }
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  const pro = createPro({ vscode, context });
  const reach = createReach({ vscode, ...reachConfig, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  sub(pro.onDidChange(() => reach.refresh()));

  const provider = new UsdEditorProvider(context, {
    reach: () => reach,
    onSuccess: (doc) => rating.success(doc.uri),
    onFailure: () => rating.failure(),
  });
  for (const vt of [VIEW_TYPE, USDA_VIEW_TYPE]) sub(vscode.window.registerCustomEditorProvider(vt, provider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }));
  const text = new UsdTextProvider();
  sub(vscode.workspace.registerTextDocumentContentProvider(TEXT_SCHEME, text));
  const tools = createTools({ context, provider, pro, reach });

  const reg = (id, fn) => sub(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); return undefined; }
  }));
  const pickUri = (uri) => (uri && uri.scheme ? uri : (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri) || (provider.active && provider.active.uri));
  reg(`${PREFIX}.openWithViewer`, (uri) => {
    const u = pickUri(uri);
    if (!u) { vscode.window.showInformationMessage('Select a .usda, .usdc, .usd or .usdz file first.'); return undefined; }
    return vscode.commands.executeCommand('vscode.openWith', u, /\.usda$/i.test(u.path) ? USDA_VIEW_TYPE : VIEW_TYPE);
  });
  reg(`${PREFIX}.showText`, async (uri, entry) => {
    const u = pickUri(uri);
    if (!u) { vscode.window.showInformationMessage('Open a USD file first.'); return undefined; }
    const doc = await vscode.workspace.openTextDocument(UsdTextProvider.uriFor(u, typeof entry === 'string' ? entry : ''));
    try { await vscode.languages.setTextDocumentLanguage(doc, 'usda'); } catch (e) { /* plain text then */ }
    return vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  });
  reg(`${PREFIX}.openSample`, () => vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(context.extensionUri, 'samples', 'sample-robot.usda'), USDA_VIEW_TYPE));
  reg(`${PREFIX}.openUsdzSample`, () => vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(context.extensionUri, 'samples', 'sample-robot.usdz'), VIEW_TYPE));
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
  const argOf = (a) => (a && a.scheme ? a : a && a.surface ? a : undefined);
  reg(`${PREFIX}.convert`, reach.wrap((uri) => tools.convertTool(argOf(uri))));
  reg(`${PREFIX}.check`, reach.wrap((uri) => tools.checkTool(argOf(uri))));
  reg(`${PREFIX}.compare`, reach.wrap((uri, uris) => tools.compareTool(argOf(uri), uris)));
  sub(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) reach.refresh(); }));
  sub(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  return { provider, tools, pro, text };
}

function deactivate() {}

module.exports = { activate, deactivate };
