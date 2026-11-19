/* Builds the edges of an end-of-turn summary that scrolling has cut off (css/hairline.css): one row per part out of
 * view, inside the bubble's rounded top and bottom edges.
 *   Summary          - its Short / Plain words / Full switch; picking a level switches the summary and shows it;
 *   Details          - its name;
 *   Review & respond - every answer it offers: Validate's Try it and Look, Decide's button, and one Respond button
 *                      that opens the verdict answers; all show while the last of them is out of view, and each
 *                      presses the real one.
 * The browser shows and hides the rows through scroll-driven animations, so nothing here runs while scrolling.  This
 * only builds the rows when a summary is drawn or redrawn, and keeps the switch's open level in step. */
(function () {
  'use strict';
  if (document.documentElement.getAttribute('data-finish') !== 'hairline') return;
  const ICON = {
    top: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>',
    bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  };
  /* Each answer button leads with a small icon for what it opens, so the row reads at a glance: the same play and
   * picture the Try it yourself / just look tiles use, a fork for Decide, a reply arrow for Respond. */
  const DO_ICON = {
    try: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
    look: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5L5 20"/>',
    decide: '<circle cx="6" cy="5" r="2.2"/><circle cx="18" cy="5" r="2.2"/><circle cx="12" cy="19" r="2.2"/><path d="M6 7.2v1.3a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V7.2M12 12.5v4.3"/>',
    respond: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  };
  const doIcon = (k) => '<svg class="hl-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + DO_ICON[k] + '</svg>';
  // laid out on screen (a hidden wrapper hides a child whose own display still says inline-flex)
  const shown = (el) => !!el && el.getClientRects().length > 0;
  /* The parts of a summary, each with what its row offers. */
  function parts(card) {
    const out = [];
    const answer = card.querySelector(':scope > .lm-answer');
    if (answer) {
      const tabs = [...answer.querySelectorAll('.lm-depth-b')].map(b => ({ label: b.textContent.trim(), real: b }));
      out.push({ g: 'a', label: 'Summary', el: answer, tabs });
    }
    const det = card.querySelectorAll(':scope > :is(.lm-status, .lm-checked, .lm-hist)');
    if (det.length) out.push({ g: 'd', label: 'Details', el: det[0] });
    const move = card.querySelector(':scope > .lm-move');
    if (move) {
      // every answer Review & respond offers, in its own order: Validate's Try it and Look, Decide's button, the
      // verdict chips (only those on screen, by their own names)
      const acts = [];
      const tryIt = move.querySelector('.vt-try');
      if (shown(tryIt)) acts.push({ label: 'Try it', icon: 'try', real: tryIt });
      const look = move.querySelector('.vt-pic');
      if (shown(look)) acts.push({ label: 'Look', icon: 'look', real: look });
      const decide = move.querySelector('.lm-decide');
      if (shown(decide)) acts.push({ label: decide.textContent.trim(), icon: 'decide', real: decide, main: true });
      // the verdict answers (Done, Something else, Problem, Standby) are one Respond button that opens them
      const chips = [...move.querySelectorAll('.lm-yv button[data-verdict]:not([data-verdict="undo"])')].filter(shown).map(b => ({
        label: ((b.querySelector('.tt') || b).textContent || '').trim(),
        sub: ((b.querySelector('.ts') || {}).textContent || '').trim(), real: b }));
      if (chips.length) acts.push({ label: 'Respond', icon: 'respond', menu: chips, real: chips[chips.length - 1].real });
      // the bottom row stays while the LAST answer is still below, so none of them is ever out of reach; while the
      // row shows, every answer in it shows
      out.push({ g: 'm', label: 'Review & respond', el: move, acts, anchor: acts.length ? acts[acts.length - 1].real : move });
    }
    return out;
  }
  function signature(list) {
    return list.map(p => p.g + ':' + (p.tabs || []).map(t => t.label).join(',') + ':' + (p.acts || []).map(a => a.label).join(',')).join('|') + '#8';
  }
  function jump(el) {
    const log = document.getElementById('live-log');
    if (!el || !log) return;
    // Land the part just below the line where its edge row takes over (its view-timeline inset, css/hairline.css), so
    // the part's own heading shows whole and the edge row hides; landing above that line left the real heading
    // half-covered under the edge row that repeats it.
    let line = parseFloat(getComputedStyle(el).viewTimelineInset);
    if (!(line >= 0)) line = (parseFloat(getComputedStyle(log).getPropertyValue('--vn-stick-top')) || 0) + 56;
    const top = el.getBoundingClientRect().top - log.getBoundingClientRect().top - log.clientTop + log.scrollTop - line - 8;
    log.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
  function syncTabs(card) {
    card.querySelectorAll(':scope > .hl-edge .hl-tab').forEach(t => {
      const real = t._real;
      t.classList.toggle('on', !!real && real.getAttribute('aria-pressed') === 'true');
    });
  }
  /* The Respond menu: the verdict answers, each pressing its real button.  It opens away from the edge (up from the
   * bottom edge, down from the top one) and closes on a pick, a click elsewhere or Escape. */
  function closeMenu() { document.querySelectorAll('.hl-menu').forEach(m => m.remove()); }
  function toggleMenu(btn, items, side) {
    const open = btn.closest('.in').querySelector('.hl-menu');
    closeMenu();
    if (open) return;
    const m = document.createElement('div');
    m.className = 'hl-menu ' + side;
    m.setAttribute('role', 'menu');
    for (const it of items) {
      const o = document.createElement('button');
      o.type = 'button';
      o.setAttribute('role', 'menuitem');
      // the answer's own coloured icon (read from the real button, in the colour it is drawn in there) and its name
      const ic = it.real.querySelector('.ic');
      o.innerHTML = '<i class="hl-mi"></i><b></b>';
      if (ic) { o.firstChild.innerHTML = ic.innerHTML; o.firstChild.style.color = getComputedStyle(ic).color; }
      o.lastChild.textContent = it.label;
      o.title = it.sub;
      o.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenu(); it.real.click(); });
      m.append(o);
    }
    btn.closest('.in').append(m);
  }
  document.addEventListener('click', (ev) => { if (!ev.target.closest || !ev.target.closest('.hl-menu')) closeMenu(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMenu(); });
  function strip(card, side, list) {
    const e = document.createElement('div');
    e.className = 'hl-edge ' + side;
    const box = document.createElement('div');
    box.className = 'in';
    const fade = document.createElement('div');
    fade.className = 'hl-fade';
    if (side === 'bot') box.append(fade);
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'hl-row';
      row.dataset.g = p.g;
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'hl-go';
      go.innerHTML = '<span></span>' + ICON[side];
      go.firstChild.textContent = p.label;
      go.addEventListener('click', (ev) => { ev.stopPropagation(); jump(p.el); });
      row.append(go);
      const acts = document.createElement('div');
      acts.className = 'hl-acts';
      for (const t of p.tabs || []) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hl-tab';
        b.textContent = t.label;
        b._real = t.real;
        b.addEventListener('click', (ev) => { ev.stopPropagation(); t.real.click(); syncTabs(card); jump(p.el); });
        acts.append(b);
      }
      for (const a of p.acts || []) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hl-do' + (a.main ? ' main' : '');
        b.innerHTML = (a.icon ? doIcon(a.icon) : '') + '<span></span>';
        b.querySelector('span').textContent = a.label;
        if (a.menu) {
          b.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>');
          b.setAttribute('aria-haspopup', 'menu');
          b.addEventListener('click', (ev) => { ev.stopPropagation(); toggleMenu(b, a.menu, side); });
        } else {
          b.addEventListener('click', (ev) => { ev.stopPropagation(); a.real.click(); });
        }
        acts.append(b);
      }
      if (acts.childElementCount) row.append(acts);
      box.append(row);
    }
    if (side === 'top') box.append(fade);
    if (side === 'bot') { const cap = document.createElement('div'); cap.className = 'hl-cap'; box.append(cap); }
    e.append(box);
    return e;
  }
  function prep(card) {
    const list = parts(card);
    // tag what the rows' timelines follow: Details' first and last rows, and Review & respond's answer
    const det = card.querySelectorAll(':scope > :is(.lm-status, .lm-checked, .lm-hist)');
    if (det.length) { det[0].classList.add('hl-d1'); det[det.length - 1].classList.add('hl-d2'); }
    const m = list.find(p => p.g === 'm');
    card.querySelectorAll('.hl-act').forEach(el => { if (!m || el !== m.anchor) el.classList.remove('hl-act'); });
    if (m && !m.anchor.classList.contains('hl-act')) m.anchor.classList.add('hl-act');
    card.querySelectorAll('[data-hlx]').forEach(el => { el.removeAttribute('data-hlx'); el.style.removeProperty('view-timeline-name'); });
    const sig = signature(list);
    for (const side of ['top', 'bot']) {
      const old = card.querySelector(':scope > .hl-edge.' + side);
      if (old && old.dataset.sig === sig) continue;
      if (old) old.remove();
      const s = strip(card, side, list);
      s.dataset.sig = sig;
      if (side === 'top') card.prepend(s); else card.append(s);
    }
    syncTabs(card);
  }
  let queued = false;
  function scan() {
    queued = false;
    document.querySelectorAll('#live-log .lm.skim').forEach(prep);
  }
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(scan); } })
    .observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  scan();
})();
