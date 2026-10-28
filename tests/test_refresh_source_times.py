import json,tempfile,sys,unittest
from datetime import datetime,timezone,timedelta
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from refresh_contract import validate
class ActualObservationTimeTests(unittest.TestCase):
 def test_fresh_processing_timestamp_cannot_disguise_stale_observations(self):
  with tempfile.TemporaryDirectory()as d:
   p=Path(d);now=datetime(2026,10,28,18,tzinfo=timezone.utc)
   f={'stationId':'8531804','operationalForecastStatistic':'ensemble_mean','issuedUtc':'2026-10-28T18:00:00Z','petssCycleUtc':'2026-10-28T06:00:00Z','forecastEndUtc':'2026-11-01T06:00:00Z'}
   o={'site':'01407600','datum':'NAVD88','lastProcessedISO':'2026-10-28T18:00:00Z','days':[{'hours':[{'timeUtc':'2026-10-28T10:00:00Z','navd88StageFt':1.2}]}]}
   (p/'forecast.json').write_text(json.dumps(f));(p/'observed.json').write_text(json.dumps(o))
   with self.assertRaisesRegex(AssertionError,'Stale'):validate(p,'mapper',now)
