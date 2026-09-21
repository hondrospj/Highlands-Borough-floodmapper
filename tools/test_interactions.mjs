// UI regression checks use local HTML with the municipality's public map/data assets.
// Set PLAYWRIGHT_MODULE to the installed Playwright module; UI_BROWSER=webkit is optional.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium,webkit}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repo=path.basename(root),engine=process.env.UI_BROWSER||'chromium';
const browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{})});
const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
page.setDefaultTimeout(20000);
const errors=[],results=[];
if(process.env.UI_ARTIFACTS) fs.mkdirSync(process.env.UI_ARTIFACTS,{recursive:true});
page.on('pageerror',e=>errors.push(e.message));
const url=`https://hondrospj.github.io/${repo}/`;
await page.route(url,route=>route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'index.html'),'utf8')}));
const state=()=>page.evaluate(()=>({mode:currentDataMode,view:currentViewType,scenario:currentForecastScenario,overlay:currentOverlayMode,datum:currentDatum,hour:currentHourIndex,playing:!!playTimer,date:selectedObservedDate,busy:exportInProgress}));
const pause=()=>page.waitForTimeout(300);
const openExport=async()=>{await page.locator('#openDownloadModalBtn').click();await page.waitForFunction(()=>document.querySelector('#downloadModal.open'));};
async function date(id,text){const input=page.locator('#'+id);await input.focus();await page.keyboard.press('Meta+A');await page.keyboard.type(text);await page.keyboard.press('Tab');}
async function check(name,fn){await fn();results.push(name);console.log('PASS',name);}
async function download(format){
 const promise=page.waitForEvent('download',{timeout:120000});
 await page.locator('#downloadBtn').click();
 const file=await promise;
 assert.equal(await file.failure(),null);
 const data=fs.readFileSync(await file.path());
 if(format==='png'){assert.equal(data.subarray(1,4).toString(),'PNG');assert.equal(data.readUInt32BE(16),data.readUInt32BE(20),'Square PNG dimensions');}
 else assert.match(data.subarray(0,6).toString(),/^GIF8[79]a$/);
 assert.ok(data.length>1000);
 console.log('DOWNLOAD',format,data.length,file.suggestedFilename());
 if(process.env.UI_ARTIFACTS){fs.mkdirSync(process.env.UI_ARTIFACTS,{recursive:true});await file.saveAs(path.join(process.env.UI_ARTIFACTS,file.suggestedFilename()));}
 await page.waitForFunction(()=>!exportInProgress,{},{timeout:20000});
}
try{
 await page.goto(url,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>typeof currentSeriesHours!=='undefined'&&currentSeriesHours.length&&document.getElementById('legendDock')?.dataset.mobileLegendWired==='1',null,{timeout:90000});
 await check('Forecast scenarios, overlays, datum and opacity',async()=>{
  for(const [id,key] of [['forecastHighBtn','highEnd'],['forecastLowBtn','lowEnd'],['forecastMeanBtn','mean']]){await page.locator('#'+id).click();assert.equal((await state()).scenario,key);}
  for(const [id,key] of [['dynamicModeBtn','dynamic'],['depthModeBtn','depth']]){await page.locator('#'+id).click();assert.equal((await state()).overlay,key);}
  for(const [id,key] of [['datumNavd88Btn','navd88'],['datumMllwBtn','mllw']]){await page.locator('#'+id).click();assert.equal((await state()).datum,key);}
  await page.locator('#opacitySlider').focus();await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>overlayOpacity),0.01);await page.keyboard.press('End');assert.equal(await page.evaluate(()=>overlayOpacity),1);
 });
 await check('Map zoom, pan and depth popup',async()=>{
  const zoom=await page.evaluate(()=>map.getZoom());
  await page.locator('.leaflet-control-zoom-in').click();await page.waitForFunction(old=>map.getZoom()>old&&!map._animatingZoom,zoom);
  await page.locator('.leaflet-control-zoom-out').click();await page.waitForFunction(old=>map.getZoom()===old,zoom);
  await page.mouse.move(720,450);await page.mouse.down();await page.mouse.move(770,490,{steps:8});await page.mouse.up();await pause();
  await page.mouse.click(720,450);await page.locator('.shorely-v11-depth-query').waitFor();
  await page.waitForFunction(()=>document.querySelector('.shorely-v11-depth-value')?.textContent!=='…',null,{timeout:45000});
  assert.match(await page.locator('.shorely-v11-depth-value').innerText(),/^(?:[\d.]+ (?:in|ft)|N\/A)$/);
  await page.locator('.shorely-v11-depth-popup .leaflet-popup-close-button').click();
 });
 await check('Layer switches work by keyboard and pointer',async()=>{
  for(const id of ['boundaryToggle','roadsToggle']){const el=page.locator('#'+id);await el.focus();await page.keyboard.press('Space');assert.equal(await el.getAttribute('aria-checked'),'false');await el.click();assert.equal(await el.getAttribute('aria-checked'),'true');}
 });
 await check('Timeline scrub, held clicks, keyboard playback and export pause',async()=>{
  await page.locator('#hourSlider').focus();await page.keyboard.press('Home');assert.equal((await state()).hour,0);
  await page.locator('#playBtn').click({delay:500});assert.equal((await state()).playing,true);
  await pause();await page.locator('#playBtn').click({delay:500});assert.equal((await state()).playing,false);
  await page.locator('#playBtn').focus();await page.keyboard.press('Space');assert.equal((await state()).playing,true);
  await page.keyboard.press('Enter');assert.equal((await state()).playing,false);
  await page.keyboard.press('Enter');
  await page.locator('#openDownloadModalBtn').focus();await page.keyboard.press('Enter');await pause();
  assert.equal((await state()).playing,false);
  assert.match(await page.locator('#downloadStartDateText').inputValue(),/^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'downloadStartDateText');
 });
 await check('Invalid export dates stay editable and block download',async()=>{
  await date('downloadStartDateText','02312026');
  assert.equal(await page.locator('#downloadStartDateText').inputValue(),'02/31/2026');
  assert.equal(await page.locator('#downloadStartDateText').getAttribute('aria-invalid'),'true');
  await page.locator('#exportAspectPortraitBtn').click();
  assert.equal(await page.locator('#downloadStartDateText').inputValue(),'02/31/2026');
  await page.locator('#downloadBtn').click();assert.equal((await state()).busy,false);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'downloadStartDateText');
  await page.keyboard.press('Home');await page.keyboard.press('Delete');await page.keyboard.type('1');
  assert.equal(await page.locator('#downloadStartDateText').inputValue(),'12/31/2026','Editing one digit preserves the rest of the date');
  await page.locator('#downloadResetBtn').click();
  await page.locator('#downloadStartDateText').focus();await page.keyboard.press('Home');await page.keyboard.press('Delete');await page.keyboard.press('Tab');
  const incomplete=await page.locator('#downloadStartDateText').inputValue();
  await page.locator('#exportFormatPngBtn').click();
  assert.equal(await page.locator('#downloadStartDateText').inputValue(),incomplete,'Format changes preserve an incomplete date');
  await page.locator('#downloadResetBtn').click();
 });
 await check('Reversed range warning and nested Escape preserve export',async()=>{
  const day=await page.locator('#downloadStartDateText').inputValue();
  await date('downloadEndDateText',day.replaceAll('/',''));
  await page.locator('#downloadStartTimeSelect').selectOption('23:45');
  await page.locator('#downloadEndTimeSelect').selectOption('00:00');
  await page.locator('#downloadBtn').click();await page.waitForFunction(()=>document.querySelector('#exportOrderModal.open'));
  await page.keyboard.press('Escape');assert.equal(await page.locator('#downloadModal').evaluate(e=>e.classList.contains('open')),true);
  assert.equal(await page.locator('#exportOrderModal').evaluate(e=>e.hidden),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'downloadBtn');
  await page.locator('#downloadResetBtn').click();
 });
 if(process.env.UI_DOWNLOADS!=='0'){
  await check('Actual square PNG download',async()=>{await page.locator('#exportFormatPngBtn').click();await page.locator('#exportAspectSquareBtn').click();await download('png');});
  await check('Actual short GIF download',async()=>{
   await openExport();await page.locator('#downloadResetBtn').click();
   const day=await page.locator('#downloadStartDateText').inputValue(),time=await page.locator('#downloadStartTimeSelect').inputValue();
   await date('downloadEndDateText',day.replaceAll('/',''));await page.locator('#downloadEndTimeSelect').selectOption(time);
   await page.locator('#exportSpeedFastBtn').click();await download('gif');
  });
  await openExport();
 }
 await check('Export cancellation recovers without uncaught errors',async()=>{
  await page.locator('#downloadResetBtn').click();await page.locator('#downloadBtn').click();
  await page.locator('#exportProgressCloseBtn').click();await page.waitForFunction(()=>!exportInProgress,null,{timeout:45000});
  assert.match(await page.locator('#downloadStatus').textContent(),/cancelled/i);
 });
 await check('Invalid observed dates do not roll into another month',async()=>{
  await page.locator('#observedDataBtn').click();await page.waitForFunction(()=>currentDataMode==='observed'&&currentViewType==='observed-day'&&selectedObservedDate);
  const before=(await state()).date;
  for(const value of ['February 31, 2026','02/31/2026','2026-02-31']){await page.locator('#observedDateInput').fill(value);await page.keyboard.press('Enter');assert.equal((await state()).date,before);}
  assert.equal(await page.evaluate(()=>parseTypedObservedDate('Feb 29, 2024')),'2024-02-29');
  assert.equal(await page.evaluate(()=>parseTypedObservedDate('Feb 29, 2025')),null);
  await page.locator('#prevDayBtn').click();await page.waitForFunction(old=>selectedObservedDate!==old,before);
 });
 await check('Dialogs isolate arrow keys; calendar selection and top flood selection work',async()=>{
  await page.locator('#dataSourceHelpBtn').click();const before=(await state()).hour;await page.keyboard.press('ArrowRight');assert.equal((await state()).hour,before);await page.keyboard.press('Escape');
  await page.locator('#calendarTitleBtn').click();await page.locator('#calendarGoBtn').click();await page.waitForFunction(()=>!document.querySelector('#calendarPopover.open'));
  await page.locator('#topTideList .top-tide-more-btn').click();await page.locator('#topTidesModalList button').nth(4).click();await page.waitForFunction(()=>currentViewType==='top-tide');
 });
 await check('Live address lookup and Clear',async()=>{
  const text=repo.startsWith('Highlands')?'42 Shore Drive':repo.startsWith('Cape')?'643 Washington Street':'3100 Dune Drive';
  await page.locator('#townAddressInput').fill(text);await page.locator('#townAddressSearchBtn').click();
  await page.waitForFunction(()=>!document.getElementById('townAddressSearchBtn').disabled,null,{timeout:45000});
  assert.match(await page.locator('#townAddressStatus').innerText(),/Closest match:/);
  await page.locator('#townAddressClearBtn').click();await page.locator('.town-address-popup').waitFor({state:'detached'});
 });
 await check('Clear cancels delayed address responses',async()=>{
  // A delayed response makes the race deterministic; prior step exercised live geocoders.
  await page.route('**/findAddressCandidates?**',async route=>{await new Promise(r=>setTimeout(r,800));await route.fulfill({json:{candidates:[]}}).catch(()=>{});});
  await page.route('**/search?**',async route=>{await new Promise(r=>setTimeout(r,800));await route.fulfill({json:[]}).catch(()=>{});});
  await page.locator('#townAddressInput').fill('3100 Dune Drive');await page.locator('#townAddressSearchBtn').click();await page.locator('#townAddressClearBtn').click();await page.waitForTimeout(1200);
  assert.equal(await page.locator('#townAddressStatus').innerText(),'');assert.equal(await page.locator('#townAddressSearchBtn').isEnabled(),true);assert.equal(await page.locator('.town-address-popup').count(),0);
 });
 await check('Mobile portrait and landscape: map, legend, top tides, export and drawer',async()=>{
  await page.locator('#forecastDataBtn').click();await page.waitForFunction(()=>currentViewType==='forecast');
  for(const [width,height] of [[390,844],[844,390],[320,568]]){
   await page.setViewportSize({width,height});await pause();
   await page.locator('#legendDock').click();await pause();await page.keyboard.press('Escape');
   await page.locator('#mobileControlsToggle').click();
   await page.locator('#topTideList .top-tide-more-btn').click();await page.keyboard.press('Escape');
   await openExport();await page.locator('#exportAspectPortraitBtn').click();await page.keyboard.press('Escape');
   if(process.env.UI_ARTIFACTS) await page.screenshot({path:path.join(process.env.UI_ARTIFACTS,`controls-${width}x${height}.png`)});
   await page.locator('#mobileControlsClose').click();
   await page.locator('#playBtn').click({delay:500});assert.equal((await state()).playing,true);await page.locator('#playBtn').click({delay:500});assert.equal((await state()).playing,false);
  }
 });
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({repo,engine,passed:true,checks:results,errors}));
}catch(error){
 console.error(JSON.stringify({repo,engine,passed:false,message:error.message,stack:error.stack,checks:results,state:await state().catch(()=>null),errors}));
 if(process.env.UI_ARTIFACTS){fs.mkdirSync(process.env.UI_ARTIFACTS,{recursive:true});await page.screenshot({path:path.join(process.env.UI_ARTIFACTS,'failure.png')}).catch(()=>{});}
 process.exitCode=1;
}finally{await browser.close();}
