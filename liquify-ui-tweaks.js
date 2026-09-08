// liquify-ui-tweaks — UI removals that CSS cannot express.
//
// Spotify's "Your Library" filter chips are React-Aria [role=option] nodes with
// generated ids (react-aria-1, ...) and no text-, testid- or aria-hook. CSS has
// no text selector, so hiding a specific chip by label has to be done in JS.
//
// Everything else in this setup is a plain CSS snippet; only put things here
// that genuinely need script.

(function liquifyUiTweaks() {
  if (!document.body) return setTimeout(liquifyUiTweaks, 300);

  // Chip labels to remove from the library filter row.
  const HIDE_CHIPS = new Set(['podcasts', 'podcasts & shows', 'shows']);

  const HIDDEN = 'data-lqx-hidden';

  function sweep(root) {
    let boxes;
    try {
      boxes = (root instanceof Element ? root : document)
        .querySelectorAll('[role="listbox"][aria-label="Filter options"], [role="listbox"]');
    } catch { return; }
    for (const box of boxes) {
      for (const opt of box.querySelectorAll('[role="option"]')) {
        if (opt.hasAttribute(HIDDEN)) continue;
        const label = (opt.textContent || '').trim().toLowerCase();
        if (!label) continue;
        if (HIDE_CHIPS.has(label)) {
          opt.setAttribute(HIDDEN, '1');
          opt.style.setProperty('display', 'none', 'important');
        }
      }
    }
  }

  // Chips mount and remount as the library re-renders; a debounced observer on
  // the sidebar keeps them gone without scanning the whole document.
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; sweep(document); }, 120);
  };

  sweep(document);
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });

  window.liquifyUiTweaks = { sweep, HIDE_CHIPS };
})();
