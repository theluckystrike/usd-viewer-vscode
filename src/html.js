'use strict';
// Webview HTML for the USD viewer and the Pro result panels. No vscode import, so tests can check the CSP: no
// remote origin, no connect-src, scripts only with the page nonce.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const PREFIX = 'usdViewer';
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function csp(cspSource, n) {
  return ["default-src 'none'", `style-src ${cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`, `img-src ${cspSource} data: blob:`, `font-src ${cspSource}`].join('; ');
}

/** p: { cspSource, scriptUri, styleUri, title, showSupportLinks, head?(nonce) } */
function editorHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>
</head>
<body>
<div id="toolbar" role="toolbar" aria-label="USD viewer">
  <span id="fmt" class="chip" title="File format and version"></span>
  <span id="stats" class="muted"></span>
  <span class="grp">
    <button class="tb" id="fitBtn" title="Fit the model in the view (F)">Fit</button>
    <button class="tb" id="wireBtn" title="Show polygon edges (W)" aria-pressed="false">Wireframe</button>
    <button class="tb" id="shadeBtn" title="Hide or show the shaded surfaces (S)" aria-pressed="true">Shaded</button>
    <button class="tb" id="upBtn" title="The stage up axis (from upAxis). Click to view it the other way"></button>
  </span>
  <span class="grp">
    <button class="tb" id="textBtn" title="Show this layer as USDA text in a read-only tab (T)">USDA text</button>
    <button class="tb" id="filesBtn" title="Files inside the USDZ package" hidden>Files</button>
    <button class="tb" id="infoBtn" title="Show or hide the prim tree and the details (I)" aria-pressed="true">Panels</button>
  </span>
</div>
<div id="err" role="alert" hidden></div>
<div id="main">
  <aside id="treePane" aria-label="Prim tree">
    <input id="search" type="search" placeholder="Filter prims by name or type" aria-label="Filter prims">
    <div id="tree" role="tree" tabindex="0"></div>
  </aside>
  <div id="viewWrap"><canvas id="gl" tabindex="0" aria-label="3D preview"></canvas><div id="viewNote" hidden></div></div>
  <aside id="info" aria-label="Prim details"></aside>
</div>
<div id="status"><span id="hint">Drag to orbit, right-drag or Shift+drag to pan, wheel to zoom, double-click to fit.</span><span id="sel"></span></div>
<div id="footer"></div>
<template id="zovo-footer">${footer}</template>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

/** Result panel of a Pro tool. p: { cspSource, scriptUri, styleUri, title, head?(nonce), showSupportLinks } */
function panelHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>
</head>
<body>
<div id="toolbar" role="toolbar"><strong id="title"></strong><span id="actions"></span></div>
<div id="app"><p class="muted">Working...</p></div>
<div id="footer">${footer}</div>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { editorHtml, panelHtml, csp };
