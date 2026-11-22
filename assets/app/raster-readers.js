if (FLOODMAPPER_TOWN_DATA.compatibility.hydraulicCatalog.startsWith("phase-v2")) {
/* Exact numeric query pixels, with at most one decoded 64-row strip per grid. */
window.AvalonQueryStripes = {
  async load(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let packed;
    try {
      const response = await fetch(url, {signal:controller.signal});
      if (!response.ok) throw new Error(`Query strips: HTTP ${response.status}`);
      packed = await response.json();
    } finally { clearTimeout(timeout); }
    const {width,height,rows,chunks} = packed;
    if (packed.schema !== 'avalon-query-stripes-v1' || !Number.isInteger(width) || !Number.isInteger(height) ||
        width < 1 || height < 1 || width > 8192 || height > 8192 || rows !== 64 ||
        !Array.isArray(chunks) || chunks.length !== Math.ceil(height/rows)) throw new Error('Invalid query strip manifest');
    let cachedIndex=-1, cachedPromise=null;
    return {
      width, height, stripeRows:rows, storage:'compressed-stripes',
      async readRows(y, count) {
        if (!Number.isInteger(y) || y < 0 || y % rows || count !== Math.min(rows,height-y)) throw new Error('Invalid query strip request');
        const index=y/rows;
        if(index===cachedIndex) return cachedPromise;
        cachedIndex=index;
        cachedPromise=(async()=>{
          const binary=atob(chunks[index]);
          const compressed=Uint8Array.from(binary,c=>c.charCodeAt(0));
          const stream=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
          const pixels=new Uint8Array(await new Response(stream).arrayBuffer());
          if(pixels.length!==width*count*4) throw new Error('Truncated query strip');
          return pixels;
        })();
        try { return await cachedPromise; }
        catch(error) { cachedIndex=-1; cachedPromise=null; throw error; }
      }
    };
  }
};

}

if (FLOODMAPPER_TOWN_DATA.compatibility.hydraulicCatalog === "phase-v2-sparse") {
/* Lossless candidate pixels for continuous filling, generated with the V2 rasters. */
(() => {
  const cache = new Map();
  const CACHE_LIMIT = 6;

  async function load(url, expected) {
    if (cache.has(url)) return cache.get(url);
    const request = (async () => {
      if (typeof DecompressionStream !== "function") throw new Error("Gzip streams are unavailable");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      let payload;
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Sparse transition: HTTP ${response.status}`);
        payload = await response.json();
      } finally {
        clearTimeout(timeout);
      }
      if (payload.schema !== "avalon-sparse-transition-v1" ||
          payload.mode !== expected.mode || payload.phase !== expected.phase ||
          payload.lowerStageCode !== expected.lowerStageCode ||
          payload.width !== expected.width || payload.height !== expected.height ||
          !Number.isInteger(payload.candidates) || payload.candidates < 0 ||
          payload.candidates > expected.width * expected.height ||
          typeof payload.gzipBase64 !== "string") {
        throw new Error("Sparse transition metadata does not match this frame");
      }
      const cdnHash = /\/objects\/([a-f0-9]{64})\.webp(?:\?|$)/.exec(expected.lowerUrl || "")?.[1];
      if (cdnHash && cdnHash !== payload.sourceSha256?.lower) {
        throw new Error("Sparse transition source image does not match the CDN object");
      }
      const binary = atob(payload.gzipBase64);
      const compressed = Uint8Array.from(binary, character => character.charCodeAt(0));
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      const indices = new Uint32Array(payload.candidates);
      const ground = new Uint16Array(payload.candidates);
      let position = 0;
      let lastIndex = 0;
      for (let i = 0; i < payload.candidates; i += 1) {
        let delta = 0;
        let shift = 0;
        let octet;
        do {
          if (position >= bytes.length || shift > 28) throw new Error("Malformed sparse transition index");
          octet = bytes[position++];
          delta += (octet & 127) * 2 ** shift;
          shift += 7;
        } while (octet & 128);
        if (position + 2 > bytes.length) throw new Error("Truncated sparse transition elevation");
        const index = lastIndex + delta;
        if ((i > 0 && index <= lastIndex) || index >= expected.width * expected.height) {
          throw new Error("Sparse transition indexes are out of order");
        }
        const code = bytes[position] | (bytes[position + 1] << 8);
        if (!code) throw new Error("Sparse transition has a missing elevation");
        position += 2;
        indices[i] = index;
        ground[i] = code;
        lastIndex = index;
      }
      if (position !== bytes.length) throw new Error("Sparse transition has trailing data");
      return { indices, ground, width: payload.width, height: payload.height };
    })();
    cache.set(url, request);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    try { return await request; }
    catch (error) { if (cache.get(url) === request) cache.delete(url); throw error; }
  }

  window.AvalonSparseTransitions = { load };
})();

}

if (Boolean(FLOODMAPPER_TOWN_DATA.overlays.pointStripesIndexPath)) {
/* Fetch only the 64-row numeric stripe needed by a map click. */
(() => {
  const indexCache = new Map();
  const stripeCache = new Map();
  const STRIPE_CACHE_LIMIT = 3;

  async function getJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Point query stripe: HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function info(url) {
    if (!indexCache.has(url)) {
      indexCache.set(url, getJson(url).then(record => {
        if (record.schema !== "avalon-point-stripes-v1" ||
            !Number.isInteger(record.width) || !Number.isInteger(record.height) ||
            record.width < 1 || record.height < 1 || record.width > 8192 || record.height > 8192 ||
            record.rows !== 64 || record.stripes !== Math.ceil(record.height / record.rows)) {
          throw new Error("Invalid point query stripe index");
        }
        return record;
      }).catch(error => { indexCache.delete(url); throw error; }));
    }
    return indexCache.get(url);
  }

  async function read(url, metadata, x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 ||
        x >= metadata.width || y >= metadata.height) throw new Error("Point query is outside the grid");
    let request = stripeCache.get(url);
    if (!request) {
      request = (async () => {
        if (typeof DecompressionStream !== "function") throw new Error("Gzip streams are unavailable");
        const record = await getJson(url);
        const firstRow = Math.floor(y / metadata.rows) * metadata.rows;
        if (record.schema !== "avalon-point-stripe-v1" ||
            record.width !== metadata.width || record.height !== metadata.height ||
            record.y !== firstRow || record.rows !== Math.min(metadata.rows, metadata.height - firstRow) ||
            typeof record.gzipBase64 !== "string") throw new Error("Point query stripe does not match the index");
        const binary = atob(record.gzipBase64);
        const compressed = Uint8Array.from(binary, character => character.charCodeAt(0));
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
        const data = new Uint8Array(await new Response(stream).arrayBuffer());
        const pixels = record.width * record.rows;
        if (data.length !== pixels * 2 + Math.ceil(pixels / 8)) {
          throw new Error("Point query stripe has an invalid byte length");
        }
        return { firstRow, rows: record.rows, data };
      })();
      stripeCache.set(url, request);
      while (stripeCache.size > STRIPE_CACHE_LIMIT) stripeCache.delete(stripeCache.keys().next().value);
    }
    let stripe;
    try { stripe = await request; }
    catch (error) { if (stripeCache.get(url) === request) stripeCache.delete(url); throw error; }
    const offset = (y - stripe.firstRow) * metadata.width + x;
    const bitsetStart = metadata.width * stripe.rows * 2;
    const groundCode = stripe.data[offset * 2] * 256 + stripe.data[offset * 2 + 1];
    const developed = Boolean(stripe.data[bitsetStart + (offset >> 3)] & (1 << (offset & 7)));
    return { groundCode, developed };
  }

  window.AvalonPointStripes = { info, read };
})();

}
