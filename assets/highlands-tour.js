/* A guided tour of the controls actually available in Highlands. No data or
   selected forecast/date is changed while the user walks through the tour. */
(() => {
  const overlay = document.getElementById('mapperTutorial');
  const card = document.getElementById('mapperTutorialCard');
  const spotlight = document.getElementById('mapperTutorialSpotlight');
  const launch = document.getElementById('mapperTutorialBtn');
  const next = document.getElementById('mapperTutorialNext');
  const back = document.getElementById('mapperTutorialBack');
  if (!overlay || !card || !launch) return;
  const steps = [
    ['Welcome to Highlands Floodmapper', '#mapTitleBadge', 'Explore forecast flooding, replay past water levels, and save maps of Highlands. The map and timeline show the same selected water level.'],
    ['Choose your flood data', '.data-source-card', 'Forecast looks ahead. Past opens the tide-gauge archive: select Choose date or type a date, then use the arrows to move between days.'],
    ['Choose a range or date', '#forecastScenarioCard,#calendarCard', 'In Forecast, compare Lower end, Mean, and Upper end. In Past, Choose date opens the calendar without crowding the map. Help buttons explain the underlying data.'],
    ['Choose the time interval', '#timelineIntervalCard', 'Hourly and 15-Min show changes through time. Daily Max shows the highest available water level for each day, at its actual timestamp. In Past, use the date arrows to compare days.'],
    ['Read the flood map', '.overlay-card', 'Flood Depth shows shallow to deep water. Flood Stages uses separate Minor, Moderate, and Major bands. Green represents uncertainty. Opacity adjusts how much of the map shows through.'],
    ['Move through time', '#timelineDock', 'Drag the slider, select a day, or press Play. The date, time, water level, and mapped flooding update together. On a phone, use the step buttons for precise changes.'],
    ['Choose map layers', '.layers-card', 'Satellite switches to aerial imagery. Road names controls street labels when you zoom in. Cameras opens the available camera locations.'],
    ['Explore historic crests', '.top-tides-card', 'Choose a Top 10 flood to view its crest. Show more opens the full list. Some older events contain only the peak water level, rather than a complete timeline.'],
    ['Find a place and save a map', '#townAddressCard,#downloadCard', 'Search for a Highlands address or street. Export Map lets you save a PNG or animated GIF, including the selected map imagery and flood legend.']
  ];
  let index = 0, frame = 0, savedDrawer = false, savedGroup = 'forecast';
  const panel = document.getElementById('leftPanel');
  function target() {
    const selector = steps[index][1];
    document.dispatchEvent(new CustomEvent('nww:reveal-control', {detail: selector}));
    if (isCompactFloodmapperLayout()) {
      const candidate = document.querySelector(selector);
      setMobileControlsOpen(Boolean(candidate?.closest('#leftPanel,#mobileRailMount')));
    }
    return [...document.querySelectorAll(selector)].find(element =>
      element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  }
  function position() {
    frame = 0;
    if (overlay.hidden) return;
    const element = target();
    if (!element) { spotlight.hidden = true; return; }
    spotlight.hidden = false;
    const rect = element.getBoundingClientRect();
    const margin = 12, pad = 5, gap = 18;
    const left = Math.max(4, rect.left - pad), top = Math.max(4, rect.top - pad);
    const right = Math.min(innerWidth - 4, rect.right + pad), bottom = Math.min(innerHeight - 4, rect.bottom + pad);
    Object.assign(spotlight.style, {left:`${left}px`, top:`${top}px`, width:`${Math.max(0,right-left)}px`, height:`${Math.max(0,bottom-top)}px`});
    const width = card.offsetWidth, height = card.offsetHeight;
    const candidates = [[right+gap,top],[left-width-gap,top],[left,bottom+gap],[left,top-height-gap],[margin,margin],[margin,innerHeight-height-margin]]
      .map(([x,y]) => ({x:Math.max(margin,Math.min(innerWidth-width-margin,x)), y:Math.max(margin,Math.min(innerHeight-height-margin,y))}));
    const overlap = ({x,y}) => Math.max(0,Math.min(x+width,right)-Math.max(x,left))*Math.max(0,Math.min(y+height,bottom)-Math.max(y,top));
    candidates.sort((a,b) => overlap(a)-overlap(b));
    card.style.left = `${candidates[0].x}px`; card.style.top = `${candidates[0].y}px`;
  }
  function schedule() { if (!frame && !overlay.hidden) frame = requestAnimationFrame(position); }
  function render() {
    document.getElementById('mapperTutorialProgress').textContent = `${index+1} of ${steps.length}`;
    document.getElementById('mapperTutorialTitle').textContent = steps[index][0];
    document.getElementById('mapperTutorialBody').textContent = steps[index][2];
    back.disabled = index === 0;
    next.textContent = index === steps.length-1 ? 'Finish' : 'Next';
    const element = target();
    if (element?.closest('#leftPanel,#rightRail')) element.scrollIntoView({block:'nearest'});
    schedule();
  }
  function close() {
    if (overlay.hidden) return;
    overlay.hidden = true; overlay.classList.remove('open'); overlay.setAttribute('aria-hidden','true');
    launch.setAttribute('aria-expanded','false');
    document.body.classList.remove('tutorial-active');
    cancelAnimationFrame(frame); frame = 0;
    if (isCompactFloodmapperLayout()) {
      panel.querySelector(`[data-group="${savedGroup}"]`)?.click();
      setMobileControlsOpen(savedDrawer);
    }
    rememberFloodmapperDialogFocus(overlay,false);
  }
  launch.addEventListener('click', () => {
    savedDrawer = document.body.classList.contains('mobile-controls-open');
    savedGroup = panel.dataset.nwwSection || 'forecast';
    rememberFloodmapperDialogFocus(overlay,true);
    overlay.hidden = false; overlay.classList.add('open'); overlay.setAttribute('aria-hidden','false');
    launch.setAttribute('aria-expanded','true'); document.body.classList.add('tutorial-active');
    stopPlayback(); index = 0; render(); next.focus({preventScroll:true});
  });
  document.getElementById('mapperTutorialClose').addEventListener('click',close);
  next.addEventListener('click', () => { if (index === steps.length-1) close(); else { index++; render(); } });
  back.addEventListener('click', () => { if (index) { index--; render(); } });
  window.addEventListener('resize',schedule,{passive:true});
  window.addEventListener('scroll',schedule,{capture:true,passive:true});
})();
