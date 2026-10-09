/* Desktop height clearance only. CSS owns pane geometry and the main app owns
   legend placement; this controller never moves cards or fits mobile controls. */
(() => {
  const owned = new Map();
  let queued = false;
  function set(element, property, value) {
    let properties = owned.get(element);
    if (!properties) { properties = new Set(); owned.set(element, properties); }
    properties.add(property);
    if (element.style.getPropertyValue(property) !== value || element.style.getPropertyPriority(property) !== 'important') {
      element.style.setProperty(property, value, 'important');
    }
  }
  function clear() {
    for (const [element, properties] of owned) {
      for (const property of properties) element.style.removeProperty(property);
    }
    owned.clear();
  }
  function fit() {
    queued = false;
    updateTimelinePresentation();
    if (isCompactFloodmapperLayout()) { clear(); return; }
    const timeline = document.getElementById('timelineDock');
    if (!timeline) return;
    const timelineTop = timeline.getBoundingClientRect().top;
    for (const id of ['leftPanel', 'rightRail']) {
      // The hosted rail already has a height controller. Keep a single writer.
      if (id === 'rightRail' && document.getElementById('shorelysafe-pane-fit-script-v1')) continue;

      const pane = document.getElementById(id);
      if (!pane || !pane.getClientRects().length) continue;
      const top = pane.getBoundingClientRect().top;
      const clearance = id === 'rightRail' ? 12 : 8;
      const room = Math.max(0, Math.floor(Math.min(innerHeight - 8, timelineTop - clearance) - top));
      set(pane, 'max-height', `${room}px`);
    }
    fitMapTitleBadgeToViewport();
  }
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(fit);
  }
  function init() {
    const timeline = document.getElementById('timelineDock');
    if (!timeline) return;
    new ResizeObserver(schedule).observe(timeline);
    new MutationObserver(schedule).observe(document.body, {attributes:true, attributeFilter:['class']});
    window.addEventListener('resize', schedule, {passive:true});
    floodmapperLayoutMedia.addEventListener('change', schedule);
    window.addEventListener('load', schedule, {once:true});
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();
