"""Build Highlands UI screening assets from local terrain and official source data."""
from pathlib import Path
import sys,json,math,ast,bisect,urllib.request,urllib.parse,datetime,collections
p=Path(__file__).resolve().parent
# Install numpy, scipy, Pillow, shapely and pyproj before running this builder.
import numpy as np
from PIL import Image,ImageDraw
from shapely.geometry import shape,Point
from shapely.ops import unary_union
from pyproj import Transformer
from scipy.signal import find_peaks
repo=p.parent; raw=p/'.cache/highlands-feature-data'; raw.mkdir(parents=True,exist_ok=True); out=repo/'assets/highlands-data';out.mkdir(exist_ok=True)
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
def save(name,d): (out/name).write_text(json.dumps(d,separators=(',',':'),allow_nan=False))
def get(url,params):
 with urllib.request.urlopen(url+'?'+urllib.parse.urlencode(params),timeout=120) as r:return json.load(r)

def cache_json(name,url,params):
    dest=raw/name
    if not dest.exists():
        with urllib.request.urlopen(url+'?'+urllib.parse.urlencode(params),timeout=180) as response: payload=json.load(response)
        if payload.get('error'): raise ValueError(payload['error'])
        dest.write_text(json.dumps(payload))
cache_json('parcels.json','https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0/query',{'where':"PCL_MUN='1319'",'outFields':'OBJECTID,PAMS_PIN,PCL_MUN,PCLBLOCK,PCLLOT,PROP_LOC,PROP_CLASS,BLDG_DESC,LAND_DESC','returnGeometry':'true','outSR':4326,'f':'geojson','resultRecordCount':2000,'orderByFields':'OBJECTID','geometryPrecision':7})
cache_json('nsi.json','https://nsi.sec.usace.army.mil/nsiapi/structures',{'fmt':'fc','bbox':'-74.0053,40.3888,-73.9784,40.3888,-73.9784,40.4116,-74.0053,40.4116,-74.0053,40.3888'})
cache_json('naccs.json','https://services.northeastoceandata.org/arcgis1/rest/services/NACCS/NACCS/MapServer/1/query',{'where':'StationId=11544','returnGeometry':'true','outFields':'*','outSR':4326,'f':'json'})
cache_json('slr.json','https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/slr_projections.json',{'units':'metric','station':'8531680','report_year':2022})
if not (raw/'roads.json').exists():
    road_source=repo/'assets/highlands-data/roads.geojson'
    (raw/'roads.json').write_text(road_source.read_text())

# Download every page; GeoJSON responses do not expose exceededTransferLimit reliably.
parcels=json.loads((raw/'parcels.json').read_text())['features'];offset=len(parcels)
while offset and offset%2000==0:
 d=get('https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0/query',{'where':"PCL_MUN='1319'",'outFields':'OBJECTID,PAMS_PIN,PCL_MUN,PCLBLOCK,PCLLOT,PROP_LOC,PROP_CLASS,BLDG_DESC,LAND_DESC','returnGeometry':'true','outSR':4326,'f':'geojson','resultOffset':offset,'resultRecordCount':2000,'orderByFields':'OBJECTID','geometryPrecision':7})
 b=d.get('features',[]);parcels.extend(b);offset+=len(b)
 if len(b)<2000:break
# Deduplicate by published identifier because the initial page used service order.
parcels=list({f['properties']['OBJECTID']:f for f in parcels}.values())
boundary=json.loads((repo/'Boundaries/Highlands Borough.geojson').read_text())
bgeom=unary_union([shape(f['geometry']) for f in boundary['features']]) if boundary['type']=='FeatureCollection' else shape(boundary.get('geometry',boundary))
transform=Transformer.from_crs(4326,6527,always_xy=True)
query=np.asarray(Image.open(repo/'assets/hydraulic-connectivity-v1/queries/HighlandsHydraulicQuery5ft.png').convert('RGBA'))
h,w=query.shape[:2]
def ground(lon,lat):
 x,y=transform.transform(lon,lat);col=int((x-629944.9999999895)/5);row=int((575194.9999999992-y)/5)
 if 0<=col<w and 0<=row<h:
  px=query[row,col];encoded=int(px[0])*256+int(px[1])
  if encoded and px[2]!=255:return round((encoded-32768)/10,2)
 return None
# Hourly archived maxima retain their documented cadence. No fabricated 15-minute observations.
obs=json.loads((repo/'observed.json').read_text());series=[]
for day in obs['days']:
 for row in day.get('hours',[]):
  val=row.get('navd88StageFt');stamp=row.get('timeUtc')
  if isinstance(val,(int,float)) and math.isfinite(val) and -10<val<25 and stamp:
   series.append((int(datetime.datetime.fromisoformat(stamp.replace('Z','+00:00')).timestamp()),val))
series=sorted(dict(series).items());times=[x[0]for x in series];levels=[x[1]for x in series]
# Reuse the tested North Wildwood CDF fitting functions, with local observations and NOAA Sandy Hook curves.
from highlands_projection_model import fit_local_gauge_trend,build_cdf_payload
ns={'fit_local_gauge_trend':fit_local_gauge_trend,'build_cdf_payload':build_cdf_payload}
trend,trend_meta=ns['fit_local_gauge_trend'](times,levels)
events=[];base=datetime.datetime(2026,1,1,tzinfo=datetime.timezone.utc).timestamp();start=0
for end in range(1,len(series)+1):
 if end<len(series) and series[end][0]-series[end-1][0]<=5400:continue
 vals=np.array(levels[start:end]);idx,_=find_peaks(vals,distance=6,prominence=.2)
 for i in idx:
  stamp,val=series[start+int(i)];events.append({'timeUtc':datetime.datetime.fromtimestamp(stamp,datetime.timezone.utc).isoformat().replace('+00:00','Z'),'year':datetime.datetime.fromtimestamp(stamp,datetime.timezone.utc).year,'navd88Ft':val,'rebasedNavd88Ft':val+trend*(base-stamp)/(365.2425*86400)})
 start=end
peaks=sorted(e['rebasedNavd88Ft']for e in events)
cdf=ns['build_cdf_payload'](obs,events,peaks,trend,json.loads((raw/'slr.json').read_text()),trend_meta)
cdf['schema']='highlands-flood-history-projections-v4';cdf['site']={'name':'Sea Bright USGS 01407600','usgsId':'01407600','noaaScenarioStationId':'8531680','noaaScenarioStationName':'Sandy Hook'}
cdf['sources']['observed']='Existing Sea Bright USGS 01407600 hourly-max archive';cdf['sources']['localObservedTrend']='Equal-weight monthly means of the existing hourly-max archive; hourly maxima may bias the mean.'
cdf['method']['historic']='Local maxima in contiguous hourly-max records, separated by at least six hours with 0.2 ft prominence; gauge exceedances, not documented property flood events.'
cdf['floodDefinition']['elevationRule']='Local five-foot terrain at NSI structure point plus USACE modeled foundation height; parcel representative point if no structure is matched.'
cdf['limitations']=['Screening estimate, not surveyed first-floor elevation or validated property flood history.','Projected counts assume a stationary tide distribution shifted by relative sea-level change; do not include changing storm climatology, waves, or future defenses.','Bootstrap range describes sample variation only; excludes floor, terrain, sea-level-scenario and hydraulic-model uncertainty.','No inference that a parcel is hydrologically connected solely because a gauge exceeds its floor.']
cdf['qualityPolicyVersion']='highlands-hourly-finite-gap6h-v1';cdf['method']['future']=cdf['method']['future'].replace('parcel elevation','screening elevation')
save('flood-projections.json',cdf)
# NSI records are deduplicated to the lowest modeled occupied floor per footprint.
nsi=json.loads((raw/'nsi.json').read_text());groups={}
for f in nsi.get('features',[]):
 lon,lat=f['geometry']['coordinates'][:2]
 if not bgeom.covers(Point(lon,lat)):continue
 pr=f.get('properties',{});fh=pr.get('found_ht');g=ground(lon,lat)
 if g is None or not isinstance(fh,(int,float)) or not math.isfinite(fh) or fh<0:continue
 key=str(pr.get('ftprntid')or pr.get('fd_id'));floor=g+fh
 if key in groups and groups[key]['properties']['modeledFirstFloorNavd88Ft']<=floor:continue
 groups[key]={'type':'Feature','id':pr.get('fd_id'),'geometry':f['geometry'],'properties':{'footprintId':key,'foundationHeightFt':round(fh,2),'localGroundNavd88Ft':g,'modeledFirstFloorNavd88Ft':round(floor,2),'foundationType':pr.get('found_type'),'stories':pr.get('num_story'),'source':'USACE NSI API; retrieved '+now[:10],'method':'localTerrainPlusNSIFoundationHeight'}}
structures=list(groups.values());hist=sorted(e['navd88Ft']for e in events)
for f in structures:
 floor=f['properties']['modeledFirstFloorNavd88Ft'];f['properties']['nsi2026HistoricFirstFloorExceedanceCount']=len(hist)-bisect.bisect_right(hist,floor+.1)
save('structures.geojson',{'type':'FeatureCollection','metadata':{'schema':'highlands-structure-floor-v1','retrievedUtc':now,'source':'https://nsi.sec.usace.army.mil/nsiapi/structures?fmt=fc','units':'feet NAVD88','screeningOnly':True},'features':structures})
# Public parcel geometry only; do not store owners or tax-value data.
features=[];image=Image.new('RGBA',(w,h));draw=ImageDraw.Draw(image)
for f in parcels:
 geom=shape(f['geometry'])
 if not geom.intersects(bgeom):continue
 pr=f['properties'];pt=geom.representative_point();g=ground(pt.x,pt.y)
 matching=[x for x in structures if geom.covers(Point(x['geometry']['coordinates']))]
 selected=min(matching,key=lambda x:x['properties']['modeledFirstFloorNavd88Ft'])if matching else None
 props={'parcelId':pr['PAMS_PIN'],'address':pr.get('PROP_LOC')or'Highlands parcel','block':pr.get('PCLBLOCK'),'lot':pr.get('PCLLOT'),'centroidLon':round(pt.x,7),'centroidLat':round(pt.y,7),'elevationNavd88Ft':g}
 if selected:
  props.update(selected['properties']);selected['properties']['address']=props['address'];elev=props['modeledFirstFloorNavd88Ft'];props['nsi2026ModeledFirstFloorNavd88Ft']=elev
 else:elev=g
 if elev is not None:
  props['modelElevationIndex']=min(range(len(cdf['elevationGridFtNavd88'])),key=lambda i:abs(cdf['elevationGridFtNavd88'][i]-elev));props['historicFloodEventCount']=len(hist)-bisect.bisect_right(hist,elev+.1)
 features.append({'type':'Feature','geometry':f['geometry'],'properties':props})
 geoms=list(geom.geoms)if geom.geom_type=='MultiPolygon'else[geom]
 for poly in geoms:
  for ring in [poly.exterior,*poly.interiors]:
   points=[]
   for lon,lat in ring.coords:
    x,y=transform.transform(lon,lat);points.append(((x-629944.9999999895)/5,(575194.9999999992-y)/5))
   draw.line(points,fill=(248,113,113,220),width=1)
image.save(out/'parcel-boundaries.png');save('parcels.geojson',{'type':'FeatureCollection','source':'NJOGIS parcels; planning geometry, not surveyed legal boundaries','features':features})
save('structures.geojson',{'type':'FeatureCollection','metadata':{'schema':'highlands-structure-floor-v1','retrievedUtc':now,'screeningOnly':True,'source':'USACE NSI API'},'features':structures})
# Published NACCS station in Sandy Hook Bay beside Highlands, no North Wildwood levels or fitted local weighting.
naccs=json.loads((raw/'naccs.json').read_text());station=next(f for f in naccs['features']if f['attributes']['StationId']==11544)
intervals=[]
for years in [1,2,5,10,20,50,100,200,500,1000,2000,5000,10000]:
 target=station['attributes'][f'WL_ARI_{years}']*3.280839895
 rows=[]
 for i in range(97):
  offset=i/4-12;stage=target-6*(1-math.cos(math.pi*offset/12))/2
  stamp=datetime.datetime(2026,1,1,tzinfo=datetime.timezone.utc)+datetime.timedelta(hours=12+offset)
  rows.append({'timeUtc':stamp.isoformat().replace('+00:00','Z'),'offsetHours':offset,'navd88StageFt':round(stage,3),'mllwStageFt':round(stage+2.13,3),'syntheticStorm':True,'observationInterval':'15min'})
 intervals.append({'years':years,'targetNavd88Ft':round(target,4),'series15min':rows})
save('return-intervals.json',{'schema':'highlands-published-naccs-scenarios-v1','generatedUtc':now,'stationId':11544,'stationCoordinates':station['geometry'],'source':'https://services.northeastoceandata.org/arcgis1/rest/services/NACCS/NACCS/MapServer/1','sourceDatum':'NAVD88','method':'Published NACCS 2015 mean still-water ARI level at nearby Sandy Hook Bay save point 11544. Direct levels, no local-gauge weighting.','shapeMethod':'Illustrative symmetric 24-hour 6-foot rise/fall centered on each published crest. Shape and duration have no return-period interpretation and are not a local storm simulation.','windowHours':24,'intervals':intervals})
roads=json.loads((raw/'roads.json').read_text());save('roads.geojson',roads)
report={'generatedUtc':now,'parcels':len(features),'structures':len(structures),'matchedParcels':sum('modeledFirstFloorNavd88Ft'in f['properties']for f in features),'archiveHours':len(series),'highTidePeaks':len(events),'annualTrendFt':trend,'naccsStation':11544,'returnLevelsNavd88Ft':{x['years']:x['targetNavd88Ft']for x in intervals}}
(p/'data-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
