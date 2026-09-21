import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
// Extract the actual declarations, stopping at the next declaration at the same level.
function source(name){
 const start=html.search(new RegExp(`(?:async )?function ${name}\\(`));
 assert.ok(start>=0,name);
 const open=html.indexOf('{',start);let depth=1,i=open+1;
 // These declarations contain no braces in comments/regex and balanced template braces.
 for(;depth&&i<html.length;i++){if(html[i]==='{')depth++;else if(html[i]==='}')depth--;}
 return html.slice(start,i);
}
const context=vm.createContext({Date,Map,Number,String,Promise,console,currentMonthKey:'2026-02',overlayRecordCache:new Map(),getOverlayStage:n=>n,normalizeHydraulicPhase:s=>s,stageToCode:n=>String(n),throwIfExportCancelled:()=>{}});
vm.runInContext(source('parseTypedObservedDate')+'\n'+source('getOverlayRecord')+'\n'+source('runExportLimited'),context);
for(const value of ['February 31, 2026','02/31/2026','2026-02-31','02/29/2025','2026-13-01','2026-01-00','not a date'])assert.equal(context.parseTypedObservedDate(value),null,value);
for(const [input,result] of [['Feb 29, 2024','2024-02-29'],['April 19, 2026','2026-04-19'],['04/19/26','2026-04-19'],['2/28','2026-02-28'],['2026-09-21','2026-09-21']])assert.equal(context.parseTypedObservedDate(input),result,input);
let attempts=0;const aborted=Object.assign(new Error('Export cancelled.'),{name:'AbortError'});
context.findWorkingOverlay=async()=>{if(++attempts===1)throw aborted;return {url:'retry.png'};};
await assert.rejects(context.getOverlayRecord('depth',5),{name:'AbortError'});
assert.equal((await context.getOverlayRecord('depth',5)).url,'retry.png');assert.equal(attempts,2,'Cancelled cache entries can retry');
let release;const pending=new Promise(r=>release=r);let finished=false;
const work=context.runExportLimited([0,1],2,async item=>{if(!item)throw aborted;await pending;finished=true;});
let settled=false;work.catch(()=>{settled=true;});await new Promise(r=>setTimeout(r,0));assert.equal(settled,false,'Cancellation waits for concurrent work before resetting state');release();await assert.rejects(work,{name:'AbortError'});assert.equal(finished,true);
console.log('Observed date validation, cancelled-overlay retry, and export cancellation lifecycle passed.');
