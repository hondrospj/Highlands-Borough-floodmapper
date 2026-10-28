import importlib.util,json,tempfile,unittest,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from refresh_contract import validate
spec=importlib.util.spec_from_file_location('overlay_publisher',ROOT/'.shorelysafe/publish_data_overlay.py');publisher=importlib.util.module_from_spec(spec);spec.loader.exec_module(publisher)
class PreservedPublicationTests(unittest.TestCase):
 def test_generated_data_overlay_retains_all_deployed_ui_blobs(self):
  with tempfile.TemporaryDirectory()as d:
   p=Path(d);(p/'forecast.json').write_text('{"issuedUtc":"2026-10-28T12:00:00Z"}')
   base={'files':{'index.html':{'sha256':'ui','size':99},'assets/ui.js':{'sha256':'asset','size':52},'forecast.json':{'sha256':'old','size':4}}}
   after,payloads,changed=publisher.overlay(base,p,('forecast.json',),[])
   self.assertEqual(after['index.html'],base['files']['index.html']);self.assertEqual(after['assets/ui.js'],base['files']['assets/ui.js']);self.assertEqual(changed,['forecast.json']);self.assertEqual(base['files']['forecast.json']['sha256'],'old')
 def test_invalid_generated_json_never_reaches_publication(self):
  with tempfile.TemporaryDirectory()as d:
   p=Path(d);(p/'forecast.json').write_text('{incomplete')
   with self.assertRaises(ValueError):publisher.overlay({'files':{'index.html':{'sha256':'ui','size':3}}},p,('forecast.json',),[])
