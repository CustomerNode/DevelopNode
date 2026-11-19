/* One clock for the looping working animations (css/hairline.css: hl-swing, hl-chips).
 * A CSS animation starts when its element is drawn, so session boxes drawn at different moments (a new session, a
 * repaint of one row) swing out of step.  Every time one of these animations starts, all of them are pinned to the
 * document timeline's origin (startTime 0): with one shared duration they are then in step by construction, however
 * and whenever their elements were drawn. */
(function () {
  'use strict';
  const NAMES = new Set(['hl-swing', 'hl-chips']);
  function pin() {
    if (typeof document.getAnimations !== 'function') return;
    for (const a of document.getAnimations()) {
      if (NAMES.has(a.animationName) && a.startTime !== 0) a.startTime = 0;
    }
  }
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; pin(); });
  }
  document.addEventListener('animationstart', (e) => { if (NAMES.has(e.animationName)) schedule(); }, true);
  schedule();
})();
