import {loadMapperTestSource} from './mapper_test_source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const {source: html} = await loadMapperTestSource();
function extract(name) {
  const start = html.search(new RegExp('^    (?:async )?function '+name+'\\(','m'));
  assert(start >= 0, name);
  return html.slice(start,html.indexOf('\n    }',start)+6);
}
const ny = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
const c = vm.createContext({Date,Math,Number,Map,MINOR_FLOOD_FT:3.07,MODERATE_FLOOD_FT:4.07,MAJOR_FLOOD_FT:5.07,
  getEntryESTDate:e=>e.timeUtc && Number.isFinite(Date.parse(e.timeUtc)) ? new Date(e.timeUtc) : null,
  getNyParts:d=>Object.fromEntries(ny.formatToParts(d).map(p=>[p.type,p.value])),
  getTimelineIntervalMinutes:()=>1440, getObservedSourceHoursForDay:d=>d.hours
});
for (const name of ['normalizeStageValue','getRawStageValue','getStageValue','entryTimeMs','getHydraulicFrameMinutes','findHydraulicCrestIndex','getHydraulicElapsedMinutes','inferHydraulicPhaseForIndex','annotateHydraulicSeries','buildDailyMaximumSeries','buildForecastDisplaySeries','buildObservedDailyMaximumSeries']) vm.runInContext(extract(name),c);
const row = (time,stage,extra={}) => ({timeUtc:time,navd88StageFt:stage,...extra});
const rows = [row('2026-10-09T03:30Z',3.5),row('2026-10-09T03:45Z',4),row('2026-10-09T04:00Z',3.8),row('2026-10-09T04:15Z',3.2),row('2026-10-09T05:00Z',null),row('2026-10-09T06:00Z',99,{isMissingTimelineFrame:true}),row('2026-10-09T07:00Z',3.8)];
const before=JSON.stringify(rows);
const annotated=c.annotateHydraulicSeries(rows);
const daily=c.buildDailyMaximumSeries(annotated,{kind:'forecast'});
// Canonical ties retain the first input row; current native forecast/observations are sorted.
const reversed=c.buildDailyMaximumSeries([...annotated].reverse(),{kind:'forecast'});
assert.equal(reversed[1].timeUtc,'2026-10-09T07:00Z','Stable tie selects the first equally high input row');
assert.equal(daily.length,2);
assert.deepEqual(Array.from(daily,e=>e.observedDate),['2026-10-08','2026-10-09']);
assert.deepEqual(Array.from(daily,e=>e.timeUtc),['2026-10-09T03:45Z','2026-10-09T04:00Z']);
assert.equal(daily[1].hydraulicPhase,'draining-release-15','Peak after midnight retains the previous day’s crest timing');
assert.equal(daily[1].hydraulicCrestTimeUtc,'2026-10-09T03:45:00.000Z');
assert.equal(daily[1].hydraulicElapsedMinutes,15);
assert.equal(daily[0].isDailyMaximum,true);
assert.equal(daily[0].timelineIntervalMinutes,1440);
assert.equal(JSON.stringify(rows),before,'Source observations must remain unchanged');
assert.equal(c.buildForecastDisplaySeries(annotated)[1].hydraulicPhase,'draining-release-15');
c.getObservedDaysForMonth=()=>[{date:'2026-10-09',hours:rows.filter(e=>e.timeUtc>='2026-10-09T04:00Z')}];
c.buildObservedCanonicalSeries=d=>c.annotateHydraulicSeries(d.hours);
assert.equal(c.buildObservedDailyMaximumSeries('2026-10').length,1);
assert.equal(c.buildDailyMaximumSeries([row('2026-10-09T10:00Z',null)]).length,0);
assert.equal(c.buildDailyMaximumSeries([row('2026-10-09T10:00Z',0)])[0].navd88StageFt,0);
assert.equal(c.buildDailyMaximumSeries([row('bad',5),{navd88StageFt:9}]).length,0);
// Both repeated 1 AM readings belong to the same local day when DST ends.
const dst=c.buildDailyMaximumSeries([row('2026-11-01T05:00Z',2),row('2026-11-01T06:00Z',3),row('2026-11-02T04:59Z',2.5),row('2026-11-02T05:00Z',1)]);
assert.equal(dst.length,2); assert.equal(dst[0].navd88StageFt,3); assert.equal(dst[0].observedDate,'2026-11-01');
console.log('PASS Daily Max: local dates, DST, real peaks/timestamps, zero vs missing, stable ties, unchanged source and retained hydraulic crest timing.');
