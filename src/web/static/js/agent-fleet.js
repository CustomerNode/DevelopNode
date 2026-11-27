/* Where agents are: a 3D file tree of every project, with each agent and its
 * helpers (subagents) on the file it is working in.
 *
 * Opened from the view selector on the rail (js/view-rail.js); on a phone,
 * from the More menu beside the session counts.  All projects sit at the
 * top; each folder level is one floor lower; a file an agent touched is a
 * sheet, an agent is a ball under the file it is on, a helper has its agent's
 * colour.  Hover shows a path, a click opens it beside the tree: a file's
 * contents and the edits agents made to it, or an agent's session, files and
 * edits.  Minus and plus show fewer or more levels, past what agents touched
 * into the real folders; a folder can be isolated and has its own minus and
 * plus.
 *
 * Data: GET /api/agent-fleet, /api/agent-fleet/dirs and /api/agent-fleet/file
 * (src/web/routes/fleet_api.py).  The 3D library (static/vendor/three) is
 * loaded on first open, never at startup.  Colours are read from the theme's
 * CSS variables when the view opens.
 */
(function () {
  'use strict';
  let THREE = null, OrbitControls = null, CSS2DRenderer = null, CSS2DObject = null;
  let el = null, S = null, DATA = null, W = {}, projects = [], timer = null, all = null;
  let nodes = {}, links = {}, wobj = {}, hot = [], tip = null, C = null, DARK = true, AGL = 66;
  const DIRS = {}, LISTED = {}, FILES = {};      // folder listings and file text, kept while the page is open
  const EXTRA = 4, R = 11, H = 7.5, REFRESH_MS = 20000;
  const HUES = [190, 300, 150, 35, 340, 215, 60, 265, 110, 320, 170, 10, 235, 85];
  const st = { reset() { this.live = false; this.sel = null; this.tab = ''; this.shut = new Set(); this.root = 'F'; this.only = null; this.full = new Set(); this.rotate = false; this.fd = {}; this.lvOf = {}; }, fresh: true };
  st.reset();

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cut = (s, n) => s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const ago = ts => { if (!ts) return ''; const s = Math.max(0, Date.now() / 1000 - ts); return s < 90 ? 'now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
  const colCss = w => `hsl(${w.hue}, 78%, ${AGL + (w.isHelper ? 8 : 0)}%)`;
  const col3 = w => new THREE.Color(colCss(w));
  const here = w => w.files[0] || '';
  const statusWord = w => w.live ? 'Working now' : w.group === 'needs_you' ? 'Needs you' : w.isHelper ? 'Finished' : 'Done';
  const nid = n => n.fleet ? 'F' : n.proj.id + '|' + n.path;
  const fkey = (p, f) => p.id + '|' + f;
  const find = (n, id) => { if (nid(n) === id) return n; for (const k of n.kids) { const r = find(k, id); if (r) return r; } return null; };
  const inside = n => { const o = [...n.here]; n.kids.forEach(k => o.push(...inside(k))); return o; };
  const workersOf = (p, liveOnly) => { const o = []; p.agents.forEach(a => { if (liveOnly && !a.live && !a.helpers.some(h => h.live)) return; o.push(a); a.helpers.forEach(h => { if (!liveOnly || h.live || a.live) o.push(h); }); }); return o; };
  const keepFn = () => st.only ? (w => w.key === st.only || (w.isHelper && w.boss.key === st.only)) : null;
  const editsOf = (p, f) => { const o = []; workersOf(p, false).forEach(w => (w.edits && w.edits[f] || []).forEach(e => o.push({ w, e }))); return o.sort((x, y) => (y.e.ts || 0) - (x.e.ts || 0)); };
  function say(t) { if (typeof showToast === 'function') showToast(t); }

  /* ---------- the tree: all projects > project > folders > files ---------- */
  function fileTree(p, live, keep) {
    const root = { name: p.name, path: '', proj: p, kids: [], here: [], isProj: true };
    workersOf(p, live).filter(w => !keep || keep(w)).forEach(w => {
      if (!w.files.length) { root.here.push(w); return; }
      w.files.forEach((f, i) => {
        let n = root; const parts = f.split('/'), base = parts.pop();
        parts.forEach(part => { let k = n.kids.find(x => x.seg === part && !x.file); if (!k) { k = { seg: part, name: part, path: (n.path ? n.path + '/' : '') + part, proj: p, kids: [], here: [] }; n.kids.push(k); } n = k; });
        let leaf = n.kids.find(x => x.file && x.seg === base); if (!leaf) { leaf = { seg: base, name: base, path: f, proj: p, kids: [], here: [], file: true, touch: [] }; n.kids.push(leaf); }
        leaf.touch.push(w); if (i === 0) leaf.here.push(w);
      });
    });
    // A chain of folders with nothing of their own reads as one step: src/web/static.
    (function cz(n) { n.kids = n.kids.map(k => { while (!k.file && !k.here.length && k.kids.length === 1 && !k.kids[0].file) { const c = k.kids[0]; c.name = k.name + '/' + c.name; k = c; } cz(k); return k; }); n.kids.sort((a, b) => (a.file ? 1 : 0) - (b.file ? 1 : 0)); })(root);
    return root;
  }
  /* Adds what is really in a folder (files and folders no agent touched), fainter. */
  function grow(n, full, fd, r, bud) {
    if (n.file) return; const id = nid(n); if (fd[id] != null) r = fd[id];
    if ((full.has(id) || r > 0) && bud[0] > 0) { const L = (DIRS[n.proj.id] || {})[n.path];
      if (L) { const at = name => (n.path ? n.path + '/' : '') + name;
        L.d.forEach(name => { if (bud[0]-- > 0 && !n.kids.some(x => !x.file && (x.seg === name || x.name.split('/')[0] === name))) n.kids.push({ seg: name, name, path: at(name), proj: n.proj, kids: [], here: [], ghost: true }); });
        L.f.slice(0, 40).forEach(name => { if (bud[0]-- > 0 && !n.kids.some(x => x.file && x.seg === name)) n.kids.push({ seg: name, name, path: at(name), proj: n.proj, kids: [], here: [], file: true, touch: [], ghost: true }); });
        n.kids.sort((a, b) => (a.file ? 1 : 0) - (b.file ? 1 : 0)); } }
    n.kids.forEach(k => grow(k, full, fd, r > 0 ? r - 1 : 0, bud));
  }
  function fleetFiles(live, keep, full, fd) {
    const f = { fleet: true, name: 'All projects', path: '', kids: projects.map(p => fileTree(p, live, keep)), here: [] };
    if (full) { const bud = [1400], m = fd || {}; f.kids.forEach(k => grow(k, full, m, m.F || 0, bud)); }
    (function cnt(n, par) { n.parent = par; n.count = n.here.length; n.wt = (n.file ? (n.ghost ? .3 : 1) : 0) + n.here.length * .6; n.kids.forEach(k => { cnt(k, n); n.count += k.count; n.wt += k.wt; }); n.wt = Math.max(n.wt, n.ghost ? .4 : 1); })(f, null);
    f.kids = f.kids.filter(k => k.count || k.kids.length);
    return f;
  }
  /* Every folder gets a slice of the circle sized by what hangs under it. */
  function cone(n, a0, a1, d) { n.a0 = a0; n.a1 = a1; n.dd = d; let a = a0; const tot = n.kids.reduce((s, k) => s + k.wt, 0) + n.here.length * .6 || 1; n.kids.forEach(k => { const sp = (a1 - a0) * k.wt / tot; cone(k, a, a + sp, d + 1); a += sp; }); n.h0 = a; n.h1 = a1; }

  /* ---------- levels: one number per folder, from closed, through what agents touched, on into the real files ---------- */
  const th = n => { const k = n.kids.filter(x => !x.ghost); return k.length ? 1 + Math.max(...k.map(th)) : 0; };
  const under = (k, id) => id === 'F' || k === id || k.indexOf(id.slice(-1) === '|' ? id : id + '/') === 0;
  const levelOf = (id, n) => st.lvOf[id] != null ? st.lvOf[id] : (st.shut.has(id) && id !== st.root ? 0 : th(n));
  const zl = id => { const n = all && find(all, id); if (!n) return ''; const td = th(n), cur = levelOf(id, n); return 'Level ' + cur + ' of ' + (td + EXTRA) + (cur > td ? ' &middot; all files' : ''); };
  function step(id, dir) {
    const pre = fleetFiles(st.live, keepFn()), n = find(pre, id) || pre; id = nid(n);
    const td = th(n), L = Math.max(id === st.root ? 1 : 0, Math.min(td + EXTRA, levelOf(id, n) + dir));
    [...st.shut].forEach(k => { if (under(k, id)) st.shut.delete(k); }); [...st.full].forEach(k => { if (under(k, id)) st.full.delete(k); });
    Object.keys(st.fd).forEach(k => { if (under(k, id)) delete st.fd[k]; }); Object.keys(st.lvOf).forEach(k => { if (under(k, id)) delete st.lvOf[k]; });
    st.lvOf[id] = L;
    if (L < td) (function g(m, d) { if (!m.file && m.kids.length && d === L) { st.shut.add(nid(m)); return; } m.kids.forEach(k => g(k, d + 1)); })(n, 0);
    else if (L > td) st.fd[id] = L - td;
  }
  /* Fetches the folder listings the current levels need; resolves when they are in. */
  async function listFor(p, path, depth) {
    const key = p.id + '|' + path; if ((LISTED[key] || 0) >= depth) return;
    try {
      const r = await fetch('/api/agent-fleet/dirs?project=' + encodeURIComponent(p.id) + '&path=' + encodeURIComponent(path) + '&depth=' + depth);
      const d = r.ok ? await r.json() : null;
      if (d && d.ok) { DIRS[p.id] = Object.assign(DIRS[p.id] || {}, d.dirs); LISTED[key] = depth; }
    } catch (_e) { /* the tree stays as it is */ }
  }
  async function ensureDirs() {
    const jobs = [], one = (id, depth) => { if (id === 'F') { projects.forEach(p => jobs.push(listFor(p, '', depth))); return; } const i = id.indexOf('|'), p = projects.find(x => x.id === id.slice(0, i)); if (p) jobs.push(listFor(p, id.slice(i + 1), depth)); };
    Object.keys(st.fd).forEach(id => one(id, Math.min(EXTRA, st.fd[id]))); st.full.forEach(id => one(id, 1));
    await Promise.all(jobs);
  }

  /* ---------- the 3D stage ---------- */
  function stage(host) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const lr = new CSS2DRenderer(); lr.domElement.className = 'af-labels';
    host.append(renderer.domElement, lr.domElement);
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(42, 1, .1, 4000);
    const ctl = new OrbitControls(cam, renderer.domElement); ctl.enableDamping = true; ctl.dampingFactor = .08; ctl.autoRotateSpeed = .5;
    scene.add(new THREE.AmbientLight(0xffffff, DARK ? 1.3 : 2.1)); const dl = new THREE.DirectionalLight(0xffffff, DARK ? 2.2 : 1.6); dl.position.set(40, 80, 50); scene.add(dl);
    const root = new THREE.Group(); scene.add(root);
    const api = { root, cam, ctl, canvas: renderer.domElement, picks: [], ticks: [], onPick: null, alive: true };
    function size() { const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; renderer.setSize(w, h); lr.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    const ro = new ResizeObserver(size); ro.observe(host); size();
    const clock = new THREE.Clock();
    (function loop() { if (!api.alive) return; requestAnimationFrame(loop); const dt = Math.min(clock.getDelta(), .05); if (document.hidden) return; api.ticks.forEach(f => f(dt)); ctl.update(); renderer.render(scene, cam); lr.render(scene, cam); })();
    // A label lives in the page, not in the scene: take its element out with it.
    api.clear = () => { root.traverse(o => { if (o.element && o.element.remove) o.element.remove(); }); root.clear(); api.picks = []; api.ticks = []; };
    api.label = (html, cls) => { const d = document.createElement('div'); d.className = 'af-l ' + (cls || ''); d.innerHTML = html; return new CSS2DObject(d); };
    api.view = (pos, target) => { cam.position.copy(pos); ctl.target.copy(target); ctl.update(); };
    api.screenOf = o => { const v = new THREE.Vector3(); o.getWorldPosition(v); v.project(cam); const r = renderer.domElement.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; };
    api.hit = e => { const r = renderer.domElement.getBoundingClientRect(), ray = api.ray || (api.ray = new THREE.Raycaster()); ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), cam); const h = ray.intersectObjects(api.picks, false)[0]; return h ? h.object.userData : null; };
    let down = null;
    renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    renderer.domElement.addEventListener('pointerup', e => { if (!down || Math.abs(e.clientX - down[0]) + Math.abs(e.clientY - down[1]) > 6) return; const u = api.hit(e); if (u && api.onPick) api.onPick(u); });
    api.dispose = () => { api.alive = false; ro.disconnect(); api.clear(); ctl.dispose(); renderer.dispose(); };
    return api;
  }
  const sphere = (r, color, glow) => new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: glow == null ? (DARK ? .55 : .12) : glow, roughness: .35 }));
  const line = (pts, color, op) => new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: op }));
  function agentMesh(w, r, sel) {
    const m = sphere(r, col3(w)); m.userData = { w: w.key }; S.picks.push(m);
    if (w.live) { const halo = new THREE.Mesh(new THREE.SphereGeometry(r * 1.9, 20, 12), new THREE.MeshBasicMaterial({ color: col3(w), transparent: true, opacity: .22 })); m.add(halo); S.ticks.push(() => { halo.scale.setScalar(1 + .25 * Math.sin(performance.now() / 320)); }); }
    if (sel) { const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.8, r * .12, 8, 40), new THREE.MeshBasicMaterial({ color: C.head })); m.add(ring); S.ticks.push(dt => { ring.rotation.x += dt * 1.2; ring.rotation.y += dt * .8; }); }
    return m;
  }

  /* ---------- the reader: what you clicked, beside the tree ---------- */
  const sameSel = (t, k) => st.sel && st.sel.t === t && st.sel.k === k;
  const diffHTML = e => `<pre class="af-diff">${e.old ? e.old.split('\n').map(l => `<span class="m">- ${esc(l)}</span>`).join('\n') + '\n' : ''}${(e.new || '').split('\n').map(l => `<span class="p">+ ${esc(l)}</span>`).join('\n')}</pre>`;
  function fileBlock(p, f) {
    const d = FILES[fkey(p, f)];
    if (!d) return '<div class="af-note">Loading the file…</div>';
    if (d.kind !== 'text') return `<div class="af-note">${{ binary: 'A picture or other file that is not text.', missing: 'This file is not on this computer any more (moved, deleted, or on another machine).', big: 'A large file; only its changes are shown here.' }[d.kind] || 'This file could not be read.'}</div>`;
    return `<pre class="af-code">${d.text.split('\n').map((l, i) => `<i>${i + 1}</i>${esc(l)}`).join('\n')}</pre>${d.total > 600 ? `<div class="af-note">First 600 of ${d.total} lines.</div>` : ''}`;
  }
  const diffsBlock = rows => rows.length ? rows.map(({ w, e, f }) => `<div class="af-dh"><i style="color:${colCss(w)}"></i><a data-af="w" data-v="${esc(w.key)}">${esc(cut(w.name, 30))}</a>${f ? ` &middot; <a data-af="f" data-v="${esc(fkey(w.proj, f))}">${esc(f.split('/').pop())}</a>` : ''}<em>${e.whole ? 'wrote the file' : 'changed'} &middot; ${ago(e.ts)}</em></div>${diffHTML(e)}`).join('') : '<div class="af-note">No changes recorded here lately; it was only read.</div>';
  function sessionBlock(w) {
    const boss = w.isHelper ? w.boss : w;
    return (w.chat && w.chat.length ? w.chat.map(m => `<div class="af-msg ${m.r}"><b>${m.r === 'u' ? (w.isHelper ? 'Its task' : 'You') : esc(cut(w.name, 24))}</b>${esc(m.t)}</div>`).join('') : '<div class="af-note">No messages in the recent part of this session.</div>')
      + `<div class="af-k2">Last steps</div>${w.steps.map(s => `<div class="af-stp"><b>${esc(s.verb || '')}</b> ${s.file && w.files.includes(s.file) ? `<a data-af="f" data-v="${esc(fkey(w.proj, s.file))}">${esc(s.obj || s.file)}</a>` : esc(s.obj || s.file || '')}</div>`).join('') || '<div class="af-stp">Nothing recorded lately</div>'}`
      + `<button class="af-btn" data-af="open" data-v="${esc(boss.proj.id + '|' + boss.id)}">Open the session</button><button class="af-btn" data-af="only" data-v="${esc(boss.key)}">Show only this agent's files in the tree</button>`;
  }
  function reader() {
    const s = st.sel; if (!s) return '';
    let head = '', body = '';
    if (s.t === 'w') { const w = W[s.k]; if (!w) return ''; const boss = w.isHelper ? w.boss : null, ed = []; Object.keys(w.edits || {}).forEach(f => w.edits[f].forEach(e => ed.push({ w, e, f })));
      head = `<div class="af-k">${w.isHelper ? 'Helper' : 'Agent'} &middot; ${esc(w.proj.name)} &middot; ${statusWord(w)} &middot; ${ago(w.last_ts)}</div><h3><i style="color:${colCss(w)}"></i><span>${esc(w.name)}</span></h3>${boss ? `<div class="af-k">Works for <a data-af="w" data-v="${esc(boss.key)}">${esc(boss.name)}</a></div>` : ''}`;
      const files = `<div class="af-k2">Files it touched, newest first</div>${w.files.map((f, i) => `<a class="af-row" data-af="f" data-v="${esc(fkey(w.proj, f))}">${esc(f)}${i ? '' : '<em>now</em>'}${w.edits && w.edits[f] ? `<em>${w.edits[f].length} change${w.edits[f].length > 1 ? 's' : ''}</em>` : ''}</a>`).join('') || '<div class="af-note">No file yet: it only ran commands.</div>'}${!w.isHelper && w.helpers.length ? '<div class="af-k2">Its helpers</div>' + w.helpers.map(h => `<a class="af-row" data-af="w" data-v="${esc(h.key)}"><i style="color:${colCss(h)}"></i>${esc(h.name)}<em>${h.live ? 'working' : ago(h.last_ts)}</em></a>`).join('') : ''}`;
      body = `<div class="af-two"><div><div class="af-k2">Session</div>${sessionBlock(w)}</div><div>${files}<div class="af-k2">Its changes</div>${diffsBlock(ed)}</div></div>`;
    } else if (s.t === 'f') { const i = s.k.indexOf('|'), p = projects.find(x => x.id === s.k.slice(0, i)), f = s.k.slice(i + 1); if (!p) return ''; const ed = editsOf(p, f), who = workersOf(p, false).filter(w => w.files.includes(f));
      head = `<div class="af-k">File &middot; ${esc(p.name)}</div><h3><span class="af-mono">${esc(f.split('/').pop())}</span></h3><div class="af-path">${f.split('/').slice(0, -1).map((x, j, arr) => `<a data-af="d" data-v="${esc(p.id + '|' + arr.slice(0, j + 1).join('/'))}">${esc(x)}</a>`).join(' / ')}</div><div class="af-who">${who.map(w => `<a class="af-chipw" data-af="w" data-v="${esc(w.key)}"><i style="color:${colCss(w)}"></i>${esc(cut(w.name, 22))}${w.files[0] === f ? '<em>here now</em>' : ''}</a>`).join('')}</div>`;
      body = `<div class="af-two"><div><div class="af-k2">The file</div>${fileBlock(p, f)}</div><div><div class="af-k2">Changes agents made to it</div>${diffsBlock(ed)}</div></div>`;
    } else { const n = all && find(all, s.k); if (!n) return ''; const ws = inside(n), fs = []; (function g(m) { if (m.file) fs.push(m); m.kids.forEach(g); })(n);
      head = `<div class="af-k">Folder${n.proj ? ' &middot; ' + esc(n.proj.name) : ''}</div><h3><span class="af-mono">${esc(n.fleet ? 'All projects' : n.isProj ? n.name : n.path + '/')}</span></h3>`;
      body = `<div class="af-k2">Agents in here (${ws.length})</div>${ws.map(w => `<a class="af-row" data-af="w" data-v="${esc(w.key)}"><i style="color:${colCss(w)}"></i>${esc(w.name)}<em>${w.live ? 'working' : ago(w.last_ts)}</em></a>`).join('') || '<div class="af-note">Nobody right now.</div>'}<div class="af-k2">Files shown in here (${fs.length})</div>${fs.slice(0, 60).map(m => `<a class="af-row" data-af="f" data-v="${esc(fkey(m.proj, m.path))}">${esc(m.path)}</a>`).join('')}${n.fleet ? '' : '<button class="af-btn" data-af="iso">Isolate this folder</button>'}`;
    }
    return `<div class="af-reader"><button class="af-x" data-af="unsel" title="Close">&times;</button>${head}${body}</div>`;
  }

  /* ---------- drawing ---------- */
  function draw() {
    if (!S) return;
    S.clear(); nodes = {}; links = {}; wobj = {}; hot = [];
    all = fleetFiles(st.live, keepFn(), st.full, st.fd); const root = find(all, st.root) || all; st.root = nid(root); cone(root, 0, Math.PI * 2, 0);
    const P = (a, r, y) => new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r), pos = {}, sel = st.sel; let deep = 1;
    const selW = sel && sel.t === 'w' ? W[sel.k] : null, lit = new Set(); let selNode = null;
    (function mark(n) { let on = (selW && n.here.includes(selW)) || (sel && sel.t === 'f' && n.file && fkey(n.proj, n.path) === sel.k) || (sel && sel.t === 'n' && nid(n) === sel.k); if (on && !selNode) selNode = n; n.kids.forEach(k => { if (mark(k)) on = true; }); if (on) lit.add(n); return on; })(root);
    (function walk(n, up) {
      const me = n === root ? new THREE.Vector3(0, 0, 0) : P((n.a0 + n.a1) / 2, n.dd * R, -n.dd * H); deep = Math.max(deep, n.dd); n.pos = me;
      if (up) { const l = line([up, me], lit.has(n) ? C.head : C.accent, lit.has(n) ? 1 : .35); l.userData.base = [l.material.color.clone(), l.material.opacity]; links[nid(n) + (n.file ? '#f' : '')] = l; S.root.add(l); }
      const shut = n !== root && st.shut.has(nid(n)), isSel = selNode === n && !selW;
      let node;
      if (n.fleet || n.isProj || n === root) node = sphere(n === root ? 1.5 : 1.25, C.accent, DARK ? .7 : .2);
      else if (n.file) { const ed = editsOf(n.proj, n.path).length; node = new THREE.Mesh(new THREE.BoxGeometry(.95, 1.2, .12), new THREE.MeshStandardMaterial({ color: ed ? C.accent : C.card, emissive: C.accent, emissiveIntensity: ed ? (DARK ? .5 : .15) : .08, roughness: .5 })); node.lookAt(0, 0, 0); if (n.ghost) { node.material.transparent = true; node.material.opacity = .45; node.scale.setScalar(.7); } }
      else node = new THREE.Mesh(new THREE.OctahedronGeometry(shut ? .95 : .62), new THREE.MeshStandardMaterial({ color: shut ? C.accent : C.card, emissive: C.accent, emissiveIntensity: shut ? .6 : .15, roughness: .4 }));
      node.position.copy(me); if (n.ghost && !n.file) { node.material.transparent = true; node.material.opacity = .6; }
      node.userData = n.file ? { f: fkey(n.proj, n.path), n: nid(n) + '#f' } : { d: nid(n), n: nid(n) }; S.picks.push(node); S.root.add(node); nodes[node.userData.n] = { node, n };
      if (!n.fleet && !n.isProj && n !== root) node.add(new THREE.LineSegments(new THREE.EdgesGeometry(node.geometry), new THREE.LineBasicMaterial({ color: C.accent })));
      if (isSel) { const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, .09, 8, 40), new THREE.MeshBasicMaterial({ color: C.head })); ring.position.copy(me); S.root.add(ring); S.ticks.push(dt => { ring.rotation.x += dt; ring.rotation.y += dt * .7; }); }
      if (n.fleet || n.isProj || n === root || shut || lit.has(n) || (n.file && n.here.length) || (!n.file && n.dd <= 1)) { const top = n.fleet || n.isProj || n === root, l = S.label(esc(n.fleet ? 'All projects' : cut(n.isProj ? n.name : n.file ? n.name : n.name.split('/').pop() + '/', 28)) + (shut ? `<small>${n.count} inside</small>` : ''), top ? 'p' : n.file ? 'fl' : 'f'); l.position.set(0, top ? 2.2 : 1.3, 0); node.add(l); }
      // A closed folder keeps its agents in sight: they gather on it.
      if (shut) { const ws = inside(n).slice(0, 10); ws.forEach((w, i) => { const a = i / ws.length * Math.PI * 2, v = me.clone().add(new THREE.Vector3(Math.cos(a) * 2.3, -2.2, Math.sin(a) * 2.3)); pos[w.key] = v; const m = agentMesh(w, w.isHelper ? .4 : .7, sameSel('w', w.key)); m.position.copy(v); S.root.add(m); wobj[w.key] = m; }); return; }
      n.here.forEach((w, i) => { const v = n.file ? me.clone().add(new THREE.Vector3((i - (n.here.length - 1) / 2) * 1.9, -2.6, 0)) : P(n.h0 + (n.h1 - n.h0) * (i + .5) / n.here.length, n.dd * R + 4 + (i % 3) * 2.4, -n.dd * H - 3 - (i % 2) * 1.8); pos[w.key] = v;
        S.root.add(line([me, v], col3(w), sameSel('w', w.key) ? 1 : .55)); const m = agentMesh(w, w.isHelper ? .5 : .9, sameSel('w', w.key)); m.position.copy(v); S.root.add(m); wobj[w.key] = m;
        if ((!w.isHelper && (w.live || Object.keys(W).length < 30)) || sameSel('w', w.key)) { const l = S.label(esc(cut(w.name, 26))); l.position.set(0, -1.7, 0); m.add(l); } });
      n.kids.forEach(k => walk(k, me));
    })(root, null);
    if (sel && sel.t === 'n' && nodes[sel.k] && sel.k !== st.root) { const a = S.label(`<button class="af-zb" data-af="z" data-v="-1" title="One level less inside this folder">&minus;</button><span class="af-zr">${zl(sel.k)}</span><button class="af-zb" data-af="z" data-v="1" title="One level more inside this folder">+</button><button data-af="iso">Isolate</button>`, 'acts'); a.position.set(0, 3.2, 0); nodes[sel.k].node.add(a); }
    Object.keys(pos).forEach(k => { const w = W[k]; if (w.isHelper && pos[w.boss.key]) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([pos[k], pos[w.boss.key]]), new THREE.LineDashedMaterial({ color: col3(w), dashSize: .5, gapSize: .5, transparent: true, opacity: .6 })); l.computeLineDistances(); S.root.add(l); } });
    // The picked agent's trail: a line to every other file it touched.
    if (selW && pos[selW.key]) selW.files.slice(1).forEach(f => { const o = nodes[selW.proj.id + '|' + f + '#f']; if (!o) return; const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([pos[selW.key], o.n.pos]), new THREE.LineDashedMaterial({ color: col3(selW), dashSize: .9, gapSize: .5 })); l.computeLineDistances(); S.root.add(l); });
    for (let d = 1; d <= deep; d++) { const pts = []; for (let i = 0; i <= 96; i++) pts.push(P(i / 96 * Math.PI * 2, d * R, -d * H)); S.root.add(line(pts, C.accent, .1)); }
    if (st.fresh) { S.view(new THREE.Vector3(0, 16, deep * R * 1.5 + 20), new THREE.Vector3(0, -deep * H * .5, 0)); st.fresh = false; }
    S.ticks.push(() => { S.ctl.autoRotate = st.rotate && (!tip || tip.hidden); });

    const tot = { working: 0, agents: 0, helpers: 0 }; projects.forEach(p => { tot.working += p.agents.filter(a => a.live).length; tot.agents += p.agents.length; tot.helpers += p.agents.reduce((n, a) => n + a.helpers.length, 0); });
    const tr = []; for (let n = root; n; n = n.parent) tr.unshift(n);
    el.classList.toggle('af-split', !!st.sel);
    el.querySelector('.af-bar').innerHTML = `<h2>Where agents are</h2><span class="af-sum"><b>${tot.working}</b> working &middot; <b>${tot.agents}</b> agents &middot; <b>${tot.helpers}</b> helpers &middot; <b>${projects.length}</b> project${projects.length === 1 ? '' : 's'}</span><span class="af-sp"></span><button class="af-chip ${st.live ? '' : 'on'}" data-af="live" data-v="0">All recent</button><button class="af-chip ${st.live ? 'on' : ''}" data-af="live" data-v="1">Working now</button><button class="af-chip" data-af="reset">Reset</button><button class="af-chip" data-af="close" title="Close (Esc)">Close</button>`;
    el.querySelector('.af-over').innerHTML = `<div class="af-tools">${tr.map((n, i) => `<button data-af="root" data-v="${esc(nid(n))}" class="${i === tr.length - 1 ? 'cur' : ''}">${esc(n.fleet ? 'All projects' : n.isProj ? n.name : n.name.split('/').pop())}</button>`).join('<span>&rsaquo;</span>')}${st.only && W[st.only] ? `<button data-af="only" data-v="" class="cur">Only ${esc(cut(W[st.only].name, 20))} &times;</button>` : ''}<span class="af-sep"></span><button class="af-zb" data-af="zr" data-v="-1" title="Show one level less">&minus;</button><span class="af-zr">${zl(st.root)}</span><button class="af-zb" data-af="zr" data-v="1" title="Show one level more">+</button><span class="af-sep"></span><label class="af-chk"><input type="checkbox" data-af="rot" ${st.rotate ? 'checked' : ''}> Rotate</label></div>`
      + (projects.length ? '<div class="af-hint">Hover anything for its path &middot; click a file for its contents and changes &middot; click a ball for the agent and its session &middot; minus and plus show fewer or more levels &middot; click a folder for its own minus and plus, double-click to isolate it</div>' : '<div class="af-empty">No agent has worked in the last three days.</div>')
      + reader();
  }

  /* ---------- hover, clicks ---------- */
  function onHover(e) {
    const u = S.hit(e);
    hot.forEach(l => { l.material.color.copy(l.userData.base[0]); l.material.opacity = l.userData.base[1]; }); hot = [];
    if (!u) { tip.hidden = true; S.canvas.style.cursor = ''; return; }
    S.canvas.style.cursor = 'pointer'; let html = '', n = null;
    if (u.w) { const w = W[u.w]; if (!w) return; html = `<b><i style="color:${colCss(w)}"></i>${esc(w.name)}</b><span>${w.isHelper ? 'Helper of ' + esc(cut(w.boss.name, 24)) + ' &middot; ' : ''}${statusWord(w)} &middot; ${ago(w.last_ts)}</span><span class="af-mono">${esc(here(w) || 'no file yet')}</span><em>Click for its session, files and changes</em>`; Object.values(nodes).forEach(o => { if (o.n.here.includes(w)) n = o.n; }); }
    else { const o = nodes[u.n]; n = o && o.n; if (n) { const ed = n.file ? editsOf(n.proj, n.path).length : 0; html = `<b class="af-mono">${esc(n.fleet ? 'All projects' : n.isProj ? n.proj.cwd : n.path + (n.file ? '' : '/'))}</b><span>${n.file ? (n.ghost ? 'No agent touched it lately' : n.touch.map(w => esc(cut(w.name, 20))).slice(0, 3).join(', ') + (ed ? ` &middot; ${ed} change${ed > 1 ? 's' : ''}` : ' &middot; read only')) : `${n.count} agent${n.count === 1 ? '' : 's'} inside`}</span><em>${n.file ? 'Click for the file and its changes' : 'Click to close or open it'}</em>`; } }
    for (let m = n; m && m.parent; m = m.parent) { const l = links[nid(m) + (m.file ? '#f' : '')]; if (l) { l.material.color.copy(C.head); l.material.opacity = 1; hot.push(l); } }
    tip.innerHTML = html; tip.hidden = !html; const mr = el.getBoundingClientRect(); tip.style.left = Math.max(8, Math.min(e.clientX - mr.left + 16, mr.width - 340)) + 'px'; tip.style.top = (e.clientY - mr.top + 16) + 'px';
  }
  async function loadFile(key) {
    if (FILES[key]) return; const i = key.indexOf('|');
    try { const r = await fetch('/api/agent-fleet/file?project=' + encodeURIComponent(key.slice(0, i)) + '&path=' + encodeURIComponent(key.slice(i + 1))); const d = r.ok ? await r.json() : null; FILES[key] = d && d.ok ? d : { kind: 'missing' }; }
    catch (_e) { FILES[key] = { kind: 'missing' }; }
    if (el && sameSel('f', key)) draw();
  }
  function pick(t, k) { st.sel = { t, k }; st.tab = ''; draw(); if (t === 'f') loadFile(k); }
  async function onPick(u) {
    tip.hidden = true;
    if (u.w) { sameSel('w', u.w) ? (st.sel = null, draw()) : pick('w', u.w); return; }
    if (u.f) { sameSel('f', u.f) ? (st.sel = null, draw()) : pick('f', u.f); return; }
    if (!u.d) return;
    const nn = all && find(all, u.d);
    if (nn && nn.ghost && !nn.kids.length) { st.full.add(u.d); await ensureDirs(); }
    else if (u.d !== st.root) { st.shut.has(u.d) ? st.shut.delete(u.d) : st.shut.add(u.d); delete st.lvOf[u.d]; }
    pick('n', u.d);
  }
  async function onClick(e) {
    const t = e.target.closest('[data-af]'); if (!t || !el.contains(t)) return;
    const a = t.getAttribute('data-af'), v = t.getAttribute('data-v') || '';
    if (a === 'rot') { st.rotate = !!t.checked; return; }
    if (a === 'close') { close(); return; }
    if (a === 'reset') { st.reset(); st.fresh = true; draw(); return; }
    if (a === 'live') { st.live = v === '1'; draw(); return; }
    if (a === 'unsel') { st.sel = null; draw(); return; }
    if (a === 'zr') { step(st.root, +v); st.fresh = true; await ensureDirs(); draw(); return; }
    if (a === 'z') { if (st.sel) { step(st.sel.k, +v); await ensureDirs(); draw(); } return; }
    if (a === 'iso') { if (st.sel && st.sel.t === 'n') { st.root = st.sel.k; st.shut.delete(st.root); st.sel = null; st.fresh = true; draw(); } return; }
    if (a === 'root') { st.root = v; st.fresh = true; draw(); return; }
    if (a === 'only') { st.only = v || null; st.root = 'F'; st.fresh = true; draw(); return; }
    if (a === 'w') { pick('w', v); return; }
    if (a === 'f') { pick('f', v); return; }
    if (a === 'd') { const n = all && (find(all, v) || (function near(m) { let best = null; (function g(x) { if (!x.file && x.proj && v.indexOf(x.proj.id + '|' + x.path) === 0 && (!best || x.path.length > best.path.length)) best = x; x.kids.forEach(g); })(m); return best; })(all)); if (n) pick('n', nid(n)); return; }
    if (a === 'open') { const i = v.indexOf('|'), proj = v.slice(0, i), sid = v.slice(i + 1); close();
      try { if (typeof setProject === 'function' && localStorage.getItem('activeProject') !== proj) await setProject(proj); } catch (_e) { /* open it in the project on screen */ }
      if (typeof setViewMode === 'function') setViewMode('sessions');
      if (typeof openInGUI === 'function') openInGUI(sid); }
  }

  /* ---------- data, open, close ---------- */
  function index(d) {
    DATA = d; W = {}; projects = (d && d.projects) || []; let hi = 0;
    projects.forEach(p => p.agents.forEach(a => {
      a.key = a.id; a.proj = p; a.hue = HUES[hi++ % HUES.length]; a.isHelper = false; W[a.key] = a;
      a.helpers.forEach(h => { h.key = a.id + ':' + h.id; h.proj = p; h.hue = a.hue; h.isHelper = true; h.boss = a; h.group = h.live ? 'working' : 'done'; W[h.key] = h; });
    }));
    if (st.sel && st.sel.t === 'w' && !W[st.sel.k]) st.sel = null;
    if (st.only && !W[st.only]) st.only = null;
  }
  async function load() {
    try { const r = await fetch('/api/agent-fleet'); if (!r.ok) throw new Error(String(r.status)); index(await r.json()); return true; }
    catch (_e) { return false; }
  }
  async function open() {
    if (el) return;
    el = document.createElement('div'); el.id = 'agent-fleet';
    el.innerHTML = '<div class="af-bar"><h2>Where agents are</h2><span class="af-sp"></span><button class="af-chip" data-af="close">Close</button></div><div class="af-stage"><div class="af-empty">Loading…</div></div><div class="af-over"></div>';
    // The header is a narrow rail down the left on a desktop and a bar across the top otherwise: sit beside or under it.
    const hr = (document.querySelector('header') || el).getBoundingClientRect(), isRail = hr.height > hr.width * 2 && hr.width < 120;
    el.style.top = (isRail || !hr.height ? 0 : Math.round(hr.bottom)) + 'px'; el.style.left = (isRail ? Math.round(hr.right) : 0) + 'px';
    document.body.appendChild(el); el.addEventListener('click', onClick); document.addEventListener('keydown', onKey);
    document.dispatchEvent(new CustomEvent('vn:agent-fleet', { detail: { open: true } }));
    try {
      if (!THREE) { const m = await Promise.all([import('/static/vendor/three/three.module.js'), import('/static/vendor/three/OrbitControls.js'), import('/static/vendor/three/CSS2DRenderer.js')]); THREE = m[0]; OrbitControls = m[1].OrbitControls; CSS2DRenderer = m[2].CSS2DRenderer; CSS2DObject = m[2].CSS2DObject; }
    } catch (_e) { if (el) el.querySelector('.af-stage').innerHTML = '<div class="af-empty">The 3D view could not be loaded.</div>'; return; }
    const ok = await load();
    if (!el) return;                                   // closed while it loaded
    if (!ok) { el.querySelector('.af-stage').innerHTML = '<div class="af-empty">Could not read where agents are. Restart DevelopNode’s web server (System, Server) if this view was just installed.</div>'; return; }
    DARK = document.documentElement.getAttribute('data-theme') !== 'light'; AGL = DARK ? 66 : 46;
    C = { accent: new THREE.Color(css('--accent') || '#7c7cff'), card: new THREE.Color(css('--bg-card') || '#1e1e1e'), head: new THREE.Color(css('--text-heading') || '#fff') };
    const host = el.querySelector('.af-stage'); host.innerHTML = '';
    S = stage(host); S.onPick = onPick;
    tip = document.createElement('div'); tip.className = 'af-tip'; tip.hidden = true; el.appendChild(tip);
    S.canvas.addEventListener('pointermove', onHover); S.canvas.addEventListener('pointerleave', () => { tip.hidden = true; });
    S.canvas.addEventListener('dblclick', e => { const u = S.hit(e); if (u && u.d) { st.root = u.d; st.shut.delete(u.d); st.sel = null; st.fresh = true; draw(); } });
    st.fresh = true; draw();
    timer = setInterval(async () => { if (!el || document.hidden) return; if (await load() && el) draw(); }, REFRESH_MS);
  }
  function close() {
    if (!el) return;
    clearInterval(timer); timer = null; document.removeEventListener('keydown', onKey);
    if (S) { S.dispose(); S = null; }
    el.remove(); el = null; tip = null; all = null;
    document.dispatchEvent(new CustomEvent('vn:agent-fleet', { detail: { open: false } }));
  }
  function onKey(e) { if (e.key === 'Escape' && el && !document.querySelector('.modal.show, #pm-overlay.show')) close(); }

  window.openAgentFleet = open;
  window.closeAgentFleet = close;
  window.VNAgentFleet = { open, close, isOpen: () => !!el, _debug: () => ({ S, st, nodes, wobj }) };
})();
