'use strict';
// Opens any USD file: USDA text, USDC binary (.usd can be either; the header decides) or a USDZ package (its root
// layer, plus the list of files inside).
const { readUsdc, isUsdc } = require('./usdc');
const { parseUsda, isUsda } = require('./usda');
const { isZip, openUsdz } = require('./usdz');

/** { layer, kind: 'usda'|'usdc'|'usdz', usdz?: { entries, rootName, ... } } */
function openAny(buf, name = '') {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (isZip(b)) {
    const pkg = openUsdz(b);
    if (!pkg.rootName) throw new Error('This USDZ package has no .usda, .usdc or .usd layer.');
    const inner = pkg.read(pkg.rootName);
    const layer = isUsdc(inner) ? readUsdc(inner) : parseUsda(Buffer.from(inner.buffer, inner.byteOffset, inner.byteLength).toString('utf8'));
    return { layer, kind: 'usdz', usdz: pkg, rootName: pkg.rootName, rootKind: layer.format };
  }
  if (isUsdc(b)) return { layer: readUsdc(b), kind: 'usdc' };
  if (isUsda(b)) return { layer: parseUsda(Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('utf8')), kind: 'usda' };
  const ext = String(name).toLowerCase().split('.').pop();
  if (ext === 'usdz') throw new Error('This file is not a zip archive, so it is not a USDZ package.');
  throw new Error('This file is neither USDA text ("#usda 1.0" first line) nor USDC binary ("PXR-USDC" header).');
}

module.exports = { openAny };
