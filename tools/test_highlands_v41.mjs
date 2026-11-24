import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const config = JSON.parse(index.match(/<template id="floodmapperTownData">([\s\S]+?)<\/template>/)[1]);
const script = id => index.match(new RegExp('<script id="' + id + '">([\\s\\S]+?)</script>'))[1];
const startup = script('floodmapper-early-forecast');
const reload = script('floodmapper-v41-reload');
const issue = Date.parse('2026-11-24T06:00:00Z');
const hour = 3600000;
const formatTime = time => new Date(time).toISOString();
const v41Url = 'https://hondrospj.github.io/statewide-service/data/v41_forecasts_mllw.json';
const petssUrl = 'https://fixture.example/highlands/forecast.json';

assert.equal(config.site.petssGaugeId, '8531804');
assert.equal(config.site.usgsGaugeId, '01407600');
assert.equal(config.datums.navd88OffsetFromMllwFt, -2.13);

const seaBright = {
  station_id: '8531804',
  gauge_id: '01407600',
  gauge_agency: 'USGS',
  navd88_to_mllw_ft: 2.13,
  datum: 'MLLW',
  model_time_utc: formatTime(issue),
  forecast_hours: 144,
  physical_paths: 103,
  through_utc: formatTime(issue + 144 * hour),
  forecast_receipt_sha256: 'a'.repeat(64),
  points: Array.from({length: 144}, (_, index) => ({
    t: formatTime(issue + (index + 1) * hour),
    fcst: 6.4084,
    tide: 5.3,
    source_twl10p: 6.0757,
    source_twl90p: 6.6641,
  })),
};
const originalFeed = {
  schema_version: 1,
  model_version: 'v41',
  model_time_utc: formatTime(issue),
  generated_utc: formatTime(issue + 8 * hour),
  datum: 'MLLW',
  units: 'ft',
  forecast_statistic: 'ensemble_mean',
  stations: {
    '8531804': seaBright,
    '8531680': {...seaBright, station_id: '8531680', gauge_id: '8531680',
      gauge_agency: 'NOAA', navd88_to_mllw_ft: 2.82},
  },
};

async function start({ mutate, now = issue + 8.5 * hour, outage = false } = {}) {
  const feed = structuredClone(originalFeed);
  mutate?.(feed);
  const window = {location: {href:'https://fixture.example/highlands/'}, setTimeout, clearTimeout};
  const requests = [];
  const petss = {sourceType: 'PETSS fallback'};
  class TestDate extends Date {
    static now() { return now; }
  }
  const ctx = vm.createContext({
    window, URL, AbortController, Date: TestDate,
    document: {getElementById: () => ({content: {textContent: JSON.stringify(config)}})},
    console: {warn() {}},
    fetch: async url => {
      requests.push(url);
      assert.ok([v41Url, petssUrl].includes(url));
      return {ok: url === petssUrl || !outage, status: 503,
        json: async () => url === petssUrl ? petss : feed};
    },
  });
  vm.runInContext(startup, ctx);
  const {data, error} = await window.floodmapperStartupForecast.request;
  assert.ifError(error);
  return {ctx, data, petss, requests};
}

const {ctx, data, petss, requests} = await start();
assert.equal(data.sourceType, 'SHORELYSAFE_V41_WEIGHTED_ECMWF_103_PATHS');
assert.equal(data.sourceCycleUtc, formatTime(issue));
assert.equal(data.usgsGaugeId, '01407600');
assert.equal(data.stationId, '8531804');
assert.equal(data.weatherPaths, 103);
assert.equal(data.forecastStartUtc, formatTime(issue + 9 * hour));
assert.equal(data.forecastEndUtc, formatTime(issue + 105 * hour));
for (const [scenario, navd, mllw] of [
  ['mean', 4.2784, 6.4084], ['lowEnd', 3.9457, 6.0757], ['highEnd', 4.5341, 6.6641],
]) {
  const rows = data.scenarioForecasts[scenario].hours;
  assert.equal(rows.length, 97);
  const thursday = rows.find(row => row.timeUtc === '2026-11-26T15:00:00.000Z');
  assert.equal(thursday.navd88StageFt, navd);
  assert.equal(thursday.mllwStageFt, mllw);
}
assert.deepEqual(requests, [v41Url]);

ctx.FORECAST_URL = petssUrl;
ctx.forecastData = data;
ctx.HELP_COPY = {forecastType: {body: 'Compare three scenarios based on NOAA PETSS guidance.'}};
ctx.physicsManifestMatchesForecastCycle = () => true;
ctx.fetchJson = async url => url === petssUrl ? data : petss;
delete ctx.window.floodmapperStartupForecast;
vm.runInContext(reload, ctx);
assert.equal(ctx.physicsManifestMatchesForecastCycle({}), false);
assert.match(ctx.HELP_COPY.forecastType.body, /ShorelySafe V41/);
assert.equal((await ctx.fetchJson(petssUrl, {cache: 'no-cache'})).sourceCycleUtc, formatTime(issue));
assert.deepEqual(requests, [v41Url, v41Url]);
ctx.forecastData = petss;
assert.equal(ctx.physicsManifestMatchesForecastCycle({}), true);
assert.match(ctx.HELP_COPY.forecastType.body, /NOAA PETSS/);

for (const failed of [
  {mutate: feed => delete feed.stations['8531804']},
  {mutate: feed => { feed.stations['8531804'] = feed.stations['8531680']; }},
  {mutate: feed => { feed.stations['8531804'].gauge_id = '01411360'; }},
  {mutate: feed => { feed.stations['8531804'].navd88_to_mllw_ft = 2.82; }},
  {mutate: feed => { feed.stations['8531804'].points[15].t = formatTime(issue + 15 * hour); }},
  {mutate: feed => { feed.stations['8531804'].points[15].source_twl10p = 8; }},
  {now: issue + 18 * hour + 1},
  {outage: true},
]) {
  const fallback = await start(failed);
  assert.equal(fallback.data, fallback.petss);
  assert.deepEqual(fallback.requests, [v41Url, petssUrl]);
}

console.log('Highlands Version 41 station, datum, three scenarios, reload, and fallback verified.');
