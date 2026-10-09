/* Startup owns the ready signal; this controller only owns the welcome overlay. */
(() => {
  function init() {
    const loader = document.getElementById('nwSiteLoader');
    const app = document.getElementById('app');
    if (!loader || !app) return;
    let finished = false;
    let deadline;
    const startedAt = performance.now();
    let simulatedProgress = 8;
    const progressTimer = setInterval(() => {
      simulatedProgress = Math.min(76, simulatedProgress + (simulatedProgress < 42 ? 3 : 1));
      setNorthWildwoodLoadingState(simulatedProgress);
    }, 240);
    const background = new Map();
    const observer = new MutationObserver(checkReady);
    app.setAttribute('aria-busy', 'true');
    function isolateControls() {
      // Mobile places its Controls and Key buttons outside the app container.
      for (const id of ['app', 'mobileControlsToggle', 'legendDock']) {
        const element = document.getElementById(id);
        if (!element || background.has(element)) continue;
        background.set(element, element.inert);
        element.inert = true;
      }
    }
    function setNorthWildwoodLoadingState(progress, message) {
      const bar = document.getElementById('nwLoaderProgress');
      const status = document.getElementById('nwLoaderStatus');
      let acceptsMessage = !Number.isFinite(Number(progress));
      if (bar && Number.isFinite(Number(progress))) {
        const current = Number(bar.dataset.progress || 0);
        const requested = Math.min(100, Number(progress));
        const next = Math.max(current, requested);
        acceptsMessage = requested >= current;
        bar.dataset.progress = String(next);
        bar.style.width = `${next}%`;
      }
      if (status && message && acceptsMessage) status.textContent = message;
    }
    function reveal(reason) {
      document.body.dataset.siteLoader = reason;
      document.body.classList.remove('nw-app-loading');
      for (const [element, inert] of background) element.inert = inert;
      app.setAttribute('aria-busy', 'false');
      loader.classList.add('is-fading');
      loader.setAttribute('aria-hidden', 'true');
      const hide = () => { loader.hidden = true; };
      if (window.matchMedia('(prefers-reduced-motion:reduce)').matches) hide();
      else setTimeout(hide, 700);
    }
    function finish(reason) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearInterval(progressTimer);
      observer.disconnect();
      if (reason === 'timeout') { reveal(reason); return; }
      setNorthWildwoodLoadingState(100, 'Floodmapper ready');
      if (window.matchMedia('(prefers-reduced-motion:reduce)').matches) reveal(reason);
      else {
        // Preserve the original minimum display, completion pause and fade.
        const remaining = Math.max(0, 800 - (performance.now() - startedAt));
        setTimeout(() => reveal(reason), remaining + 260);
      }
    }
    function checkReady() {
      if (document.body.classList.contains('nw-app-ready')) finish('complete');
      else if (!finished) {
        isolateControls();
        if (document.body.dataset.initialFloodFrame === 'ready') {
          setNorthWildwoodLoadingState(68, 'Drawing the current flood map…');
        }
      }
    }
    isolateControls();
    observer.observe(document.body, {attributes:true, attributeFilter:['class', 'data-initial-flood-frame']});
    // Release the interface even if an external library or request never finishes.
    deadline = setTimeout(() => finish('timeout'), 20000);
    checkReady();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();
