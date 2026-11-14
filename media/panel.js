// Result panel for the Pro tools: the stage check report and the compare result. Gets one 'data' message, draws it,
// and tells the extension host 'shown' once the result is on screen (that is when a free try counts).
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  let filter = '', level = 'all', data = null;

  function renderCheck(d) {
    const s = d.summary;
    $('actions').innerHTML = '<button class="tb" data-id="md">Save Markdown</button> <button class="tb" data-id="json">Save JSON</button>';
    const items = d.items.filter((i) => (level === 'all' || i.level === level) && (!filter || (i.where + ' ' + i.message + ' ' + i.area).toLowerCase().includes(filter)));
    const cls = (l) => (l === 'error' ? 'err' : l === 'warning' ? 'warn' : 'muted');
    $('app').innerHTML = `<p><strong class="${s.errors ? 'err' : 'ok'}">${n(s.errors)} errors</strong>, <strong class="${s.warnings ? 'warn' : ''}">${n(s.warnings)} warnings</strong>, ${n(s.infos)} notes in ${esc(d.title)}. ${n(s.layers)} layers, ${n(s.assets)} asset paths (${n(s.missingAssets)} missing), ${n(s.meshes)} meshes, ${n(s.triangles)} triangles.</p>
<p><select id="level"><option value="all">All levels</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Notes</option></select> <input id="filter" type="search" placeholder="Filter by path or text" value="${esc(filter)}"></p>
<table class="grid"><thead><tr><th>Level</th><th>Area</th><th>Where</th><th>What</th></tr></thead><tbody>
${items.map((i) => `<tr><td class="${cls(i.level)}">${esc(i.level)}</td><td>${esc(i.area)}</td><td><code>${esc(i.where)}</code></td><td>${esc(i.message)}</td></tr>`).join('') || '<tr><td colspan="4" class="ok">Nothing to report.</td></tr>'}
</tbody></table>
<h3>Layers (${n(d.layers.length)})</h3>
<table class="grid"><thead><tr><th>Layer</th><th>Format</th><th>Status</th></tr></thead><tbody>${d.layers.map((l) => `<tr><td><code>${esc(l.layer)}</code></td><td>${esc(l.kind)}</td><td class="${l.status === 'opened' ? 'ok' : 'err'}">${esc(l.status)}</td></tr>`).join('')}</tbody></table>
<h3>Asset paths (${n(d.textures.length)})</h3>
<table class="grid"><thead><tr><th>Asset</th><th>Used by</th><th>Layer</th><th>Found</th></tr></thead><tbody>${d.textures.map((t) => `<tr><td><code>${esc(t.asset)}</code></td><td><code>${esc(t.prim + '.' + t.prop)}</code></td><td>${esc(t.layer)}</td><td class="${t.found ? 'ok' : 'err'}">${t.found ? 'yes' : 'no, ' + esc(t.note)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No asset-valued attributes.</td></tr>'}</tbody></table>`;
    $('level').value = level;
    $('level').onchange = () => { level = $('level').value; renderCheck(d); };
    const f = $('filter');
    f.oninput = () => { filter = f.value.toLowerCase(); const pos = f.selectionStart; renderCheck(d); const g = $('filter'); g.focus(); g.setSelectionRange(pos, pos); };
  }

  function renderCompare(d) {
    $('actions').innerHTML = '<button class="tb" data-id="md">Save Markdown</button>';
    const ch = d.changed.filter((c) => !filter || (c.path + ' ' + c.field + ' ' + c.detail).toLowerCase().includes(filter));
    const same = !d.added.length && !d.removed.length && !d.changed.length;
    $('app').innerHTML = `<p><code>${esc(d.a)}</code> (${esc(d.formatA)}, ${n(d.primsA)} prims) and <code>${esc(d.b)}</code> (${esc(d.formatB)}, ${n(d.primsB)} prims): ${same ? '<strong class="ok">no differences</strong>.' : `<strong>${n(d.added.length)}</strong> prims added, <strong>${n(d.removed.length)}</strong> removed, <strong>${n(d.changed.length)}</strong> changes; ${n(d.same)} prims unchanged.`}</p>
${d.added.length ? `<h3>Added prims</h3><ul>${d.added.slice(0, 2000).map((p) => `<li><code>${esc(p)}</code></li>`).join('')}</ul>` : ''}
${d.removed.length ? `<h3>Removed prims</h3><ul>${d.removed.slice(0, 2000).map((p) => `<li><code>${esc(p)}</code></li>`).join('')}</ul>` : ''}
${d.changed.length ? `<h3>Changes</h3><p><input id="filter" type="search" placeholder="Filter by path or text" value="${esc(filter)}"></p>
<table class="grid"><thead><tr><th>Path</th><th>What</th><th>Change</th></tr></thead><tbody>${ch.slice(0, 5000).map((c) => `<tr><td><code>${esc(c.path)}</code></td><td>${esc(c.field)}</td><td>${esc(c.detail)}</td></tr>`).join('')}</tbody></table>` : ''}`;
    const f = $('filter');
    if (f) f.oninput = () => { filter = f.value.toLowerCase(); const pos = f.selectionStart; renderCompare(d); const g = $('filter'); g.focus(); g.setSelectionRange(pos, pos); };
  }

  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('button[data-id]');
    if (b) vscode.postMessage({ type: 'action', id: b.getAttribute('data-id') });
  });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'data') return;
    data = m.data;
    filter = ''; level = 'all';
    $('title').textContent = data.kind === 'check' ? 'Stage check' : 'Compare USD files';
    $('actions').textContent = '';
    if (data.kind === 'check') renderCheck(data);
    else if (data.kind === 'compare') renderCompare(data);
    requestAnimationFrame(() => vscode.postMessage({ type: 'shown' }));
  });
  vscode.postMessage({ type: 'ready' });
})();
