/* All projects: one view of every project's sessions, chosen from the
 * project picker.  Each session is labelled with its project in the sidebar,
 * and the project becomes the root of the summary card's path (only in this
 * view).
 *
 * The view is a flag (localStorage.vnAllProjects = '1'); `activeProject`
 * stays a real project, the one of the session last opened, so every route
 * that takes ?project= keeps working.  Opening a session from another project
 * moves `activeProject` to it quietly (no teardown), see beforeOpen().
 *
 * Each session gets a pill: the project's initial in a small outlined tile,
 * then its name.  No project colours: colour on these cards means status.
 */
(function () {
  const FLAG = 'vnAllProjects';
  const ALL = '__all__';

  function on() { try { return localStorage.getItem(FLAG) === '1'; } catch (e) { return false; } }
  function set(v) { try { if (v) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch (e) {} }

  function projects() { return (typeof _allProjects !== 'undefined' && Array.isArray(_allProjects)) ? _allProjects : []; }

  // ── The chosen projects (the picker's Choose list under All projects) ──
  // Stored as the projects LEFT OUT, per device, so a project added later is
  // in by default.  At least one project always stays in.
  const OFF = 'vnAllProjectsOff';
  function _off() {
    try { const v = JSON.parse(localStorage.getItem(OFF) || '[]'); return new Set(Array.isArray(v) ? v : []); }
    catch (e) { return new Set(); }
  }
  function included(enc) { return !!enc && !_off().has(enc); }
  /** The projects this view covers: every project but the ones left out. */
  function shown() {
    const off = _off();
    const list = projects().filter(p => !off.has(p.encoded));
    return list.length ? list : projects();   // never an empty view
  }
  function narrowed() { return shown().length < projects().length; }
  /** Put a project in or out of the view.  Returns false when it would leave none. */
  function setIncluded(enc, yes) {
    const off = _off();
    if (yes) off.delete(enc);
    else {
      if (projects().filter(p => !off.has(p.encoded) && p.encoded !== enc).length === 0) return false;
      off.add(enc);
    }
    // Forget projects that no longer exist, so the stored list never grows.
    const known = new Set(projects().map(p => p.encoded));
    const keep = [...off].filter(e => !known.size || known.has(e));
    try { if (keep.length) localStorage.setItem(OFF, JSON.stringify(keep)); else localStorage.removeItem(OFF); } catch (e) {}
    return true;
  }
  /** Does a session folder belong to a project this view covers? */
  function includesCwd(cwd) {
    if (!cwd) return true;
    const enc = encodeCwd(cwd).toLowerCase();
    const p = projects().find(x => x.encoded.toLowerCase() === enc);
    return !p || shown().includes(p);
  }
  /** What the view is called: "All projects", or "3 of 5 projects". */
  function label() {
    const n = shown().length, all = projects().length;
    return (n < all) ? `${n} of ${all} projects` : 'All projects';
  }
  function find(enc) { return projects().find(p => p.encoded === enc) || null; }
  function name(enc) {
    const p = find(enc);
    if (p && typeof _projectShortName === 'function') return _projectShortName(p);
    return enc ? String(enc).split('-').filter(Boolean).pop() : '';
  }
  function encodeCwd(cwd) { return String(cwd || '').replace(/[\\/:_.]/g, '-'); }
  function projectOf(sid) {
    if (!sid || typeof SessionStore === 'undefined') return '';
    const s = SessionStore.get(sid);
    if (!s) return '';
    if (s._project) return s._project;
    // A row added by a live event (a new session) has no tag; its folder says.
    if (s.cwd) {
      const enc = encodeCwd(s.cwd).toLowerCase();
      const p = projects().find(x => x.encoded.toLowerCase() === enc);
      if (p) { s._project = p.encoded; return p.encoded; }
    }
    return '';
  }

  /** Make `enc` the active project at once, without the project-switch
   *  teardown: every route that takes ?project= then acts on that project. */
  function useProject(enc) {
    if (!enc || enc === localStorage.getItem('activeProject')) return null;
    localStorage.setItem('activeProject', enc);
    if (typeof socket !== 'undefined' && socket.io && socket.io.opts) socket.io.opts.query = { project: enc };
    return (typeof _syncActiveProject === 'function') ? _syncActiveProject(enc, 2).catch(() => {}) : null;
  }

  /** Any touch on a session (click, double-click, right-click, pin, open)
   *  first moves the active project to that session's project, so rename,
   *  pin, Standby, delete and the rest go to the right project. */
  function adopt(sid) {
    if (!on()) return null;
    return useProject(projectOf(sid));
  }

  /** The project a call about this session goes to: its own in this view. */
  function projectFor(sid) {
    const here = localStorage.getItem('activeProject') || '';
    return on() ? (projectOf(sid) || here) : here;
  }

  /** Key for per-project settings (session filters) while in this view. */
  function settingsKey() { return on() ? ALL : (localStorage.getItem('activeProject') || ''); }

  // ── Project chooser: the project picker, asking a question ──
  // New Session, Workflow and Subsessions work in one project, so in this
  // view they first ask which one.

  let _choice = null;
  function chooseProject(question, hint) {
    if (_choice) _choice.resolve(null);
    return new Promise(resolve => {
      _choice = { resolve, question, hint: hint || '' };
      if (typeof openProjectOverlay === 'function') openProjectOverlay();
      else { _choice = null; resolve(null); }
    });
  }
  function choosing() { return _choice; }
  /** Called by the picker: a row was picked (enc) or it was closed (null). */
  function finishChoice(enc) {
    const c = _choice;
    _choice = null;
    if (c) c.resolve(enc || null);
    return !!c;
  }

  /** New Session in this view: which project?  Returns false to cancel. */
  async function beforeNewSession() {
    if (!on()) return true;
    const enc = await chooseProject('New session in which project?', 'The session starts in that project\u2019s folder.');
    if (!enc) return false;
    const sync = useProject(enc);
    if (sync) await sync;
    return enc;
  }

  /** Workflow and Subsessions are one project's: pick it, then leave this view for it. */
  const PER_PROJECT_VIEWS = { kanban: 'Workflow', compose: 'Subsessions' };
  async function openPerProjectView(mode) {
    const enc = await chooseProject('Open ' + PER_PROJECT_VIEWS[mode] + ' for which project?',
      PER_PROJECT_VIEWS[mode] + ' shows one project at a time, so this leaves All projects.');
    if (!enc) return;
    set(false);
    if (typeof selectProjectFromOverlay === 'function') await selectProjectFromOverlay(enc);
    if (typeof setViewMode === 'function') setViewMode(mode);
  }

  // A snapshot asked for in this view covers every project (the web server
  // answers with all_projects; an older one ignores the flag, and socket.js
  // then keeps the other projects' states instead of wiping them).
  function patchSocket() {
    if (typeof socket === 'undefined' || !socket || socket._vnApPatched) return;
    const orig = socket.emit.bind(socket);
    // Pass other events through with their own arguments: forwarding an
    // absent payload sends null, which breaks handlers that take none.
    socket.emit = function (ev, ...args) {
      if (ev === 'request_state_snapshot' && on()) args[0] = Object.assign({}, args[0] || {}, { all_projects: true });
      return orig(ev, ...args);
    };
    socket._vnApPatched = true;
  }
  window.addEventListener('DOMContentLoaded', patchSocket);

  /** A Response holding every project's sessions, each tagged with `_project`. */
  async function fetchAll(signal) {
    const list = shown();
    const parts = await Promise.all(list.map(async p => {
      for (let attempt = 0; attempt < 20; attempt++) {
        if (signal && signal.aborted) return [];
        try {
          const r = await fetch('/api/sessions?project=' + encodeURIComponent(p.encoded), { signal, cache: 'no-store' });
          if (r.ok) {
            const rows = await r.json();
            return (Array.isArray(rows) ? rows : []).map(s => Object.assign(s, { _project: p.encoded }));
          }
        } catch (e) { if (signal && signal.aborted) return []; }
        await new Promise(r => setTimeout(r, 750));
      }
      return [];
    }));
    return new Response(JSON.stringify([].concat(...parts)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  /** Before a session opens: make its project the active one, without the
   *  project-switch teardown, so the thread, composer and wake use its folder. */
  async function beforeOpen(sid) {
    const sync = adopt(sid);
    if (sync) await sync;
  }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // The project's initial as a shape, not text: the browser snaps text (in HTML and in SVG alike) to whole screen
  // pixels, so a letter drifted up to a pixel off its disc's centre depending on where the card landed.  These are
  // Inter Bold's outlines at 9px, each centred by its own ink in a 14x14 box; any other character falls back to text.
  const GLYPHS = {"A":"M3.86 10.27 6.09 3.73H7.85L10.14 10.27H8.65L7.6 7.11Q7.42 6.5 7.22 5.78Q7.02 5.05 6.81 4.19H7.1Q6.89 5.05 6.71 5.78Q6.53 6.52 6.35 7.11L5.34 10.27ZM5.25 8.75V7.7H8.75V8.75Z","B":"M4.49 10.27V3.73H7.09Q7.81 3.73 8.29 3.94Q8.77 4.16 9.01 4.54Q9.25 4.92 9.25 5.41Q9.25 5.8 9.1 6.08Q8.94 6.37 8.68 6.55Q8.41 6.74 8.07 6.82V6.88Q8.44 6.89 8.77 7.09Q9.1 7.29 9.3 7.64Q9.51 7.98 9.51 8.47Q9.51 8.99 9.25 9.4Q9 9.8 8.5 10.04Q8 10.27 7.26 10.27ZM5.83 9.17H6.99Q7.58 9.17 7.85 8.94Q8.13 8.71 8.13 8.34Q8.13 8.06 7.99 7.85Q7.86 7.64 7.61 7.52Q7.37 7.4 7.03 7.4H5.83ZM5.83 6.48H6.89Q7.18 6.48 7.41 6.37Q7.64 6.27 7.76 6.08Q7.89 5.89 7.89 5.62Q7.89 5.27 7.64 5.04Q7.39 4.82 6.92 4.82H5.83Z","C":"M7.11 10.36Q6.24 10.36 5.55 9.97Q4.86 9.57 4.47 8.82Q4.07 8.07 4.07 7Q4.07 5.94 4.47 5.18Q4.87 4.43 5.56 4.03Q6.25 3.64 7.11 3.64Q7.67 3.64 8.15 3.79Q8.63 3.95 9 4.25Q9.38 4.55 9.61 4.98Q9.85 5.41 9.93 5.97H8.57Q8.52 5.69 8.4 5.49Q8.27 5.28 8.09 5.13Q7.9 4.98 7.66 4.91Q7.42 4.83 7.14 4.83Q6.63 4.83 6.24 5.08Q5.86 5.34 5.64 5.82Q5.43 6.31 5.43 7Q5.43 7.71 5.65 8.2Q5.86 8.68 6.24 8.92Q6.63 9.17 7.13 9.17Q7.41 9.17 7.65 9.09Q7.89 9.02 8.08 8.87Q8.27 8.72 8.4 8.51Q8.52 8.3 8.57 8.03H9.93Q9.88 8.49 9.66 8.91Q9.44 9.32 9.08 9.65Q8.72 9.98 8.23 10.17Q7.73 10.36 7.11 10.36Z","D":"M6.56 10.27H4.86V9.12H6.49Q7.12 9.12 7.55 8.89Q7.98 8.67 8.2 8.2Q8.41 7.73 8.41 7Q8.41 6.27 8.19 5.8Q7.98 5.33 7.55 5.11Q7.13 4.88 6.5 4.88H4.83V3.73H6.58Q7.56 3.73 8.27 4.12Q8.98 4.51 9.36 5.24Q9.75 5.98 9.75 7Q9.75 8.02 9.36 8.75Q8.98 9.49 8.27 9.88Q7.55 10.27 6.56 10.27ZM5.59 3.73V10.27H4.25V3.73Z","E":"M4.8 10.27V3.73H9.19V4.84H6.15V6.42H8.96V7.51H6.15V9.16H9.2V10.27Z","F":"M4.85 10.27V3.73H9.15V4.84H6.19V6.67H8.86V7.76H6.19V10.27Z","G":"M7.13 10.36Q6.21 10.36 5.52 9.96Q4.82 9.55 4.44 8.8Q4.05 8.04 4.05 7.01Q4.05 5.95 4.45 5.19Q4.86 4.44 5.55 4.04Q6.24 3.64 7.1 3.64Q7.65 3.64 8.13 3.8Q8.6 3.96 8.98 4.25Q9.35 4.55 9.58 4.95Q9.82 5.35 9.89 5.84H8.52Q8.45 5.6 8.33 5.42Q8.2 5.23 8.03 5.1Q7.85 4.97 7.62 4.9Q7.39 4.83 7.12 4.83Q6.61 4.83 6.23 5.08Q5.84 5.33 5.62 5.82Q5.41 6.3 5.41 7Q5.41 7.69 5.62 8.18Q5.84 8.66 6.22 8.92Q6.61 9.17 7.14 9.17Q7.61 9.17 7.95 9Q8.29 8.83 8.47 8.51Q8.65 8.19 8.65 7.76L8.93 7.8H7.23V6.78H9.95V7.6Q9.95 8.46 9.59 9.08Q9.22 9.7 8.59 10.03Q7.95 10.36 7.13 10.36Z","H":"M4.23 10.27V3.73H5.57V6.37H8.42V3.73H9.77V10.27H8.42V7.48H5.57V10.27Z","I":"M7.67 3.73V10.27H6.33V3.73Z","J":"M7.01 10.32Q5.99 10.32 5.4 9.78Q4.82 9.25 4.82 8.26V7.88H6.16V8.28Q6.16 8.75 6.39 9Q6.62 9.24 7.01 9.24Q7.4 9.24 7.63 9Q7.86 8.75 7.86 8.28V3.68H9.18V8.26Q9.18 9.25 8.6 9.78Q8.02 10.32 7.01 10.32Z","K":"M5.16 8.79V7.57Q5.36 7.21 5.56 6.9Q5.75 6.59 5.98 6.28Q6.22 5.97 6.51 5.61L8.12 3.73H9.76L6.99 6.93L6.88 6.89ZM4.17 10.27V3.73H5.51V5.51L5.49 7.18L5.51 7.84V10.27ZM8.24 10.27 6.3 7.32 7.15 6.32 9.83 10.27Z","L":"M4.92 10.27V3.73H6.26V9.16H9.08V10.27Z","M":"M3.4 10.27V3.73H5.46L6.52 6.73Q6.58 6.94 6.67 7.28Q6.76 7.61 6.84 8Q6.93 8.38 7.01 8.75Q7.09 9.11 7.13 9.38H6.87Q6.92 9.12 7 8.76Q7.08 8.39 7.16 8.01Q7.25 7.62 7.34 7.28Q7.42 6.94 7.49 6.73L8.54 3.73H10.6V10.27H9.25V7.19Q9.25 6.97 9.26 6.65Q9.27 6.33 9.28 5.96Q9.29 5.59 9.3 5.21Q9.3 4.84 9.31 4.5H9.39Q9.31 4.87 9.21 5.26Q9.11 5.65 9 6.01Q8.9 6.38 8.81 6.68Q8.72 6.99 8.65 7.19L7.56 10.27H6.44L5.33 7.19Q5.27 6.99 5.17 6.69Q5.08 6.38 4.98 6.02Q4.88 5.66 4.77 5.27Q4.66 4.88 4.57 4.5H4.67Q4.68 4.82 4.69 5.19Q4.7 5.57 4.71 5.94Q4.72 6.32 4.72 6.64Q4.73 6.96 4.73 7.19V10.27Z","N":"M4.16 10.27V3.73H5.66L7.73 7.04Q7.89 7.29 8.05 7.59Q8.21 7.89 8.38 8.26Q8.55 8.62 8.72 9.08H8.58Q8.55 8.71 8.52 8.3Q8.5 7.89 8.48 7.51Q8.47 7.13 8.47 6.87V3.73H9.84V10.27H8.34L6.46 7.27Q6.25 6.93 6.07 6.61Q5.9 6.29 5.71 5.91Q5.52 5.52 5.25 4.99H5.42Q5.45 5.46 5.48 5.9Q5.5 6.33 5.52 6.69Q5.53 7.04 5.53 7.26V10.27Z","O":"M7 10.36Q6.13 10.36 5.44 9.97Q4.75 9.57 4.35 8.82Q3.95 8.07 3.95 7Q3.95 5.94 4.35 5.18Q4.75 4.43 5.44 4.03Q6.13 3.64 7 3.64Q7.87 3.64 8.56 4.03Q9.25 4.43 9.65 5.18Q10.05 5.94 10.05 7Q10.05 8.07 9.65 8.82Q9.25 9.57 8.56 9.97Q7.87 10.36 7 10.36ZM7 9.17Q7.51 9.17 7.89 8.92Q8.27 8.67 8.48 8.19Q8.69 7.7 8.69 7Q8.69 6.3 8.48 5.81Q8.27 5.33 7.89 5.08Q7.51 4.83 7 4.83Q6.49 4.83 6.11 5.08Q5.73 5.33 5.52 5.82Q5.31 6.3 5.31 7Q5.31 7.7 5.52 8.19Q5.73 8.67 6.11 8.92Q6.49 9.17 7 9.17Z","P":"M4.55 10.27V3.73H7.11Q7.85 3.73 8.38 4.01Q8.9 4.29 9.17 4.79Q9.45 5.29 9.45 5.94Q9.45 6.59 9.17 7.08Q8.89 7.58 8.36 7.85Q7.83 8.13 7.07 8.13H5.43V7.05H6.86Q7.27 7.05 7.54 6.91Q7.8 6.77 7.93 6.52Q8.06 6.27 8.06 5.94Q8.06 5.61 7.93 5.36Q7.8 5.11 7.54 4.97Q7.27 4.83 6.85 4.83H5.89V10.27Z","Q":"M6.59 7.8H7.73L8.34 8.57L8.88 9.21L9.98 10.59H8.72L7.98 9.66L7.61 9.14ZM7 10.13Q6.13 10.13 5.44 9.74Q4.75 9.34 4.35 8.59Q3.95 7.84 3.95 6.78Q3.95 5.71 4.35 4.95Q4.75 4.2 5.44 3.81Q6.13 3.41 7 3.41Q7.87 3.41 8.56 3.81Q9.25 4.2 9.65 4.95Q10.05 5.71 10.05 6.78Q10.05 7.84 9.65 8.59Q9.25 9.34 8.56 9.74Q7.87 10.13 7 10.13ZM7 8.94Q7.51 8.94 7.89 8.69Q8.27 8.45 8.48 7.96Q8.69 7.47 8.69 6.78Q8.69 6.07 8.48 5.58Q8.27 5.1 7.89 4.85Q7.51 4.6 7 4.6Q6.49 4.6 6.11 4.85Q5.73 5.1 5.52 5.59Q5.31 6.07 5.31 6.78Q5.31 7.47 5.52 7.96Q5.73 8.44 6.11 8.69Q6.49 8.94 7 8.94Z","R":"M4.44 10.27V3.73H6.99Q7.74 3.73 8.26 3.99Q8.78 4.25 9.06 4.73Q9.33 5.21 9.33 5.86Q9.33 6.5 9.05 6.97Q8.77 7.44 8.24 7.69Q7.71 7.94 6.96 7.94H5.23V6.85H6.74Q7.16 6.85 7.42 6.74Q7.68 6.63 7.82 6.4Q7.95 6.18 7.95 5.86Q7.95 5.52 7.82 5.3Q7.68 5.07 7.42 4.95Q7.15 4.83 6.74 4.83H5.78V10.27ZM8.08 10.27 6.48 7.29H7.94L9.56 10.27Z","S":"M7.05 10.37Q6.26 10.37 5.68 10.12Q5.09 9.88 4.77 9.41Q4.44 8.93 4.43 8.24H5.73Q5.76 8.57 5.93 8.79Q6.1 9.01 6.39 9.12Q6.67 9.23 7.03 9.23Q7.39 9.23 7.66 9.13Q7.93 9.03 8.07 8.84Q8.22 8.65 8.22 8.4Q8.22 8.17 8.09 8.02Q7.96 7.87 7.71 7.76Q7.45 7.65 7.09 7.57L6.37 7.39Q5.54 7.18 5.07 6.75Q4.6 6.32 4.6 5.61Q4.6 5.01 4.92 4.57Q5.24 4.13 5.8 3.88Q6.35 3.63 7.06 3.63Q7.79 3.63 8.33 3.88Q8.87 4.13 9.17 4.57Q9.48 5.01 9.49 5.59H8.19Q8.15 5.19 7.85 4.98Q7.55 4.76 7.05 4.76Q6.71 4.76 6.47 4.86Q6.23 4.96 6.1 5.13Q5.98 5.3 5.98 5.52Q5.98 5.76 6.12 5.92Q6.27 6.08 6.51 6.18Q6.75 6.28 7.02 6.35L7.62 6.49Q8.03 6.58 8.39 6.74Q8.74 6.9 9.01 7.13Q9.28 7.36 9.43 7.68Q9.57 7.99 9.57 8.41Q9.57 9 9.27 9.44Q8.98 9.88 8.41 10.12Q7.84 10.37 7.05 10.37Z","T":"M4.33 4.84V3.73H9.67V4.84H7.67V10.27H6.33V4.84Z","U":"M7 10.32Q6.19 10.32 5.58 10.02Q4.97 9.72 4.63 9.18Q4.3 8.65 4.3 7.93V3.68H5.64V7.82Q5.64 8.2 5.81 8.5Q5.98 8.8 6.28 8.96Q6.59 9.13 7 9.13Q7.41 9.13 7.71 8.96Q8.02 8.8 8.19 8.5Q8.36 8.2 8.36 7.82V3.68H9.7V7.93Q9.7 8.65 9.36 9.18Q9.03 9.72 8.42 10.02Q7.81 10.32 7 10.32Z","V":"M6.15 10.27 3.86 3.73H5.35L6.39 6.89Q6.58 7.48 6.77 8.2Q6.97 8.92 7.18 9.77H6.89Q7.1 8.91 7.29 8.2Q7.47 7.48 7.65 6.89L8.66 3.73H10.14L7.9 10.27Z","W":"M4.3 10.27 2.55 3.73H4.01L4.77 6.95Q4.86 7.35 4.94 7.81Q5.02 8.27 5.09 8.73Q5.17 9.2 5.24 9.62H5Q5.08 9.2 5.16 8.73Q5.24 8.27 5.32 7.81Q5.4 7.35 5.5 6.95L6.3 3.73H7.7L8.49 6.95Q8.59 7.35 8.68 7.81Q8.76 8.27 8.84 8.73Q8.92 9.2 9 9.62H8.76Q8.83 9.2 8.9 8.73Q8.98 8.27 9.06 7.81Q9.14 7.35 9.23 6.95L9.99 3.73H11.45L9.69 10.27H8.16L7.29 6.93Q7.15 6.37 7.05 5.72Q6.95 5.07 6.83 4.38H7.16Q7.03 5.05 6.94 5.69Q6.86 6.33 6.7 6.93L5.84 10.27Z","X":"M3.9 10.27 6.6 6.43V7.45L4.11 3.73H5.67L6.38 4.82Q6.59 5.14 6.72 5.39Q6.85 5.63 6.95 5.86Q7.06 6.09 7.19 6.34H6.84Q6.97 6.09 7.08 5.87Q7.19 5.64 7.32 5.39Q7.45 5.14 7.65 4.82L8.38 3.73H9.9L7.46 7.37V6.4L10.1 10.27H8.51L7.6 8.9Q7.42 8.63 7.31 8.43Q7.19 8.24 7.1 8.07Q7.01 7.89 6.89 7.68H7.11Q6.99 7.89 6.9 8.06Q6.81 8.23 6.69 8.43Q6.58 8.63 6.39 8.9L5.45 10.27Z","Y":"M6.35 10.27V7.81L3.93 3.73H5.49L6.6 5.77Q6.77 6.07 6.91 6.38Q7.04 6.68 7.18 7.1H6.88Q7.02 6.67 7.15 6.37Q7.27 6.07 7.44 5.77L8.51 3.73H10.07L7.69 7.81V10.27Z","Z":"M4.52 10.27V9.47L7.17 5.72Q7.42 5.38 7.71 5.03Q8.01 4.69 8.31 4.35L8.41 4.79Q7.97 4.82 7.53 4.83Q7.08 4.84 6.64 4.84H4.5V3.73H9.48V4.53L6.88 8.22Q6.62 8.58 6.31 8.94Q6.01 9.29 5.69 9.65L5.59 9.21Q6.06 9.18 6.51 9.17Q6.97 9.16 7.43 9.16H9.5V10.27Z","0":"M7 10.36Q6.17 10.36 5.59 9.96Q5 9.57 4.69 8.82Q4.38 8.07 4.38 7Q4.38 5.95 4.69 5.19Q5 4.44 5.59 4.04Q6.17 3.64 7 3.64Q7.82 3.64 8.41 4.04Q9 4.44 9.31 5.19Q9.62 5.95 9.62 7Q9.62 8.07 9.31 8.82Q9 9.57 8.42 9.96Q7.83 10.36 7 10.36ZM7 9.25Q7.4 9.25 7.68 8.99Q7.96 8.72 8.11 8.22Q8.25 7.72 8.25 7Q8.25 6.28 8.11 5.78Q7.96 5.27 7.68 5.01Q7.4 4.75 7 4.75Q6.6 4.75 6.32 5.01Q6.04 5.28 5.89 5.78Q5.75 6.28 5.75 7Q5.75 7.72 5.89 8.22Q6.04 8.72 6.32 8.99Q6.6 9.25 7 9.25Z","1":"M8.44 3.73V10.27H7.1V4.91H7.06L5.56 5.97V4.74L7 3.73Z","2":"M4.71 10.32V9.35L7.04 7.18Q7.33 6.89 7.54 6.65Q7.74 6.42 7.85 6.19Q7.96 5.96 7.96 5.7Q7.96 5.4 7.83 5.19Q7.69 4.98 7.47 4.87Q7.24 4.75 6.94 4.75Q6.64 4.75 6.41 4.88Q6.18 5 6.06 5.23Q5.94 5.46 5.94 5.78H4.65Q4.65 5.14 4.95 4.67Q5.24 4.2 5.76 3.94Q6.27 3.68 6.95 3.68Q7.65 3.68 8.16 3.93Q8.68 4.18 8.97 4.61Q9.26 5.05 9.26 5.62Q9.26 5.98 9.12 6.34Q8.97 6.69 8.61 7.13Q8.24 7.58 7.57 8.19L6.58 9.17V9.21H9.35V10.32Z","3":"M6.98 10.36Q6.27 10.36 5.72 10.12Q5.17 9.87 4.85 9.44Q4.53 9 4.52 8.44H5.87Q5.88 8.68 6.03 8.87Q6.18 9.05 6.43 9.15Q6.68 9.25 6.98 9.25Q7.31 9.25 7.56 9.14Q7.8 9.03 7.94 8.82Q8.08 8.62 8.08 8.35Q8.08 8.08 7.94 7.87Q7.79 7.67 7.52 7.55Q7.24 7.44 6.86 7.44H6.26V6.44H6.86Q7.18 6.44 7.42 6.33Q7.67 6.21 7.8 6.02Q7.94 5.82 7.94 5.56Q7.94 5.3 7.82 5.11Q7.71 4.93 7.49 4.82Q7.28 4.71 6.99 4.71Q6.71 4.71 6.47 4.81Q6.23 4.92 6.09 5.1Q5.94 5.29 5.94 5.54H4.65Q4.66 4.98 4.97 4.55Q5.28 4.12 5.81 3.88Q6.34 3.64 7 3.64Q7.67 3.64 8.18 3.88Q8.69 4.13 8.96 4.55Q9.24 4.97 9.24 5.48Q9.24 6.02 8.9 6.39Q8.56 6.76 8.02 6.87V6.92Q8.49 6.98 8.82 7.18Q9.15 7.39 9.31 7.71Q9.48 8.03 9.48 8.44Q9.48 9 9.16 9.43Q8.84 9.87 8.27 10.11Q7.71 10.36 6.98 10.36Z","4":"M4.38 9.11V8.05L7.12 3.73H8.03V5.2H7.49L5.73 7.98V8.03H9.62V9.11ZM7.51 10.27V8.79L7.54 8.31V3.73H8.8V10.27Z","5":"M6.96 10.32Q6.29 10.32 5.77 10.07Q5.24 9.82 4.93 9.39Q4.63 8.95 4.61 8.39H5.92Q5.93 8.65 6.08 8.84Q6.22 9.04 6.45 9.15Q6.69 9.25 6.96 9.25Q7.29 9.25 7.54 9.11Q7.8 8.96 7.94 8.7Q8.09 8.43 8.09 8.09Q8.09 7.74 7.94 7.47Q7.79 7.2 7.54 7.05Q7.28 6.9 6.94 6.9Q6.65 6.9 6.38 7.02Q6.11 7.13 5.96 7.33L4.75 7.12L5.06 3.68H9.03V4.79H6.18L6.01 6.45H6.04Q6.22 6.21 6.56 6.06Q6.91 5.9 7.33 5.9Q7.78 5.9 8.15 6.06Q8.53 6.22 8.8 6.51Q9.08 6.79 9.23 7.19Q9.39 7.58 9.39 8.05Q9.39 8.71 9.08 9.22Q8.78 9.73 8.23 10.03Q7.68 10.32 6.96 10.32Z","6":"M7.08 10.36Q6.58 10.36 6.12 10.19Q5.65 10.03 5.29 9.66Q4.92 9.29 4.7 8.67Q4.49 8.05 4.49 7.15Q4.49 6.33 4.67 5.68Q4.86 5.03 5.2 4.57Q5.55 4.11 6.04 3.88Q6.53 3.64 7.13 3.64Q7.78 3.64 8.27 3.89Q8.77 4.14 9.07 4.57Q9.38 5 9.44 5.54H8.12Q8.04 5.19 7.78 4.99Q7.52 4.79 7.13 4.79Q6.7 4.79 6.4 5.05Q6.11 5.3 5.96 5.77Q5.81 6.24 5.81 6.89H5.85Q6 6.6 6.25 6.39Q6.5 6.19 6.82 6.08Q7.14 5.97 7.49 5.97Q8.07 5.97 8.53 6.24Q8.98 6.51 9.25 6.99Q9.51 7.47 9.51 8.09Q9.51 8.75 9.2 9.26Q8.9 9.78 8.35 10.07Q7.81 10.36 7.08 10.36ZM7.07 9.3Q7.4 9.3 7.65 9.14Q7.91 8.99 8.06 8.72Q8.21 8.45 8.21 8.12Q8.21 7.79 8.06 7.53Q7.92 7.26 7.66 7.11Q7.41 6.95 7.08 6.95Q6.84 6.95 6.63 7.04Q6.43 7.14 6.27 7.3Q6.11 7.46 6.03 7.67Q5.94 7.88 5.94 8.12Q5.94 8.45 6.09 8.71Q6.23 8.98 6.49 9.14Q6.75 9.3 7.07 9.3Z","7":"M5.16 10.27 7.89 4.88V4.83H4.71V3.73H9.29V4.85L6.55 10.27Z","8":"M7 10.36Q6.26 10.36 5.69 10.12Q5.13 9.88 4.8 9.46Q4.48 9.04 4.48 8.52Q4.48 8.11 4.67 7.76Q4.86 7.42 5.17 7.19Q5.49 6.96 5.89 6.89V6.85Q5.37 6.74 5.04 6.34Q4.72 5.93 4.72 5.4Q4.72 4.89 5.01 4.49Q5.31 4.1 5.82 3.87Q6.34 3.64 7 3.64Q7.65 3.64 8.17 3.87Q8.68 4.1 8.98 4.49Q9.28 4.89 9.28 5.4Q9.28 5.93 8.95 6.34Q8.62 6.74 8.11 6.85V6.89Q8.5 6.96 8.82 7.19Q9.14 7.42 9.33 7.76Q9.52 8.11 9.52 8.52Q9.52 9.04 9.19 9.46Q8.87 9.88 8.3 10.12Q7.73 10.36 7 10.36ZM7 9.37Q7.33 9.37 7.58 9.25Q7.83 9.13 7.98 8.91Q8.12 8.69 8.12 8.41Q8.12 8.12 7.97 7.9Q7.83 7.68 7.57 7.55Q7.32 7.42 7 7.42Q6.67 7.42 6.42 7.54Q6.17 7.67 6.02 7.89Q5.88 8.12 5.88 8.41Q5.88 8.69 6.01 8.91Q6.15 9.12 6.41 9.25Q6.66 9.37 7 9.37ZM7 6.43Q7.28 6.43 7.49 6.32Q7.71 6.2 7.84 6Q7.96 5.8 7.96 5.54Q7.96 5.28 7.84 5.08Q7.72 4.88 7.5 4.77Q7.28 4.66 7 4.66Q6.71 4.66 6.49 4.77Q6.27 4.88 6.15 5.08Q6.03 5.28 6.03 5.54Q6.03 5.8 6.15 6Q6.27 6.2 6.49 6.32Q6.71 6.43 7 6.43Z","9":"M6.87 10.37Q6.22 10.37 5.73 10.12Q5.23 9.86 4.92 9.43Q4.62 8.99 4.55 8.45H5.88Q5.96 8.8 6.22 9.01Q6.48 9.21 6.87 9.21Q7.3 9.21 7.6 8.96Q7.89 8.7 8.05 8.23Q8.2 7.76 8.2 7.11H8.15Q8 7.39 7.76 7.6Q7.51 7.8 7.19 7.92Q6.87 8.03 6.51 8.03Q5.93 8.03 5.47 7.76Q5.01 7.48 4.75 7Q4.49 6.53 4.49 5.91Q4.49 5.25 4.8 4.73Q5.1 4.21 5.65 3.92Q6.2 3.62 6.93 3.63Q7.42 3.63 7.89 3.8Q8.35 3.97 8.71 4.34Q9.08 4.71 9.3 5.33Q9.51 5.94 9.51 6.84Q9.51 7.67 9.32 8.33Q9.14 8.98 8.79 9.43Q8.45 9.89 7.96 10.13Q7.47 10.37 6.87 10.37ZM6.92 7.04Q7.16 7.04 7.37 6.95Q7.58 6.86 7.73 6.69Q7.89 6.53 7.97 6.32Q8.06 6.11 8.06 5.87Q8.06 5.55 7.91 5.29Q7.77 5.02 7.51 4.86Q7.26 4.7 6.93 4.7Q6.61 4.7 6.35 4.86Q6.09 5.01 5.94 5.28Q5.79 5.55 5.79 5.88Q5.79 6.2 5.94 6.47Q6.09 6.73 6.34 6.89Q6.59 7.04 6.92 7.04Z"};
  function initialMark(ch) {
    const d = GLYPHS[ch];
    return '<svg class="vn-ap-ic" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6.5"/>'
      + (d ? '<path d="' + d + '"/>' : '<text x="7" y="10.27" text-anchor="middle">' + esc(ch) + '</text>') + '</svg>';
  }

  /** Put a project pill on each card and row just drawn: the project's
   *  initial in a small tile (as in the picker) and its name, in neutral grey.
   *  Runs after every render. */
  function decorate() {
    patchSocket();
    const roots = [document.getElementById('session-list'), document.getElementById('workforce-grid')].filter(Boolean);
    for (const root of roots) {
      root.classList.toggle('vn-ap', on());
      if (!on()) { root.querySelectorAll('.vn-ap-label').forEach(x => x.remove()); continue; }
      for (const row of root.querySelectorAll(':scope > .session-item[data-sid], :scope > .wf-card[data-sid]')) {
        row.querySelectorAll('.vn-ap-label').forEach(x => x.remove());
        const enc = projectOf(row.dataset.sid);
        const nameEl = row.querySelector('.session-col-name, .wf-name');
        if (!enc || !nameEl) continue;
        const nm = name(enc);
        const tag = document.createElement('span');
        tag.className = 'vn-ap-label';
        tag.title = nm;
        tag.innerHTML = initialMark((nm.trim().charAt(0) || '?').toUpperCase())
          + '<span class="vn-ap-nm">' + esc(nm) + '</span>';
        if (row.classList.contains('wf-card')) { nameEl.insertAdjacentElement('afterend', tag); continue; }
        // Wrap the bare title text so the pill keeps its place when the title is cut short.
        if (!nameEl.querySelector(':scope > .vn-ap-t')) {
          const t = Array.from(nameEl.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
          if (t) { const w = document.createElement('span'); w.className = 'vn-ap-t'; t.replaceWith(w); w.appendChild(t); }
        }
        const pin = nameEl.querySelector(':scope > .vn-pin');
        if (pin) nameEl.insertBefore(tag, pin); else nameEl.appendChild(tag);
      }
    }
  }

  /** The summary path's root in All projects: the session's project. */
  function pathRoot() {
    if (!on()) return '';
    const sid = (typeof liveSessionId !== 'undefined' && liveSessionId) || (typeof activeId !== 'undefined' && activeId) || '';
    const enc = projectOf(sid) || localStorage.getItem('activeProject') || '';
    return name(enc);
  }

  window.VNAllProjects = { ALL, on, set, name, projectOf, fetchAll, beforeOpen, decorate, pathRoot,
    adopt, useProject, projectFor, settingsKey, chooseProject, choosing, finishChoice, beforeNewSession,
    PER_PROJECT_VIEWS, openPerProjectView, patchSocket,
    shown, included, setIncluded, narrowed, includesCwd, label };
})();
