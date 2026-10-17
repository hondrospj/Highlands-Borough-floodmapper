/* Open the town's Road Risk workbench without losing the current flood map. */
(() => {
  const launch = document.getElementById('roadRiskOpenBtn');
  if (!launch || document.getElementById('roadRiskDialog')) return;
  const style = document.createElement('style');
  style.textContent = `
    #roadRiskLaunchCard { padding: 0 !important; order: 2 !important; }
    #roadRiskOpenBtn { display: flex !important; align-items: center; justify-content: space-between;
      width: 100%; min-height: 44px; margin: 0; padding: 12px 14px; border: 0; border-radius: 12px;
      background: transparent; color: inherit; font: inherit; font-weight: 750; text-align: left; cursor: pointer; }
    #roadRiskOpenBtn::after { content: '↗'; font-size: 18px; }
    #roadRiskOpenBtn:focus-visible, #roadRiskCloseBtn:focus-visible { outline: 3px solid #83e7ff; outline-offset: -4px; }
    #roadRiskDialog { box-sizing: border-box; position: fixed; inset: 12px; width: calc(100% - 24px);
      height: calc(100dvh - 24px); max-width: none; max-height: none; margin: 0; padding: 0;
      border: 1px solid #394957; border-radius: 16px; overflow: hidden; background: #0b1724; color: #eef7ff; }
    #roadRiskDialog::backdrop { background: #06101dc9; }
    #roadRiskDialog[open] { display: flex; flex-direction: column; }
    #roadRiskDialogHeader { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between;
      gap: 12px; min-height: 52px; padding: 4px 10px 4px 18px; border-bottom: 1px solid #394957;
      background: #0b1724; font: 700 16px/1.3 system-ui, sans-serif; }
    #roadRiskDialogTitle { margin: 0; font: inherit; }
    #roadRiskCloseBtn { display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      min-height: 44px; min-width: 92px; margin: 0; padding: 8px 14px; border: 1px solid #526579;
      border-radius: 10px; background: #1a2a3b; color: #fff; font: 700 14px/1 system-ui, sans-serif; cursor: pointer; }
    #roadRiskFrame { display: block; flex: 1 1 auto; width: 100%; min-height: 0; border: 0; background: #0b1724; }
    @media (max-width: 700px) {
      #roadRiskDialog { inset: 0; width: 100%; height: 100dvh; border: 0; border-radius: 0; }
      #roadRiskDialogHeader { padding-top: max(4px, env(safe-area-inset-top)); }
    }
  `;
  document.head.append(style);
  const dialog = document.createElement('dialog');
  dialog.id = 'roadRiskDialog';
  dialog.setAttribute('aria-labelledby', 'roadRiskDialogTitle');
  dialog.dataset.html2canvasIgnore = 'true';
  dialog.innerHTML = '<header id="roadRiskDialogHeader"><h2 id="roadRiskDialogTitle">Road Risk</h2><button id="roadRiskCloseBtn" type="button" aria-label="Close Road Risk">Close <span aria-hidden="true">×</span></button></header><iframe id="roadRiskFrame" title="Road Risk workbench"></iframe>';
  document.body.append(dialog);
  const frame = dialog.querySelector('iframe');
  const close = dialog.querySelector('button');
  launch.setAttribute('aria-controls', dialog.id);
  launch.setAttribute('aria-haspopup', 'dialog');
  launch.setAttribute('aria-expanded', 'false');
  launch.addEventListener('click', () => {
    if (!frame.hasAttribute('src')) frame.src = launch.dataset.roadRiskUrl;
    if (!dialog.open) dialog.showModal();
    launch.setAttribute('aria-expanded', 'true');
    close.focus();
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    launch.setAttribute('aria-expanded', 'false');
    launch.focus({ preventScroll: true });
  });
  // Escape also closes the workbench when keyboard focus is inside its iframe.
  frame.addEventListener('load', () => {
    try {
      frame.contentDocument.addEventListener('keydown', event => {
        if (event.key === 'Escape' && dialog.open) {
          event.preventDefault();
          dialog.close();
        }
      });
    } catch (_) { /* The visible Close button also works across origins. */ }
  });
})();
