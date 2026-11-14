'use strict';
// Zovo Pro for USD Viewer: USDA, USDC, USDZ, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license by apply.sh). Three Pro tools, 3 free tries each on this computer. A try counts only after the
// tool showed its result (a written file, a check report, a compare view); Escape, Cancel or an error never uses one.
// Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool with no tries left.
const { createLicense } = require('./license');
const { currentSurface } = require('./reach');

const SKU = 'usd-viewer-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'usdViewer.proTrial';

const FEATURES = {
  convert: {
    title: 'Convert and export',
    detail: 'Saves USDC and USDZ layers as USDA text and USDA as USDC binary, writes the composed stage as one flat USDA file, and exports the meshes as OBJ or glTF binary (GLB) in world space.',
  },
  check: {
    title: 'Stage check',
    detail: 'Lists every layer, reference and payload with its status, every texture and asset path with found or missing, prims that point at missing targets, broken meshes, missing defaultPrim, upAxis and units, and USDZ packaging problems; saves the report as Markdown or JSON.',
  },
  compare: {
    title: 'Compare two USD files',
    detail: 'Compares two USD files (USDA, USDC or USDZ in any mix) as prim trees: prims added and removed, type changes, metadata changes and property changes with the first array index that differs; saves the result as Markdown.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function surfaceOf(arg) {
  const s = currentSurface();
  if (s) return s;
  if (arg && typeof arg === 'object' && typeof arg.surface === 'string') return arg.surface;
  return undefined;
}

function createPro({ vscode, context, license, prefix = 'usdViewer', productName = 'USD Viewer: USDA, USDC, USDZ' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  // Counts never go down in a session: globalState can hand back an older value for a moment after a write, so the
  // highest count seen here wins.
  const seen = {};
  const used = (f) => Math.max(Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0, seen[f] || 0);
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f, arg) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    const surface = surfaceOf(arg);
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, triesUsed: used(f), tools: TOOLS, ...(surface ? { surface } : {}) }));
  }

  /** After the tool showed its result: counts one free try (nothing when licensed). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    for (const k of Object.keys(seen)) m[k] = Math.max(Number(m[k]) || 0, seen[k]);
    m[f] = used(f) + 1;
    seen[f] = m[f];
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left, used,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS, surfaceOf };
