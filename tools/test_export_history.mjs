import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const extract=name=>html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`))?.[0];
const rows=[2,2.5,3,3.5,3.4,3.2,3,2.7,2.4,2.2,2.5,3].map((stage,i)=>({navd88StageFt:stage,timeUtc:new Date(Date.UTC(2026,9,3,0,i*15)).toISOString(),observedDate:'2026-10-03',timelineIntervalMinutes:15}));
const observed=rows.map(e=>({...e,timeUtc:e.timeUtc.replace('10-03','09-26'),observedDate:'2026-09-26'}));
const ctx=vm.createContext({
 MINOR_FLOOD_FT:3,MODERATE_FLOOD_FT:4,MAJOR_FLOOD_FT:6,
 getStageValue:e=>e?.navd88StageFt??null,entryTimeMs:e=>e?Date.parse(e.timeUtc):null,
 findClosestEntryIndex:(s,e)=>s.findIndex(r=>r.timeUtc===e.timeUtc),
 currentDataMode:'forecast',selectedObservedDate:'2026-09-26',currentRawSeriesHours:rows,
 getActiveForecastHours:()=>rows,getObservedDayRecord:()=>({hours:observed}),getObservedSourceHoursForDay:d=>d.hours,
});
for(const name of ['normalizeHydraulicPhase','getHydraulicFrameMinutes','findHydraulicCrestIndex','getHydraulicElapsedMinutes','inferHydraulicPhaseForIndex','annotateHydraulicSeries','getHydraulicPhaseForEntry','getDownloadFrameItemFromEntry'])if(extract(name))vm.runInContext(extract(name),ctx);
if(ctx.getHydraulicPhaseForEntry){
 const series=ctx.annotateHydraulicSeries?ctx.annotateHydraulicSeries(rows):rows;
 const phase=ctx.getHydraulicPhaseForEntry(series[5],5,series);
 for(const display of [series,[series[3]]]){
  ctx.currentSeriesHours=display;
  const snapshot=new Map();
  const item=ctx.getDownloadFrameItemFromEntry({...rows[5],exportSourceMode:'forecast'},0,snapshot);
  assert.equal(ctx.getHydraulicPhaseForEntry(item.entry,item.index,item.series),phase,'Export uses the full source history in every display mode');
  assert.equal(item.series.length,rows.length);
  const second=ctx.getDownloadFrameItemFromEntry({...rows[6],exportSourceMode:'forecast'},0,snapshot);
  assert.equal(item.series,second.series,'Reuse one source snapshot per range');
 }
 const archive=ctx.getDownloadFrameItemFromEntry({...observed[5],exportSourceMode:'observed'},0);
 assert.equal(archive.mode,'observed');assert.equal(archive.series[0].timeUtc,observed[0].timeUtc);
}else{
 const item=ctx.getDownloadFrameItemFromEntry({...observed[5],exportSourceMode:'observed'},0);
 assert.equal(item.mode,'observed');assert.equal(item.dateStr,'2026-09-26');
}
console.log('PASS export source history and legacy renderer compatibility.');
