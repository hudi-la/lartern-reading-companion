// Keep modal keyboard focus in the topmost open panel and return to its trigger.
(() => {
  const panels = [...document.querySelectorAll('.overlay')];
  const stack = [];
  const saved = new Map();
  const controls = panel => [...panel.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')].filter(el => !el.closest('[hidden], [inert]') && el.getClientRects().length);
  for (const panel of panels) {
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', ({settingsPanel:'Settings',notesPanel:'Book notes',helpPanel:'How to use'})[panel.id] || 'Dialog');
    panel.tabIndex = -1;
    new MutationObserver(() => {
      const index = stack.indexOf(panel);
      if (!panel.hidden && index < 0) {
        saved.set(panel, document.activeElement);
        stack.push(panel);
        (controls(panel)[0] || panel).focus();
      } else if (panel.hidden && index >= 0) {
        const top = index === stack.length - 1;
        stack.splice(index, 1);
        const previous = saved.get(panel);
        if (top && previous?.isConnected && !previous.closest('[hidden]')) previous.focus();
        saved.delete(panel);
      }
    }).observe(panel, {attributes:true, attributeFilter:['hidden']});
  }
  document.addEventListener('keydown', e => {
    const panel = stack.at(-1);
    if (!panel) return;
    if (e.key === 'Escape') { e.preventDefault(); panel.hidden = true; return; }
    if (e.key !== 'Tab') return;
    const list = controls(panel), first = list[0], last = list.at(-1);
    if (!first) { e.preventDefault(); panel.focus(); }
    else if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement) || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement) || document.activeElement === panel)) { e.preventDefault(); first.focus(); }
  }, true);
  document.querySelectorAll('[data-close]').forEach(el => el.setAttribute('aria-label','Close dialog'));
})();
