"""Patch only the expired notice in the current published mapper manifest."""
import base64,hashlib,json,os,re,time,urllib.request,urllib.error
SITE='https://cupajoe.live';APP=os.environ['APP_ID'];TOKEN=os.environ['SHORELYSAFE_PUBLISH_TOKEN'];SOURCE=os.environ['SOURCE_COMMIT'];ROUTE=os.environ['APP_ROUTE'];NAME=os.environ['MAPPER_NAME']
assert TOKEN and re.fullmatch(r'[a-f0-9]{40}',SOURCE)
assert APP in {'floodmapper--avalon','floodmapper--cape-may','floodmapper--highlands','floodmapper--north-wildwood','floodmapper--stone-harbor'}
sha=lambda data:hashlib.sha256(data).hexdigest()
OLD='''      const forecastNotice = freshness?.state === "expired"
        ? `Forecast expired ${formatFixedESTFromUtc(freshness.timestamp, true)}. Select Forecast to check for an update.`
        : freshness?.state === "stale"
          ? `Forecast from ${formatFixedESTFromUtc(freshness.timestamp, true)} is over 72 hours old. Select Forecast to check for an update.`
          : "";'''
NEW='''      const forecastNotice = freshness?.state === "stale"
        ? `Forecast from ${formatFixedESTFromUtc(freshness.timestamp, true)} is over 72 hours old. Select Forecast to check for an update.`
        : "";'''
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
opener=urllib.request.build_opener(NoRedirect)
def api(endpoint,method='GET',payload=None):
 body=json.dumps(payload,separators=(',',':')).encode() if payload is not None else None
 headers={'X-ShorelySafe-Token':TOKEN,'Cache-Control':'no-cache'}
 if body is not None:headers['Content-Type']='application/json'
 try:
  with opener.open(urllib.request.Request(SITE+'/wp-json/shorelysafe/v1/apps/'+APP+'/'+endpoint,data=body,headers=headers,method=method),timeout=180) as response:return json.load(response)
 except urllib.error.HTTPError as error:raise RuntimeError(f'Publisher {method} {endpoint.split("?")[0]} HTTP {error.code}') from None
def fetch(path,expected):
 for _ in range(3):
  with opener.open(urllib.request.Request(SITE+ROUTE+path+'?sha='+expected[:16],headers={'Cache-Control':'no-cache'}),timeout=90) as response:data=response.read()
  if sha(data)==expected:return data
 raise ValueError('Served asset differs from current deployment manifest: '+path)
def patch(data):
 text=data.decode()
 if text.count(OLD)==1:return text.replace(OLD,NEW).encode()
 if text.count(NEW)==1 and 'Forecast expired' not in text:return data
 raise ValueError('Unexpected expired notice block; refusing unrelated change')
def publish():
 displaced=None
 for _ in range(5):
  before=api('state?manifest=1');current=before.get('manifest',{}).get('files')
  assert before.get('published') and isinstance(current,dict),'Published manifest missing'
  if displaced and before['deployment']!=displaced[0]:displaced=None
  index=fetch('index.html',current['index.html']['sha256'])
  if APP=='floodmapper--north-wildwood' and b'assets/app/runtime.js' in index:
   runtime=patch(fetch('assets/app/runtime.js',current['assets/app/runtime.js']['sha256']))
   index,count=re.subn(rb'(assets/app/runtime\.js\?v=)[a-f0-9]+',lambda match:match[1]+sha(runtime)[:16].encode(),index)
   assert count==1,'Canonical runtime link missing'
   files={'index.html':index,'assets/app/runtime.js':runtime}
  else:files={'index.html':patch(index)}
  baseline=displaced[1] if displaced else current;after=dict(baseline)
  for path,data in files.items():after[path]={'sha256':sha(data),'size':len(data)}
  if after==current:
   return {'name':NAME,'app':APP,'url':SITE+ROUTE,'deployment':before['deployment'],'source_commit':SOURCE,'files':{p:sha(d) for p,d in files.items()},'published':True,'alreadyPatched':True}
  assert set(after)==set(baseline),'Unexpected asset addition/removal'
  assert all(after[p]==v for p,v in baseline.items() if p not in files),'Untargeted assets changed'
  available={sha(data):data for data in files.values()}
  plan=api('plan','POST',{'commit':SOURCE,'files':[{'path':p,**v} for p,v in sorted(after.items())]})
  assert not (set(plan['missing'])-available.keys()),'Existing deployment blobs unavailable'
  if plan['missing']:api('batch?deployment='+plan['deployment'],'POST',{'blobs':[{'sha256':h,'data':base64.b64encode(available[h]).decode()} for h in plan['missing']]})
  if api('state').get('deployment')!=before['deployment']:continue
  api('commit','POST',{'deployment':plan['deployment']})
  verified=api('state?manifest=1')
  if verified.get('manifest',{}).get('files')!=after:continue
  previous=verified.get('previous') or {}
  if previous.get('deployment')!=before['deployment']:
   assert isinstance(previous.get('files'),dict),'Cannot preserve intervening publication'
   displaced=(verified['deployment'],previous['files']);continue
  assert all(after[p]==v for p,v in baseline.items() if p not in files)
  return {'name':NAME,'app':APP,'url':SITE+ROUTE,'deployment':plan['deployment'],'previous_deployment':before['deployment'],'source_commit':SOURCE,'files':{p:sha(d) for p,d in files.items()},'preserved_files':len(set(after)-set(files)),'published':True}
 raise RuntimeError('Publisher state advanced repeatedly')
result=publish()
open('publication-receipt.json','w').write(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,sort_keys=True))
