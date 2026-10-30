"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const roads = require("../assets/road-labels.js");
const symbol = (id, source, more={}) => ({id,type:"symbol","source-layer":source,layout:{"text-field":"{_name}","text-size":10,...more}});
const fixture = () => ({version:8,sources:{esri:{type:"vector",tiles:["https://example.com/tile.pbf"]}},sprite:"provider/sprite",glyphs:"provider/{fontstack}/{range}.pbf",layers:[
 {id:"background",type:"background",paint:{"background-color":"red"}},
 {id:"building",type:"fill","source-layer":"building"},
 symbol("OSM address point/Number/Name","OSM address point"),
 symbol("OSM building/label/Default","OSM building/label"),
 symbol("place (small)/village","place (small)"),
 symbol("road/label/residential, unclassified name","road/label"),
 symbol("road/label/residential, unclassified shield text","road/label"),
 symbol("road/label/primary name","road/label"),
 symbol("road/label/tertiary shield","road/label",{"icon-image":"road/tertiary shield/{_len}","icon-size":1.2}),
 symbol("road (bridge)/label/primary shield","road (bridge)/label",{"icon-image":"road (bridge)/primary shield/{_len}","icon-size":1.2}),
 symbol("service road/label/Default","service road/label"),
 symbol("road/label/pedestrian","road/label"),
 symbol("road (under construction)/label/primary","road (under construction)/label")
]});
const at = (expression,z) => {
 const s=expression.stops;
 if(z<=s[0][0])return s[0][1];
 for(let i=1;i<s.length;i++)if(z<=s[i][0])return s[i-1][1]+(s[i][1]-s[i-1][1])*(z-s[i-1][0])/(s[i][0]-s[i-1][0]);
 return s.at(-1)[1];
};
test("only genuine named-road and shield symbols survive; address numbers, buildings and background are absent",()=>{
 const input=fixture(),before=JSON.stringify(input),out=roads.styleRoadLabels(input);
 assert.equal(out.layers.length,4);assert.equal(JSON.stringify(input),before);
 assert(out.layers.every(l=>l.type==="symbol" && /^road/.test(l["source-layer"])));
 assert(!out.layers.some(l=>/address|building|service|pedestrian|construction|shield text/.test(l.id)));
 assert.deepEqual(out.sources,input.sources);assert.equal(out.sprite,input.sprite);assert.equal(out.glyphs,input.glyphs);
});
test("3D style retains every non-symbol geometry/extrusion/source while replacing address labels with styled roads",()=>{
 const input=fixture();input.layers.push({id:'3d-structures',type:'fill-extrusion',source:'parcels',paint:{'fill-extrusion-height':['get','height']}});input.sources.parcels={type:'geojson',data:{type:'FeatureCollection',features:[]}};
 const geometry=input.layers.filter(l=>l.type!=='symbol'),before=JSON.stringify(input),out=roads.styleBasemap(input);
 assert.equal(JSON.stringify(input),before);assert.deepEqual(out.layers.filter(l=>l.type!=='symbol'),geometry);assert.deepEqual(out.sources,input.sources);
 assert(out.layers.filter(l=>l.type==='symbol').every(l=>/^road/.test(l['source-layer'])));assert.deepEqual(roads.styleBasemap(out),out);
});
test("road names never shrink below default size through every supported zoom",()=>{
 const out=roads.styleRoadLabels(fixture());
 for(const l of out.layers){
  const values=Array.from({length:97},(_,i)=>at(l.layout["text-size"],i/4));
  assert(values.every(v=>v>=16));assert(values.every((v,i)=>!i||v>=values[i-1]));
  assert.equal(l.layout["text-allow-overlap"],false);assert((typeof l.layout["symbol-spacing"] === "number" ? l.layout["symbol-spacing"] : at(l.layout["symbol-spacing"],14))>=600);
 }
 const local=out.layers.find(l=>l.id.includes("residential"));assert.equal(at(local.layout["text-size"],13),16);
 const main=out.layers.find(l=>l.id.endsWith("primary name"));assert.equal(at(main.layout["text-size"],13),18);
});
test("route shields retain provider sprites/numerals and take collision priority over local streets",()=>{
 const out=roads.styleRoadLabels(fixture());
 assert(out.layers.slice(-2).every(l=>l.id.endsWith("shield")));
 for(const l of out.layers.filter(l=>l.id.endsWith("shield"))){
  assert(l.layout["icon-image"].includes("{_len}"));assert.equal(l.layout["text-field"],"{_name}");
  assert.equal(l.layout["icon-optional"],false);assert.equal(l.layout["text-optional"],false);
  assert.equal(l.layout["icon-allow-overlap"],false);assert.equal(l.minzoom,8);
  assert.equal(at(l.layout["icon-size"],13),2.4);assert.equal(at(l.layout["text-size"],13),20);
 }
});
test("export scale is applied once and repeated style passes are idempotent",()=>{
 const unscaled=roads.styleRoadLabels(fixture(),{exportMode:true,unit:1});
 const half=roads.styleRoadLabels(fixture(),{exportMode:true,unit:.5});
 const repeat=roads.styleRoadLabels(half,{exportMode:true,unit:.5});
 assert.deepEqual(repeat,half);
 for(let i=0;i<half.layers.length;i++){
  assert.equal(at(half.layers[i].layout["text-size"],15),at(unscaled.layers[i].layout["text-size"],15)/2);
  assert.equal(typeof half.layers[i].layout["symbol-spacing"]==="number"?half.layers[i].layout["symbol-spacing"]:at(half.layers[i].layout["symbol-spacing"],15),(typeof unscaled.layers[i].layout["symbol-spacing"]==="number"?unscaled.layers[i].layout["symbol-spacing"]:at(unscaled.layers[i].layout["symbol-spacing"],15))/2);
 }
 assert.equal(at(unscaled.layers.find(l=>l.id.includes('residential')).layout["text-size"],15),20);
});
test("large export labels retain practical street-name spacing rather than a one-label map",()=>{
 const out=roads.styleRoadLabels(fixture(),{exportMode:true,unit:2});
 const local=out.layers.find(l=>l.id.includes('residential'));
 const major=out.layers.find(l=>l.id.endsWith('primary name'));
 const shield=out.layers.find(l=>l.id.endsWith('primary shield'));
 assert.equal(at(local.layout['text-size'],14),40);assert.equal(at(major.layout['text-size'],14),40);
 assert.equal(at(shield.layout['text-size'],14),60);assert.equal(at(shield.layout['icon-size'],14),7.2);
 assert.equal(local.layout['symbol-spacing'],300);assert.equal(major.layout['symbol-spacing'],300);assert.equal(shield.layout['symbol-spacing'],1000);
 assert.equal(at(local.layout['text-padding'],19),6);assert.equal(shield.layout['icon-padding'],8);
 const live=roads.styleRoadLabels(fixture()).layers.find(l=>l.id.includes('residential'));
 assert.equal(at(live.layout['text-size'],14),16);assert.equal(at(live.layout['text-size'],19),20);
 assert.equal(at(live.layout['symbol-spacing'],19),1000);
 assert.equal(local.layout['symbol-placement'],'line');assert.equal(local.layout['text-rotation-alignment'],'map');assert.equal(local.layout['text-max-angle'],60);assert.equal(live.layout['text-max-angle'],24);
});
function evaluate(e,properties={},vars={}) {
 if(!Array.isArray(e))return e;
 const op=e[0],v=i=>evaluate(e[i],properties,vars);
 if(op==='get')return properties[e[1]];
 if(op==='to-string')return String(v(1));
 if(op==='coalesce'){for(let i=1;i<e.length;i++){const x=v(i);if(x!=null)return x;}return null;}
 if(op==='let')return evaluate(e[3],properties,{...vars,[e[1]]:v(2)});
 if(op==='var')return vars[e[1]];
 if(op==='case'){for(let i=1;i<e.length-1;i+=2)if(v(i))return v(i+1);return v(e.length-1);}
 if(op==='all')return e.slice(1).every((_,i)=>v(i+1));
 if(op==='==')return v(1)===v(2);
 if(op==='>')return v(1)>v(2);
 if(op==='-')return v(1)-v(2);
 if(op==='downcase')return v(1).toLowerCase();
 if(op==='slice')return v(1).slice(v(2),e.length>3?v(3):undefined);
 if(op==='length')return v(1).length;
 if(op==='concat')return e.slice(1).map((_,i)=>v(i+1)).join('');
 throw Error('Unknown expression '+op);
}
test("road names use standard abbreviations without altering route numerals",()=>{
 const expression=roads.abbreviatedName('{_name}');
 for(const [full,short]of [['North Bay Avenue','N Bay Ave'],['South Waterwitch Avenue','S Waterwitch Ave'],['Memorial Parkway','Memorial Pkwy'],['Ocean Street','Ocean St'],['East Shore Boulevard','E Shore Blvd'],['Washington Lane','Washington Ln'],['Bay Ave','Bay Ave']])assert.equal(evaluate(expression,{_name:full}),short);
 assert.deepEqual(roads.abbreviatedName(expression),expression);
 const style=roads.styleRoadLabels(fixture());assert.equal(style.layers.find(l=>l.id.endsWith('primary shield')).layout['text-field'],'{_name}');
});
test("invalid scaling or a style without authoritative road features cannot silently create labels",()=>{
 for(const unit of [0,-1,Infinity,NaN,"2",9])assert.throws(()=>roads.styleRoadLabels(fixture(),{unit}));
 assert.throws(()=>roads.styleRoadLabels({layers:[]}));assert.throws(()=>roads.styleRoadLabels({}));
});

function mockedLayer({ready=true,tainted=false}={}) {
 const callbacks=new Map(),nativeCallbacks=new Map(),setStyles=[],container={style:{},classList:{add(){}}};
 const source={width:1200,height:600,getBoundingClientRect:()=>({left:80,top:40,width:600,height:300})};
 const native={loaded:()=>ready,areTilesLoaded:()=>ready,getCenter:()=>({lat:40,lng:-74}),getZoom:()=>14,project:({lng,lat})=>({x:lng*2**14,y:lat*2**14}),triggerRepaint(){},getCanvas:()=>source,on(name,callback){nativeCallbacks.set(name,callback);},fire(name,event){nativeCallbacks.get(name)?.(event);},getStyle:()=>fixture(),setStyle(style,options){setStyles.push({style,options});}};
 const child={_glMap:native,_container:container,addTo(){}};
 const layer={options:{},_ready:true,_maplibreGL:child,
  on(name,fn){callbacks.set(name,fn);return this;},once(name,fn){callbacks.set(name,fn);return this;},off(name){callbacks.delete(name);return this;},_asyncAdd(){},
 };
 global.L={esri:{Vector:{vectorTileLayer(_url,options){layer.options={...options};layer.styleCallback=options.style;return layer;}}}};
 const calls=[];
 global.document={createElement(){return {width:0,height:0,getContext:()=>({set globalAlpha(v){calls.push(['alpha',v]);},drawImage(...args){calls.push(['draw',...args]);},getImageData(){if(tainted)throw Error('tainted');return {data:new Uint8ClampedArray(4)};}})};}};
 const wrapped=roads.createLayer({opacity:.98,exportMode:true,unit:1});
 const map={getCenter:()=>({lat:40,lng:-74}),getZoom:()=>15,getSize:()=>({x:400,y:200}),getContainer:()=>({getBoundingClientRect:()=>({left:100,top:50,width:400,height:200})}),hasLayer:()=>false};
 wrapped.onAdd(map);wrapped.styleCallback(fixture());
 return {wrapped,map,calls,container,native,setStyles};
}
test("wrapper masks the vendor's initial unfiltered style and applies requested opacity after roads are ready",async()=>{
 const {wrapped,container}=mockedLayer();assert.equal(container.style.opacity,"0");
 assert(roads.isLayer(wrapped));assert.equal(wrapped.options.opacity,.98);await wrapped.whenReady({timeoutMs:1000});
 assert.equal(container.style.opacity,"0.98");assert.equal(wrapped.isLoading(),false);assert.equal(wrapped.getMaplibreMap().getZoom(),14);
 wrapped.setOpacity(0);assert.equal(container.style.opacity,"0");
});
test("capture crops padded GL canvas to map viewport and applies opacity once",async()=>{
 const {wrapped,calls}=mockedLayer();const canvas=await roads.captureCanvas(wrapped,{scale:2,timeoutMs:1000});
 assert.equal(canvas.width,800);assert.equal(canvas.height,400);
 const draw=calls.find(c=>c[0]==='draw');assert.deepEqual(draw.slice(2),[-40,-20,1200,600]);
 assert.deepEqual(calls.filter(c=>c[0]==='alpha'),[['alpha',.98],['alpha',1]]);
});
test("capture fails on a tainted canvas rather than returning an unusable export",async()=>{
 const {wrapped}=mockedLayer({tainted:true});await assert.rejects(()=>wrapped.captureCanvas({timeoutMs:1000}),/exported cleanly/);
});
test("an unloaded, cancelled or removed road layer cannot report capture ready",async()=>{
 const {wrapped,map}=mockedLayer({ready:false});
 const controller=new AbortController();controller.abort();await assert.rejects(()=>wrapped.whenReady({signal:controller.signal}));
 await assert.rejects(()=>wrapped.whenReady({timeoutMs:1}),/still loading/);
 wrapped.onRemove(map);await assert.rejects(()=>wrapped.captureCanvas({timeoutMs:1}),/not on the map/);
});

test("readiness tolerates subpixel camera rounding but rejects a shifted view at every zoom",async()=>{
 for(const zoom of [4,14,19]){
  const {wrapped,map,native}=mockedLayer();
  map.getZoom=()=>zoom+1;native.getZoom=()=>zoom;
  native.project=({lng,lat})=>({x:lng*2**zoom,y:lat*2**zoom});
  native.getCenter=()=>({lng:-74+.5/2**zoom,lat:40});
  await wrapped.whenReady({timeoutMs:1000});
  native.getCenter=()=>({lng:286,lat:40});
  await wrapped.whenReady({timeoutMs:1000});
  native.getCenter=()=>({lng:-74+3/2**zoom,lat:40});
  await assert.rejects(()=>wrapped.whenReady({timeoutMs:1}),/still loading/);
 }
});

test("provider errors require explicit retry and failed source caches are rebuilt before capture",async()=>{
 const {wrapped,native,setStyles}=mockedLayer();
 await wrapped.whenReady({timeoutMs:1000});
 native.fire('error',{error:new Error('HTTP503')});
 await assert.rejects(()=>wrapped.whenReady({timeoutMs:1000}),/could not load cleanly/);
 await assert.rejects(()=>wrapped.captureCanvas({timeoutMs:1000}),/could not load cleanly/);
 assert.equal(setStyles.length,0,'Passive readiness/capture must not silently retry or accept errored tiles');
 await wrapped.whenReady({retry:true,timeoutMs:1000});
 assert.equal(setStyles.length,1);assert.deepEqual(setStyles[0].options,{diff:false});
 assert(setStyles[0].style.layers.every(layer=>layer.type==='symbol'&&/^road/.test(layer['source-layer'])));
 assert.equal(wrapped._roadError,null);assert.equal(wrapped._roadReady,true);
 native.fire('error',{error:new Error('Still offline')});
 native.setStyle=(style,options)=>{setStyles.push({style,options});native.fire('error',{error:new Error('HTTP503 again')});};
 await assert.rejects(()=>wrapped.whenReady({retry:true,timeoutMs:1000}),/could not load cleanly/);
 assert.equal(wrapped._roadReady,false,'A still-failing explicit retry must remain blocked');
});
