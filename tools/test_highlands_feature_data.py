from pathlib import Path
import json,math,sys
p=Path(__file__).resolve().parent.parent
import numpy as np
from shapely.geometry import shape,Point
from shapely.ops import unary_union
root=p/'assets/highlands-data';read=lambda n:json.loads((root/n).read_text())
b=json.loads((p/'Boundaries/Highlands Borough.geojson').read_text());g=unary_union([shape(f['geometry'])for f in b['features']]) if b['type']=='FeatureCollection' else shape(b['geometry'])
s=read('structures.geojson');assert len(s['features'])>1000
for f in s['features']:
 assert g.covers(Point(f['geometry']['coordinates']))
 pr=f['properties'];assert abs(pr['localGroundNavd88Ft']+pr['foundationHeightFt']-pr['modeledFirstFloorNavd88Ft'])<.02
pcl=read('parcels.geojson');assert len(pcl['features'])>2000;assert len({f['properties']['parcelId']for f in pcl['features']})==len(pcl['features'])
for f in pcl['features']:
 assert f['properties']['parcelId'].startswith('1319_');assert g.intersects(shape(f['geometry']))
levels=read('return-intervals.json');targets=[]
for record in levels['intervals']:
 rows=record['series15min'];assert len(rows)==97;target=record['targetNavd88Ft'];targets.append(target)
 assert abs(max(x['navd88StageFt']for x in rows)-target)<.001
 assert all(abs(r['mllwStageFt']-r['navd88StageFt']-2.13)<.001 for r in rows)
 assert all(x['syntheticStorm']for x in rows)
assert all(a<b for a,b in zip(targets,targets[1:]));assert levels['stationId']==11544
cdf=read('flood-projections.json');assert cdf['site']['usgsId']=='01407600';assert cdf['site']['noaaScenarioStationId']=='8531680'
assert cdf['highTidePeakCount']>10000
for key,record in cdf['annualFloodEventCount'].items():
 a=np.array(record['estimate']);lo=np.array(record['lower95']);hi=np.array(record['upper95']);assert a.shape==(421,75)
 assert np.isfinite(a).all() and (a>=0).all() and(a<=705).all();assert (lo<=hi).all()
 assert(np.diff(a,axis=0)<=.011).all();assert(np.diff(a,axis=1)>=-.011).all()
print(json.dumps({'structures':len(s['features']),'parcels':len(pcl['features']),'localSourcesConfirmed':True,'scenarioCrestsAndDatumsVerified':True,'projectionDimensionsAndMonotonicity':True}))
