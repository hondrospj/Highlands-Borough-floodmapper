// Run with PLAYWRIGHT_MODULE pointing to a Playwright module, or install playwright.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium, webkit} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.basename(root);
const engine = process.env.UI_BROWSER || 'chromium';
const browser = await (engine === 'webkit' ? webkit : chromium).launch({headless:true,
  ...(engine === 'chromium' ? {executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {})});
const results=[];
const errors=[];
const page = await browser.newPage({viewport:{width:1512,height:945}});
page.setDefaultTimeout(15000);
page.on('pageerror', e=>errors.push(e.message));
await page.route(`https://hondrospj.github.io/${repo}/`, route=>route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'index.html'),'utf8')}));
const state=async()=>page.evaluate(()=>({compact:document.body.classList.contains('mobile-optimized'),drawer:document.body.classList.contains('mobile-controls-open'),legend:document.body.classList.contains('mobile-legend-open'),active:document.activeElement?.id}));
const settle=()=>page.waitForTimeout(450);
async function resize(width,height){await page.setViewportSize({width,height});await settle();}
async function bounded(selector){
  await page.waitForFunction(selector=>{
    const el=document.querySelector(selector);if(!el)return false;
    const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=-1&&r.top>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;
  },selector,{timeout:5000});
  const r=await page.locator(selector).boundingBox();
  assert.ok(r&&r.width>0&&r.height>0, `${selector} must be visible`);
  const v=page.viewportSize();
  assert.ok(r.x>=-1&&r.y>=-1&&r.x+r.width<=v.width+1&&r.y+r.height<=v.height+1, `${selector} outside viewport: ${JSON.stringify(r)}`);
}
async function screenshot(name){if(process.env.UI_SCREENSHOTS){fs.mkdirSync(process.env.UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.UI_SCREENSHOTS,name+'.png')});}}
try{
  await page.goto(`https://hondrospj.github.io/${repo}/`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.getElementById('mobileControlsToggle')&&typeof currentSeriesHours!=='undefined'&&currentSeriesHours.length);
  await page.waitForTimeout(1500);
  for(const [w,h,compact] of [[1512,945,false],[1024,560,false],[901,640,false],[900,640,true],[861,640,true],[390,844,true],[320,568,true],[844,390,true],[1512,945,false]]){
    await resize(w,h);
    assert.equal((await state()).compact,compact, `Breakpoint ${w}x${h}`);
    await bounded('#hourSlider');
    await bounded('#playBtn');
    if(compact){
      await bounded('#mobileControlsToggle');await bounded('#legendDock');
      await page.locator('#mobileControlsToggle').click();await settle();
      assert.equal((await state()).drawer,true);
      await page.locator('#mobileControlsClose').click();await settle();
      assert.equal((await state()).drawer,false,'Close button must survive resize');
    }else{
      assert.equal(await page.locator('#mobileControlsToggle').isVisible(),false,'Mobile toggle must be hidden on desktop');
      const geometry=await page.evaluate(()=>{
        const left=document.getElementById('leftPanel'),right=document.getElementById('rightRail'),title=document.getElementById('mapTitleBadge');
        const l=left.getBoundingClientRect(),r=right.getBoundingClientRect(),t=title.getBoundingClientRect();
        return {leftScroll:getComputedStyle(left).overflowY,rightScroll:getComputedStyle(right).overflowY,titleLeft:t.left,leftRight:l.right,titleRight:t.right,rightLeft:r.left};
      });
      assert.equal(geometry.leftScroll,'auto');assert.equal(geometry.rightScroll,'auto');
      assert.ok(geometry.titleLeft>=geometry.leftRight&&geometry.titleRight<=geometry.rightLeft,JSON.stringify(geometry));
      await page.locator('#openDownloadModalBtn').scrollIntoViewIfNeeded();
      await bounded('#openDownloadModalBtn');
    }
    results.push(`resize ${w}x${h}`);
  }
  await screenshot('desktop');
  await resize(320,568);
  await page.locator('#legendDock').click();await settle();
  assert.equal((await state()).legend,true,'Depth key opens');
  await bounded('#legendDock');
  await screenshot('depth-key');
  await page.keyboard.press('Escape');assert.equal((await state()).legend,false);
  await page.locator('#legendDock').focus();await page.keyboard.press('Enter');await settle();
  assert.equal((await state()).legend,true,'Depth key opens by keyboard');
  await page.keyboard.press('Escape');
  await page.locator('#mobileControlsToggle').click();await settle();
  await bounded('#mobileControlsClose');
  await screenshot('mobile-controls');
  await page.locator('#openDownloadModalBtn').click();await settle();
  await bounded('#downloadModal .download-modal-card');
  await page.locator('#downloadBtn').focus();await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.getElementById('downloadModal').contains(document.activeElement)),true,'Focus stays in dialog');
  await screenshot('mobile-export');
  await page.keyboard.press('Escape');await settle();
  assert.equal((await state()).drawer,true,'Escape closes export only');
  assert.equal((await state()).active,'openDownloadModalBtn','Export returns focus to opener');
  await page.locator('#datumHelpBtn').click();await settle();
  await bounded('#datumModal .datum-modal-card');
  await page.keyboard.press('Escape');await settle();
  assert.equal((await state()).drawer,true);assert.equal((await state()).active,'datumHelpBtn');
  await page.locator('#observedDataBtn').click();await settle();
  await page.locator('#calendarTitleBtn').click();await settle();
  assert.equal(await page.locator('#calendarPopover').evaluate(e=>e.classList.contains('open')),true);
  await bounded('#calendarPopover');
  await screenshot('observed-calendar');
  await page.keyboard.press('Escape');await settle();
  assert.equal((await state()).drawer,true);assert.equal((await state()).active,'calendarTitleBtn');
  await page.locator('#mobileControlsClose').click();await settle();
  assert.equal((await state()).drawer,false);
  await bounded('#hourSlider');
  results.push('legend click and keyboard; drawer; export focus and Escape; datum; observed calendar');
  // Fresh touch page catches differences hidden by desktop-initialized styles.
  const touch = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await touch.route(`https://hondrospj.github.io/${repo}/`,route=>route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'index.html'),'utf8')}));
  touch.on('pageerror',e=>errors.push(e.message));
  await touch.goto(`https://hondrospj.github.io/${repo}/`,{waitUntil:'domcontentloaded'});
  await touch.waitForFunction(()=>document.getElementById('legendDock')?.dataset.mobileLegendWired === '1' && typeof currentSeriesHours !== 'undefined' && currentSeriesHours.length);
  await touch.waitForTimeout(1500);
  await touch.locator('#legendDock').tap();await touch.waitForTimeout(250);
  assert.equal(await touch.evaluate(()=>document.body.classList.contains('mobile-legend-open')),true);
  await touch.keyboard.press('Escape');
  await touch.locator('#playBtn').tap();
  assert.equal(await touch.evaluate(()=>Boolean(playTimer)),true,'Touch starts playback');
  await touch.locator('#playBtn').tap();
  assert.equal(await touch.evaluate(()=>Boolean(playTimer)),false,'Touch pauses playback');
  await touch.locator('#mobileControlsToggle').tap();await touch.locator('#mobileControlsClose').tap();
  assert.equal(await touch.evaluate(()=>document.body.classList.contains('mobile-controls-open')),false);
  await touch.close();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({repo,engine,passed:true,checks:results,errors}));
}catch(error){
  await screenshot('failure');
  console.error(JSON.stringify({repo,engine,passed:false,message:error.message,stack:error.stack,checks:results,state:await state(),errors}));
  process.exitCode=1;
}finally{await browser.close();}
