// USD Viewer webview: prim tree, details panel and a WebGL2 3D view (orbit, pan, zoom, wireframe, highlight of the
// selected prim). Gets 'meta', 'geom' and 'prim' messages from the extension host; loads nothing remote.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
  const state = vscode.getState() || {};
  let meta = null, rows = [], paths = [], open = new Set(state.open || []), selected = state.selected || '', filter = '';
  let showPanels = state.panels !== false, wire = !!state.wire, shaded = state.shaded !== false;
  let highlight = !!state.highlight; // only after the user picked a prim, not for the first prim shown on open

  // ---------- footer ----------
  const ft = document.getElementById('zovo-footer');
  if (ft && ft.innerHTML.trim()) $('footer').innerHTML = ft.innerHTML;

  // ---------- tree ----------
  function buildPaths() {
    paths = new Array(rows.length);
    const stack = [];
    for (let i = 0; i < rows.length; i++) {
      const [name, , depth] = rows[i];
      stack.length = depth;
      const parent = depth ? paths[stack[depth - 1]] : '';
      paths[i] = parent + '/' + name;
      stack[depth] = i;
    }
  }
  function hasKids(i) { return i + 1 < rows.length && rows[i + 1][2] > rows[i][2]; }
  function visibleRows() {
    const out = [];
    if (filter) {
      const keep = new Set();
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if ((r[0] + ' ' + r[1]).toLowerCase().includes(filter)) { keep.add(i); let d = r[2]; for (let j = i - 1; j >= 0 && d > 0; j--) if (rows[j][2] < d) { keep.add(j); d = rows[j][2]; } }
      }
      for (let i = 0; i < rows.length; i++) if (keep.has(i)) out.push(i);
      return out.slice(0, 3000);
    }
    for (let i = 0; i < rows.length; i++) {
      out.push(i);
      if (hasKids(i) && !open.has(paths[i])) { const d = rows[i][2]; while (i + 1 < rows.length && rows[i + 1][2] > d) i++; }
      if (out.length >= 5000) break;
    }
    return out;
  }
  const BADGE = { r: ['ref', 'Has a reference or payload'], v: ['var', 'Has variant sets'], i: ['off', 'Inactive (active = false)'], c: ['class', 'A class prim (not drawn)'], o: ['over', 'Only an over (not defined)'], x: ['!', 'A reference, payload or sublayer could not be opened'] };
  function renderTree() {
    const vis = visibleRows();
    const html = vis.map((i) => {
      const [name, type, depth, flags] = rows[i];
      const p = paths[i];
      const kids = hasKids(i);
      const tw = kids && !filter ? `<span class="tw" data-tw="${i}">${open.has(p) ? '▾' : '▸'}</span>` : '<span class="tw"></span>';
      const badges = [...flags].filter((f) => BADGE[f]).map((f) => `<span class="badge b-${f}" title="${BADGE[f][1]}">${BADGE[f][0]}</span>`).join('');
      return `<div class="row${p === selected ? ' sel' : ''}${flags.includes('g') ? ' geo' : ''}" role="treeitem" data-i="${i}" data-d="${depth}">${tw}<span class="nm">${esc(name)}</span><span class="ty">${esc(type)}</span>${badges}</div>`;
    }).join('');
    $('tree').innerHTML = html + (meta && meta.treeTruncated ? '<div class="muted pad">The tree shows the first 60,000 prims.</div>' : '');
    for (const el of $('tree').querySelectorAll('.row')) el.style.paddingLeft = (6 + Number(el.getAttribute('data-d')) * 14) + 'px';
  }
  $('tree').addEventListener('click', (e) => {
    const tw = e.target.closest('[data-tw]');
    if (tw) { const i = Number(tw.getAttribute('data-tw')); const p = paths[i]; if (open.has(p)) open.delete(p); else open.add(p); save(); renderTree(); return; }
    const row = e.target.closest('.row');
    if (row) select(paths[Number(row.getAttribute('data-i'))]);
  });
  $('tree').addEventListener('dblclick', (e) => { const row = e.target.closest('.row'); if (row) { select(paths[Number(row.getAttribute('data-i'))]); fitTo(selected); } });
  $('tree').addEventListener('keydown', (e) => {
    const vis = visibleRows();
    let k = vis.findIndex((i) => paths[i] === selected);
    if (e.key === 'ArrowDown') { k = Math.min(vis.length - 1, k + 1); select(paths[vis[k]]); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { k = Math.max(0, k - 1); select(paths[vis[k]]); e.preventDefault(); }
    else if (e.key === 'ArrowRight' && k >= 0) { open.add(selected); save(); renderTree(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' && k >= 0) { open.delete(selected); save(); renderTree(); e.preventDefault(); }
  });
  $('search').addEventListener('input', () => { filter = $('search').value.trim().toLowerCase(); renderTree(); });

  function select(p) {
    if (!p) return;
    selected = p;
    highlight = true;
    // open the ancestors so the row shows
    let a = p;
    while ((a = a.slice(0, a.lastIndexOf('/')))) open.add(a);
    save();
    renderTree();
    const el = $('tree').querySelector('.row.sel');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    vscode.postMessage({ type: 'prim', path: p });
    $('sel').textContent = p;
    draw();
  }
  function save() { vscode.setState({ open: [...open].slice(0, 2000), selected, panels: showPanels, wire, shaded, highlight }); }

  // ---------- details ----------
  function renderInfo(info) {
    if (!info) { $('info').innerHTML = '<p class="muted pad">Select a prim in the tree.</p>'; return; }
    const kv = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
    let h = `<div class="pathline"><code id="primPath">${esc(info.path)}</code> <button class="link" id="copyPath" title="Copy the prim path">Copy</button></div>`;
    h += '<table class="kv">';
    h += kv('Type', esc(info.type || '(no type)'));
    h += kv('Specifier', esc(info.specifier || ''));
    if (info.triangles) h += kv('Triangles', fmtN(info.triangles));
    h += kv('Children', `${fmtN(info.children)}${info.descendants > info.children ? ` (${fmtN(info.descendants)} below)` : ''}`);
    for (const [k, v] of info.meta) h += kv(k, `<code>${esc(v)}</code>`);
    h += kv('Layers', esc(info.layers.join(', ')));
    h += '</table>';
    if (info.arcs.length) h += '<h4>Composition</h4><ul class="arcs">' + info.arcs.map((a) => `<li class="${a.ok ? '' : 'bad'}"><b>${esc(a.kind)}</b> <code>${esc(a.target)}</code>${a.ok ? '' : ` <span class="warn">${esc(a.error)}</span>`}</li>`).join('') + '</ul>';
    if (info.variantSets.length) h += '<h4>Variant sets</h4><ul class="arcs">' + info.variantSets.map((v) => `<li><b>${esc(v.name)}</b> = ${v.selection ? `<code>${esc(v.selection)}</code>` : '<span class="muted">(none selected)</span>'} <span class="muted">of ${esc(v.choices.join(', '))}</span></li>`).join('') + '</ul>';
    h += `<h4>Properties (${info.props.length})</h4><table class="props"><tbody>`;
    for (const p of info.props) {
      let v = p.value ? `<code>${esc(p.value)}</code>` : '';
      if (p.count !== undefined) v = `<span class="muted">${fmtN(p.count)} values</span> ${v}`;
      if (p.samples) v += ` <span class="chip small" title="Time samples">${fmtN(p.samples)} samples</span>`;
      if (p.connect) v += ` <span class="muted">connects to</span> <code>${esc(p.connect)}</code>`;
      if (p.targets) v += ` <span class="muted">targets</span> <code>${esc(p.targets)}</code>`;
      if (p.meta) v += `<div class="muted small">${esc(p.meta)}</div>`;
      h += `<tr><th title="${esc(p.type)}">${esc(p.name)}<div class="ty">${esc(p.type)}</div></th><td>${v}</td></tr>`;
    }
    h += '</tbody></table>';
    $('info').innerHTML = h;
  }
  let noteClosed = false;
  $('viewNote').addEventListener('click', (e) => { if (e.target.id === 'noteClose') { noteClosed = true; $('viewNote').hidden = true; } });
  $('info').addEventListener('click', (e) => { if (e.target.id === 'copyPath') vscode.postMessage({ type: 'copy', text: selected }); });

  function renderSummary() {
    const s = meta.stats;
    $('fmt').textContent = meta.fmt;
    $('stats').textContent = `${fmtN(s.prims)} prims · ${fmtN(s.meshes)} meshes · ${fmtN(s.triangles)} triangles${s.layers > 1 ? ` · ${fmtN(s.layers)} layers` : ''}${s.missing.length ? ` · ${s.missing.length} not found` : ''} · ${meta.metersSet ? `${meta.metersPerUnit} m per unit` : 'units not set'}`;
    $('upBtn').textContent = `${meta.upAxis} up`;
    $('filesBtn').hidden = !meta.files;
    const notes = [];
    const byReason = new Map();
    for (const m of s.missing) byReason.set(m.error, (byReason.get(m.error) || []).concat(m.id));
    for (const [why, ids] of byReason) notes.push(`Not opened (${why}): ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ` and ${ids.length - 3} more` : ''}.`);
    if (meta.skipped.length) notes.push(`Not drawn: ${meta.skipped.join(', ')}.`);
    for (const w of meta.warnings.slice(0, 4)) notes.push(w);
    const vn = $('viewNote');
    vn.hidden = !notes.length || noteClosed;
    vn.innerHTML = `<button class="link close" id="noteClose" title="Hide this note">×</button>${notes.map((x) => `<div>${esc(x)}</div>`).join('')}`;
  }

  function renderFiles() {
    if (!meta.files) return;
    const h = '<h4>Files in the package</h4><table class="props"><tbody>' + meta.files.map((f, i) => `<tr><th>${esc(f.name)}${i === 0 ? ' <span class="chip small">root</span>' : ''}</th><td>${fmtN(f.size)} bytes${f.method ? ' <span class="warn">compressed</span>' : ''}${f.aligned ? '' : ' <span class="warn">not 64-byte aligned</span>'}${/\.(usda|usdc|usd)$/i.test(f.name) ? ` <button class="link" data-entry="${esc(f.name)}">USDA text</button>` : ''}</td></tr>`).join('') + '</tbody></table>';
    $('info').innerHTML = h;
  }
  $('info').addEventListener('click', (e) => { const b = e.target.closest('[data-entry]'); if (b) vscode.postMessage({ type: 'text', entry: b.getAttribute('data-entry') }); });

  // ---------- toolbar ----------
  $('fitBtn').onclick = () => fitTo('');
  $('wireBtn').onclick = () => { wire = !wire; save(); syncButtons(); draw(); };
  $('shadeBtn').onclick = () => { shaded = !shaded; if (!shaded && !wire) wire = true; save(); syncButtons(); draw(); };
  $('upBtn').onclick = () => { cam.up = cam.up === 'Y' ? 'Z' : 'Y'; $('upBtn').textContent = `${cam.up} up`; fitTo(''); };
  $('textBtn').onclick = () => vscode.postMessage({ type: 'text' });
  $('filesBtn').onclick = () => renderFiles();
  $('infoBtn').onclick = () => { showPanels = !showPanels; save(); syncButtons(); resize(); };
  function syncButtons() {
    $('wireBtn').setAttribute('aria-pressed', String(wire));
    $('shadeBtn').setAttribute('aria-pressed', String(shaded));
    $('infoBtn').setAttribute('aria-pressed', String(showPanels));
    document.body.classList.toggle('nopanels', !showPanels);
  }
  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'f') fitTo(selected && e.shiftKey ? selected : '');
    else if (k === 'w') $('wireBtn').click();
    else if (k === 's') $('shadeBtn').click();
    else if (k === 't') $('textBtn').click();
    else if (k === 'i') $('infoBtn').click();
    else return;
    e.preventDefault();
  });

  // ---------- WebGL ----------
  const canvas = $('gl');
  const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
  let geom = null, buf = null, prog = null, lineProg = null;
  const cam = { yaw: 0.7, pitch: 0.45, dist: 5, target: [0, 0, 0], up: 'Y', radius: 1 };
  if (!gl) { $('viewNote').hidden = false; $('viewNote').textContent = 'This editor has no WebGL2, so the 3D view is off. The tree and the details still work.'; }

  function shader(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  function program(vs, fs) { const p = gl.createProgram(); gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; }
  if (gl) {
    prog = program(`#version 300 es
in vec3 aPos; in vec3 aCol; uniform mat4 uView; uniform mat4 uProj; out vec3 vCol; out vec3 vView;
void main() { vec4 v = uView * vec4(aPos, 1.0); vView = v.xyz; vCol = aCol; gl_Position = uProj * v; }`, `#version 300 es
precision highp float; in vec3 vCol; in vec3 vView; uniform vec3 uTint; uniform float uMix; out vec4 o;
void main() { vec3 n = normalize(cross(dFdx(vView), dFdy(vView))); vec3 l = normalize(vec3(0.35, 0.55, 1.0));
  float d = abs(dot(n, l)); float hd = abs(n.z); vec3 c = mix(vCol, uTint, uMix);
  float lit = 0.28 + 0.52 * d + 0.25 * hd; lit = mix(lit, max(lit, 0.78), uMix);
  o = vec4(c * lit, 1.0); }`);
    lineProg = program(`#version 300 es
in vec3 aPos; uniform mat4 uView; uniform mat4 uProj; void main() { gl_Position = uProj * uView * vec4(aPos, 1.0); }`, `#version 300 es
precision highp float; uniform vec4 uColor; out vec4 o; void main() { o = uColor; }`);
  }

  function upload(g) {
    geom = g;
    if (!gl) return;
    if (buf) for (const b of Object.values(buf)) if (b) gl.deleteBuffer(b);
    buf = {};
    if (!g.positions || !g.positions.length) { draw(); return; }
    buf.pos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf.pos); gl.bufferData(gl.ARRAY_BUFFER, g.positions, gl.STATIC_DRAW);
    buf.col = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf.col); gl.bufferData(gl.ARRAY_BUFFER, g.colors, gl.STATIC_DRAW);
    buf.tri = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.tri); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.tri, gl.STATIC_DRAW);
    buf.lin = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.lin); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.lines, gl.STATIC_DRAW);
    buf.triCount = g.tri.length; buf.linCount = g.lines.length;
  }

  // matrices (column-major for WebGL)
  function perspective(fovy, aspect, near, far) { const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far); return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]; }
  function lookAt(eye, at, up) {
    let zx = eye[0] - at[0], zy = eye[1] - at[1], zz = eye[2] - at[2]; let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx; l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * eye[0] + xy * eye[1] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1];
  }
  function eye() {
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const d = cam.up === 'Z' ? [cp * sy, -cp * cy, sp] : [cp * sy, sp, cp * cy];
    return [cam.target[0] + d[0] * cam.dist, cam.target[1] + d[1] * cam.dist, cam.target[2] + d[2] * cam.dist];
  }
  function fitTo(p) {
    let b = geom && geom.bounds;
    if (p && geom && geom.ranges[p] && geom.positions) {
      // bounds of the selected prim's triangles
      const r = geom.ranges[p];
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = r[0] * 3; i < (r[0] + r[1]) * 3; i++) { const v = geom.tri[i] * 3; for (let k = 0; k < 3; k++) { const x = geom.positions[v + k]; if (x < mn[k]) mn[k] = x; if (x > mx[k]) mx[k] = x; } }
      if (Number.isFinite(mn[0])) b = [mn, mx];
    }
    if (!b) { draw(); return; }
    cam.target = [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, (b[0][2] + b[1][2]) / 2];
    cam.radius = Math.max(1e-6, Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]) / 2);
    const fy = (45 * Math.PI) / 180, aspect = Math.max(0.1, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    const fx = 2 * Math.atan(Math.tan(fy / 2) * aspect);
    cam.dist = (cam.radius / Math.sin(Math.min(fy, fx) / 2)) * 1.02;
    draw();
  }
  let pending = false;
  function draw() { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; render(); }); } }
  function render() {
    if (!gl) return;
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    gl.viewport(0, 0, canvas.width, canvas.height);
    const dark = document.body.classList.contains('vscode-light') ? false : true;
    gl.clearColor(dark ? 0.12 : 0.93, dark ? 0.13 : 0.94, dark ? 0.15 : 0.96, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!buf || !buf.pos) return;
    gl.enable(gl.DEPTH_TEST);
    const near = Math.max(cam.dist - cam.radius * 4, cam.dist / 1000, 1e-6), far = cam.dist + cam.radius * 4 + 1e-6;
    const proj = perspective((45 * Math.PI) / 180, Math.max(1e-3, w / Math.max(1, h)), near, far);
    const view = lookAt(eye(), cam.target, cam.up === 'Z' ? [0, 0, 1] : [0, 1, 0]);
    const sel = highlight && selected && geom.ranges[selected];
    if (shaded) {
      gl.useProgram(prog);
      gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uView'), false, view);
      gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uProj'), false, proj);
      const aPos = gl.getAttribLocation(prog, 'aPos'), aCol = gl.getAttribLocation(prog, 'aCol');
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.pos); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.col); gl.enableVertexAttribArray(aCol); gl.vertexAttribPointer(aCol, 3, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.tri);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
      gl.uniform3f(gl.getUniformLocation(prog, 'uTint'), 0.15, 0.55, 1.0);
      gl.uniform1f(gl.getUniformLocation(prog, 'uMix'), 0);
      gl.drawElements(gl.TRIANGLES, buf.triCount, gl.UNSIGNED_INT, 0);
      if (sel && sel[1]) { gl.depthFunc(gl.LEQUAL); gl.uniform1f(gl.getUniformLocation(prog, 'uMix'), 0.8); gl.drawElements(gl.TRIANGLES, sel[1] * 3, gl.UNSIGNED_INT, sel[0] * 12); gl.depthFunc(gl.LESS); }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disableVertexAttribArray(aCol);
    }
    if (wire && buf.linCount) {
      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, 'uView'), false, view);
      gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, 'uProj'), false, proj);
      const aPos = gl.getAttribLocation(lineProg, 'aPos');
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.pos); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.lin);
      gl.uniform4f(gl.getUniformLocation(lineProg, 'uColor'), dark ? 0.75 : 0.2, dark ? 0.78 : 0.22, dark ? 0.82 : 0.26, 1);
      gl.drawElements(gl.LINES, buf.linCount, gl.UNSIGNED_INT, 0);
      if (sel && sel[3]) { gl.uniform4f(gl.getUniformLocation(lineProg, 'uColor'), 0.25, 0.6, 1, 1); gl.depthFunc(gl.LEQUAL); gl.drawElements(gl.LINES, sel[3] * 2, gl.UNSIGNED_INT, sel[2] * 8); gl.depthFunc(gl.LESS); }
    }
  }
  function resize() { draw(); }
  window.addEventListener('resize', resize);

  // orbit, pan, zoom
  let drag = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.button === 1 || e.shiftKey }; canvas.focus(); });
  window.addEventListener('mouseup', () => { drag = null; });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) {
      const v = lookAt(eye(), cam.target, cam.up === 'Z' ? [0, 0, 1] : [0, 1, 0]);
      const s = (cam.dist * Math.tan((45 * Math.PI) / 360) * 2) / Math.max(1, canvas.clientHeight);
      for (let k = 0; k < 3; k++) cam.target[k] += (-dx * v[k * 4] + dy * v[k * 4 + 1]) * s;
    } else {
      cam.yaw -= dx * 0.008;
      cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch + dy * 0.008));
    }
    draw();
  });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist *= Math.exp(e.deltaY * 0.0015); cam.dist = Math.max(cam.radius * 0.01, Math.min(cam.radius * 200, cam.dist)); draw(); }, { passive: false });
  canvas.addEventListener('dblclick', () => fitTo(''));
  if (window.ResizeObserver) new ResizeObserver(() => draw()).observe(canvas);

  // ---------- messages ----------
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'meta') {
      meta = m;
      if (m.error) {
        $('err').hidden = false; $('err').textContent = m.error;
        $('main').hidden = true;
        return;
      }
      $('err').hidden = true; $('main').hidden = false;
      rows = m.tree || [];
      buildPaths();
      if (!state.open) { for (let i = 0; i < rows.length; i++) if (rows[i][2] < 2 && hasKids(i)) open.add(paths[i]); }
      cam.up = m.upAxis === 'Z' ? 'Z' : 'Y';
      renderSummary();
      renderTree();
      if (!selected || !paths.includes(selected)) {
        const dp = m.defaultPrim ? '/' + String(m.defaultPrim).replace(/^\//, '') : '';
        selected = (dp && paths.includes(dp) && dp) || paths.find((p, i) => rows[i][2] === 0 && !rows[i][3].includes('c')) || paths[0] || '';
      }
      if (selected) vscode.postMessage({ type: 'prim', path: selected }); else renderInfo(null);
      $('sel').textContent = selected;
    } else if (m.type === 'geom') {
      upload(m);
      fitTo('');
      document.body.setAttribute('data-ready', '1');
    } else if (m.type === 'prim') {
      renderInfo(m.info);
    }
  });
  syncButtons();
  vscode.postMessage({ type: 'ready' });
})();
