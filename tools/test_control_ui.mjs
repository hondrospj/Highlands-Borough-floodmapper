import {loadMapperTestSource} from './mapper_test_source.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const {source} = await loadMapperTestSource();
const extract = name => {
 const match=source.match(new RegExp('^    (?:async )?function '+name+'\\([\\s\\S]+?\\n    }','m'));
 assert(match,`Missing shipped ${name}`);return match[0];
};
const nodes=Object.fromEntries(['hourSlider','timelineDock','timelineBubble','timelineFirstTime','timelineMiddleTime','timelineLastTime','timelineStepBack','timelineStepForward'].map(id=>[id,{dataset:{},attrs:{},style:{setProperty(){}},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];}}]));
nodes.timelineBubble.textContent='Oct 9 · 1 AM 2.0 ft';nodes.timelineBubble.querySelectorAll=()=>[];
const c=vm.createContext({document:{getElementById:id=>nodes[id]},compact:false,currentDataMode:'forecast',currentHourIndex:0,currentSeriesHours:[],isMobileTimeline:()=>c.compact,sameEntryESTDay:(a,b)=>a.day===b.day,interval:60,currentViewType:'forecast',selectedObservedDate:null,getTimelineIntervalMinutes:()=>c.interval,getEntryESTDate:e=>e?new Date(e.timeUtc):null,formatHourEntryTime:e=>e.time,updateSliderProgress(){},timelineBoundsCache:null,timelineScaleCache:null,timelineScaleTimeFormatter:new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'})});
for(const name of ['getTimelineSliderBounds','syncSliderBounds','updateTimelineAccessibility'])vm.runInContext(extract(name),c);
const update=()=>{c.syncSliderBounds();c.updateTimelineAccessibility();};
const series=[{day:'8',time:'11 PM',timeUtc:'2026-10-09T03:00Z'},{day:'9',time:'12 AM',timeUtc:'2026-10-09T04:00Z'},{day:'9',time:'1 AM',timeUtc:'2026-10-09T05:00Z'},{day:'9',time:'2 AM',timeUtc:'2026-10-09T06:00Z'},{day:'10',time:'12 AM',timeUtc:'2026-10-10T04:00Z'}];
c.currentSeriesHours=series;c.currentHourIndex=2;update();
assert.deepEqual([nodes.hourSlider.min,nodes.hourSlider.max,nodes.hourSlider.value],['0','4','2']);
c.compact=true;update();
assert.deepEqual([nodes.hourSlider.min,nodes.hourSlider.max,nodes.hourSlider.value],['1','3','2']);
assert.equal(nodes.timelineFirstTime.textContent,'12 AM');assert.equal(nodes.timelineLastTime.textContent,'2 AM');assert.equal(nodes.hourSlider.disabled,false);
c.currentHourIndex=4;update();assert.equal(nodes.hourSlider.disabled,true);assert.equal(nodes.timelineDock.dataset.singleTimelineTime,'true');
c.currentDataMode='observed';c.currentSeriesHours=[];c.currentHourIndex=0;update();assert.equal(nodes.hourSlider.disabled,true);assert.equal(nodes.hourSlider.attrs['aria-label'],'Observed flood time');assert.equal(nodes.timelineFirstTime.textContent,'');
c.compact=false;c.currentSeriesHours=series;c.currentHourIndex=2;update();assert.deepEqual([nodes.hourSlider.min,nodes.hourSlider.max],['0','4']);assert.equal(c.currentSeriesHours,series);assert.equal(series.length,5);
// Mode switching retains the selected global index and does not substitute forecast state.
Object.assign(c,{currentOverlayMode:'depth',currentDataMode:'observed',currentViewType:'observed-day',currentHourIndex:3,getTimelineNavigationIndex:()=>c.currentHourIndex,selectionGeneration:1,loadForecast:{},loadTopTideEvent:{},loadReturnInterval:{},cancelPendingFloodFrame(){},stopPlayback(){},toast(){},updateModeButtons(){},renderHour:async index=>assert.equal(index,3)});
vm.runInContext(extract('switchOverlayMode'),c);await c.switchOverlayMode('dynamic');assert.equal(c.currentDataMode,'observed');assert.equal(c.currentViewType,'observed-day');assert.equal(c.currentHourIndex,3);
// Canonical daily mode supplies adjacent days in its series, and step controls use those actual neighbors.
c.interval=1440;c.currentSeriesHours=[series[1],series[4]];c.currentHourIndex=1;c.compact=true;update();assert.equal(nodes.timelineStepBack.disabled,false);assert.equal(nodes.timelineStepForward.disabled,true);assert.equal(nodes.timelineStepBack.textContent,'−1d');assert.match(nodes.timelineStepBack.attrs['aria-label'],/^Previous time:/);
console.log('PASS canonical timeline: global indices, phone day bounds, single crest, empty records, desktop restoration, unchanged source, retained Past selection and daily neighbors.');
