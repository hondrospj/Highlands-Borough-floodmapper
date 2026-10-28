#!/usr/bin/env python3
"""Check actual source observations/forecast coverage and record generated-file digests."""
import argparse,hashlib,json,math,urllib.request
from datetime import datetime,timedelta,timezone
from pathlib import Path

def instant(value): return datetime.fromisoformat(value.replace("Z","+00:00")).astimezone(timezone.utc)
def iso(value): return value.isoformat().replace("+00:00","Z")
def age(value,now,hours):
    value=instant(value);assert timedelta(minutes=-30)<=now-value<=timedelta(hours=hours),"Stale/future source timestamp: "+iso(value);return iso(value)
def load(root,name):return json.loads((root/name).read_text())
def cycle(meta):return instant(meta["run_dir"].split(".")[-1][:4]+"-"+meta["run_dir"].split(".")[-1][4:6]+"-"+meta["run_dir"].split(".")[-1][6:8]+"T"+meta["cycle"][1:3]+":00:00Z")

def observations(root,now):
    from urllib.parse import urlencode
    query={"product":"water_level","application":"shorelysafe-six-hour-refresh","station":"8531680","begin_date":(now-timedelta(days=2)).strftime("%Y%m%d"),"end_date":now.strftime("%Y%m%d"),"datum":"NAVD","time_zone":"gmt","units":"english","format":"json"}
    url="https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?"+urlencode(query)
    with urllib.request.urlopen(url,timeout=90)as response:raw=response.read(4194305)
    assert len(raw)<=4194304,"Unexpected observation response size";data=json.loads(raw);assert str(data.get("metadata",{}).get("id"))=="8531680","Observation station mismatch"
    rows=[]
    for r in data.get("data",[]):
        try:v=float(r["v"]);t=instant(r["t"].replace(" ","T")+"Z")
        except (KeyError,ValueError):continue
        if math.isfinite(v):rows.append({"t":iso(t),"navd88_ft":v})
    assert rows,"No measured NOAA observations";latest=max(r["t"]for r in rows);age(latest,now,6)
    payload={"station":"8531680","datum":"NAVD88","units":"ft","checkedAtUtc":iso(now),"latestObservationUtc":latest,"sourceUrl":url,"sourceResponseSha256":hashlib.sha256(raw).hexdigest(),"data":rows}
    (root/"data").mkdir(exist_ok=True);(root/"data/observations.json").write_text(json.dumps(payload,indent=2)+"\n")

def validate(root,profile,now=None,part="all"):
    now=now or datetime.now(timezone.utc);info={"profile":profile,"checkedAtUtc":iso(now)};files=[]
    if profile=="mapper":
        f=load(root,"forecast.json");o=load(root,"observed.json");assert str(f["stationId"])=="8531804" and str(o["site"])=="01407600" and o["datum"]=="NAVD88","Mapper gauge/datum mismatch"
        assert f.get("operationalForecastStatistic")=="ensemble_mean","Operational forecast must remain NOAA mean"
        latest=max(r["timeUtc"]for d in o["days"]for r in d.get("hours",[])if r.get("timeUtc")and isinstance(r.get("navd88StageFt"),(int,float))and math.isfinite(r["navd88StageFt"]))
        info.update(station="8531804",observationStation="01407600",datum="NAVD88",latestObservationUtc=latest,latestUpstreamCycleUtc=f["petssCycleUtc"],forecastEndUtc=f["forecastEndUtc"])
        if part in ("all","forecast"):
            age(f["issuedUtc"],now,6);age(f["petssCycleUtc"],now,18);assert instant(f["forecastEndUtc"])>=now+timedelta(hours=48),"Forecast coverage too short"
        if part in ("all","observed"):age(latest,now,6);age(o["lastProcessedISO"],now,6)
        files=["forecast.json","observed.json","toptides.json","data/experimental_petss_guidance.json"]
    elif profile=="dashboard":
        m=load(root,"data/petss_meta.json");f=load(root,"data/petss_forecast.json");p=load(root,"data/peaks_navd88.json");o=load(root,"data/observations.json")
        assert str(m["stid"])==str(p["site"])==o["station"]=="8531680","Dashboard station mismatch"
        assert m["datum"]=="MLLW" and p["datum"]==o["datum"]=="NAVD88","Dashboard datum mismatch"
        c=iso(cycle(m));latest=max(r["t"]for r in o["data"]if math.isfinite(r["navd88_ft"]));end=max(r["t"]for r in f)
        age(c,now,18);age(m["updated_utc"],now,6);age(p["lastProcessedISO"],now,6);age(latest,now,6);assert instant(end)>=now+timedelta(hours=48),"Forecast coverage too short"
        info.update(station="8531680",datum="NAVD88 observations; MLLW issued forecast",latestObservationUtc=latest,latestPeakProcessedUtc=p["lastProcessedISO"],latestUpstreamCycleUtc=c,forecastEndUtc=end)
        files=["data/petss_forecast.csv","data/petss_forecast.json","data/petss_meta.json","data/peaks_navd88.json","data/observations.json","data/petss_station_debug.txt"]
    elif profile=="roads":
        s=load(root,"flood_stats.json");from refresh_observed_history import validate_stats
        validate_stats(s);latest=s["sourceFreshness"]["latestObservationUtc"];age(latest,now,6);rows=s["dailyPeakArchive"];assert s["archive"]["endDate"]==max(r["date"]for r in rows)and s["archive"]["days"]==len(rows)
        info.update(station="01407600",datum="NAVD88",latestObservationUtc=latest,archiveEndDate=s["archive"]["endDate"],latestUpstreamCycleUtc=None);files=["flood_stats.json"]
    else:raise ValueError("Unknown refresh profile")
    info["files"]={name:{"sha256":hashlib.sha256((root/name).read_bytes()).hexdigest(),"bytes":(root/name).stat().st_size}for name in files if (root/name).is_file()}
    return info

def main():
    p=argparse.ArgumentParser();p.add_argument("--profile",choices=["mapper","dashboard","roads"],required=True);p.add_argument("--part",choices=["all","forecast","observed"],default="all");p.add_argument("--refresh-observations",action="store_true");p.add_argument("--check",action="store_true");args=p.parse_args();root=Path.cwd();now=datetime.now(timezone.utc)
    if args.refresh_observations:assert args.profile=="dashboard";observations(root,now)
    info=validate(root,args.profile,now,args.part)
    if not args.check:(root/"data").mkdir(exist_ok=True);(root/"data/refresh_status.json").write_text(json.dumps(info,indent=2)+"\n")
    print(json.dumps(info))
if __name__=="__main__":main()
