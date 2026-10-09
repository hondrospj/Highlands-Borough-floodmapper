import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const after=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fn=(s,name)=>{const m=s.match(new RegExp('^    (?:async )?function '+name+'\\([\\s\\S]+?\\n    }','m'));assert(m,name);return m[0];};
assert(after.includes('const FLOOD_COMPOSITE_CACHE_ENTRY_LIMIT = FLOOD_COMPOSITE_CACHE_COMPACT ? 32 : 48;'));
const checks=[];
function harness(compact=false){
 const revoked=[],loads=new Map(),sizes=new Map(),waits=new Map(),failures=new Set();let serial=0,conversions=0;
 const context={FLOOD_COMPOSITE_CACHE_COMPACT:compact,URL:{revokeObjectURL:url=>revoked.push(url)},exportImageElementCache:new Map(),preloadPromiseCache:new Map(),floodCompositeBlobSizes:new Map(),throwIfExportCancelled:()=>{},applyModernDepthColors:()=>{conversions++;},getExportImageElement:async source=>{loads.set(source,(loads.get(source)||0)+1);if(failures.delete(source))throw Error('load failed');if(waits.has(source))await waits.get(source).promise;return {naturalWidth:1,naturalHeight:1,source};},document:{createElement:()=>{const canvas={};canvas.getContext=()=>({drawImage:image=>{canvas.source=image.source;},getImageData:()=>({data:new Uint8ClampedArray([1,2,3,225])}),putImageData:()=>{}});return canvas;}},canvasToFillingObjectUrl:async canvas=>{const url='blob:palette-'+(++serial);context.floodCompositeBlobSizes.set(url,sizes.get(canvas.source)||1);return url;}};
 vm.createContext(context);
 vm.runInContext(['const modernDepthOverlayCache = new Map();',...after.match(/    const MODERN_DEPTH_CACHE_(?:LIMIT|BYTE_LIMIT) =[^\n]+;/g),fn(after,'getModernDepthOverlayRecord'),'globalThis.audit={cache:modernDepthOverlayCache,entryLimit:MODERN_DEPTH_CACHE_LIMIT,byteLimit:MODERN_DEPTH_CACHE_BYTE_LIMIT,get:getModernDepthOverlayRecord};'].join('\n'),context);
 const pause=key=>{let resolve;const promise=new Promise(r=>resolve=r);waits.set(key,{promise,resolve});return ()=>{waits.get(key).resolve();waits.delete(key);};};
 return {...context.audit,context,revoked,loads,sizes,pause,failures,conversions:()=>conversions};
}
for(const compact of [false,true]){
 const h=harness(compact);assert.equal(h.entryLimit,compact?64:96);assert.equal(h.byteLimit,(compact?8:16)*1024*1024);
 const records=[];for(let i=0;i<h.entryLimit;i++){const result=await h.get({url:'frame-'+i,compositeByteLength:10000,stage:i});records.push(result);h.context.exportImageElementCache.set(result.url,{});h.context.preloadPromiseCache.set(result.url,{});assert.equal(result.paletteByteLength,1);}
 const reused=await h.get({url:'frame-0'});assert.equal(reused,records[0]);assert.equal(h.conversions(),h.entryLimit);
 await h.get({url:'extra'});assert.equal(h.cache.size,h.entryLimit);assert(h.cache.has('frame-0'));assert(!h.cache.has('frame-1'));assert(h.revoked.includes(records[1].url));assert(!h.context.exportImageElementCache.has(records[1].url));assert(!h.context.preloadPromiseCache.has(records[1].url));assert.equal(h.context.floodCompositeBlobSizes.size,0);
 checks.push((compact?'compact':'desktop')+' entry budget, LRU, encoded byte bookkeeping and URL cleanup');
}
{
 const h=harness();h.sizes.set('a',10*1024*1024);h.sizes.set('b',10*1024*1024);
 const a=await h.get({url:'a'}),b=await h.get({url:'b'});assert.equal(h.cache.size,1);assert(h.revoked.includes(a.url));assert(!h.revoked.includes(b.url));
 h.sizes.set('oversized',40*1024*1024);const big=await h.get({url:'oversized'});assert.equal(h.cache.size,1);assert(!h.revoked.includes(big.url));assert(h.revoked.includes(b.url));
 checks.push('byte budget and usable single oversized image');
}
{
 const h=harness();const resume=h.pause('pending');const first=h.get({url:'pending'}),second=h.get({url:'pending'});assert.equal(h.loads.get('pending'),1);resume();const [a,b]=await Promise.all([first,second]);assert.equal(a,b);assert.equal(h.conversions(),1);
 h.failures.add('retry');await assert.rejects(h.get({url:'retry'}),/load failed/);assert(!h.cache.has('retry'));assert((await h.get({url:'retry'})).url);assert.equal(h.loads.get('retry'),2);
 const modern={url:'existing',isModernDepthPalette:true};assert.equal(await h.get(modern),modern);assert.equal(await h.get(null),null);
 checks.push('concurrent request reuse, failed load retry and already-colored passthrough');
}
{
 const h=harness(true);const resume=h.pause('slow');const pending=h.get({url:'slow'});
 for(let i=0;i<h.entryLimit+4;i++)await h.get({url:'ready-'+i});
 assert.equal([...h.cache.values()].filter(r=>r?.url).length,h.entryLimit);assert(h.cache.has('slow'));resume();const slow=await pending;assert.equal(h.cache.size,h.entryLimit);assert(!h.revoked.includes(slow.url));
 checks.push('pending requests do not block eviction; completing result remains usable');
}
const result={repository:'hondrospj/Highlands-Borough-floodmapper',passed:true,checks};
console.log(JSON.stringify(result,null,2));
