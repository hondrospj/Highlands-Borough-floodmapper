import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const features=fs.readFileSync(new URL('assets/highlands-features.js',root),'utf8');
const ctx=vm.createContext({URL,APP_BASE:'https://example.test/highlands/',EXPORT_RANGE_MAX_HOURS:120,EXPORT_CAPTURE_SCALE:1.5,window:{devicePixelRatio:2},Map,Set,console});
vm.runInContext(features,ctx);
vm.runInContext(`getDownloadFormatValue=()=>"png";if(getExportCaptureScale()!==1)throw Error("PNG dimensions multiplied twice");document={getElementById:()=>({value:"15min"}),querySelector:()=>null};if(getDownloadIntervalConfig().minutes!==15)throw Error("Quarter-hour export cadence");document={getElementById:()=>({value:"daily"}),querySelector:()=>null};if(getDownloadFrameLimit()!==5)throw Error("Daily Max cap");`,ctx);

let floorRequests = 0;
ctx.fetchJson = async () => {
  floorRequests++;
  return {
    schema: 'highlands-certified-first-floors-v1',
    historicBaselineGeneratedUtc: '2026-10-16T20:25:09Z',
    buildings: {
      footprint: {
        parcelId: '1319_1_2',
        structurePoint: [1, 2],
        firstFloorNavd88Ft: 9,
        historicFloodEventCount: 0
      }
    }
  };
};
const [floors, sameFloors] = await Promise.all([ctx.loadCertifiedFirstFloors(), ctx.loadCertifiedFirstFloors()]);
assert.equal(floors, sameFloors);
assert.equal(floorRequests, 1);
const modeled = {footprintId: 'footprint', localGroundNavd88Ft: 4, foundationHeightFt: 1, modelElevationIndex: 0};
const structure = {properties: {...modeled}};
const parcel = {properties: {...modeled, parcelId: '1319_1_2'}};
const neighbor = {properties: {...modeled, parcelId: '1319_1_3'}};
ctx.applyCertifiedFirstFloors([structure, parcel, neighbor], floors);
assert.equal(ctx.getNsiFirstOccupiedFloorNavd88(structure.properties), 9);
assert.equal(ctx.getNsiFirstOccupiedFloorNavd88(parcel.properties), 9);
assert.equal(ctx.getNsiFirstOccupiedFloorNavd88(neighbor.properties), 5);
assert.equal(structure.properties.foundationHeightFt, 1);
assert.equal(ctx.getNsiStructureImpactStyle(structure.properties, 7).fillColor, '#22d3ee');
assert.equal(ctx.findProjectionElevationIndex(parcel, {elevationGridFtNavd88: [5, 9]}), 1);
assert.equal(ctx.findProjectionElevationIndex(neighbor, {elevationGridFtNavd88: [5, 9]}), 0);

const map3d = fs.readFileSync(new URL('assets/highlands-3d.js', root), 'utf8');
const parcelFunction = map3d.match(/^  function parcelForRenderedBuilding\([\s\S]*?\n  }/m);
assert(parcelFunction);
vm.runInContext(parcelFunction[0], ctx);
const roof = {geometry: {type: 'Polygon', coordinates: [[[0, 1], [2, 1], [2, 3], [0, 3], [0, 1]]]}};
const otherRoof = {geometry: {type: 'Polygon', coordinates: [[[0, 3], [2, 3], [2, 5], [0, 5], [0, 3]]]}};
assert.equal(ctx.parcelForRenderedBuilding(parcel, roof), parcel);
assert.equal(ctx.getNsiFirstOccupiedFloorNavd88(ctx.parcelForRenderedBuilding(parcel, otherRoof).properties), 5);
assert.equal(ctx.getNsiFirstOccupiedFloorNavd88(parcel.properties), 9);
const clickFunction = map3d.match(/^  function clickedStructureFootprint\([\s\S]*?\n  }/m);
assert(clickFunction);
vm.runInContext(clickFunction[0], ctx);
ctx.layerVisible = () => true;
const hits = [{properties: {footprintId: 'footprint'}}];
ctx.glMap = {getLayer: () => true, queryRenderedFeatures: () => hits};
assert.equal(ctx.featureForCertifiedFootprint(parcel, ctx.clickedStructureFootprint({})), parcel);
hits.push({properties: {footprintId: 'other'}});
assert.equal(ctx.getNsiFirstOccupiedFloorNavd88(
  ctx.featureForCertifiedFootprint(parcel, ctx.clickedStructureFootprint({})).properties
), 5);

const road=fs.readFileSync(new URL('assets/highlands-road-impacts.js',root),'utf8');
const start=road.indexOf('  async function depthSampler('),end=road.indexOf('\n  async function refresh()',start);
assert(start>=0&&end>start);
const encoded=ground=>[Math.floor((32768+ground*10)/256),(32768+ground*10)%256,0,255];
const pixels=Uint8Array.from([...encoded(.4),...encoded(.5),128,0,255,255,...encoded(3)]);
const bounds={getWest:()=>0,getEast:()=>1,getSouth:()=>0,getNorth:()=>1};
const rc=vm.createContext({getHydraulicQueryGrid:async()=>({width:2,height:2,values:pixels}),currentFloodLayer:{getBounds:()=>bounds},getPenalizedWaterSurfaceStage:s=>s,MIN_DEPTH_FT:.5,Math});
vm.runInContext(road.slice(start,end),rc);
const sample=await rc.depthSampler({},1,'slack');
assert.equal(sample([.25,.75]),true,'0.6 ft is a road impact');
assert.equal(sample([.75,.75]),false,'exactly 0.5 ft is not above the threshold');
assert.equal(sample([.25,.25]),false,'missing cells cannot produce impacts');
assert.equal(sample([.75,.25]),false,'dry ground cannot produce impacts');
assert.equal(sample([2,2]),false,'outside raster is not flooded');
console.log('PASS Highlands: certified floor matching and thresholds, PNG export dimensions and cadence, and road-depth thresholds.');
