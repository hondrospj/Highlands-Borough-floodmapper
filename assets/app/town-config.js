
const BUNNY_STORAGE_ZONE_ID = "5907481";
const BUNNY_CDN_BASE_URL = "https://floodmapperv1.b-cdn.net";

function bunnyCdnUrl(path) {
  const cleanBase = String(BUNNY_CDN_BASE_URL || "").replace(/\/+$/, "");
  const cleanPath = String(path || "")
    .replace(/^\/+/, "")
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");
  return `${cleanBase}/${cleanPath}`;
}

TOWN_CONFIG = FLOODMAPPER_TOWN_DATA;
installFloodDataReaders(TOWN_CONFIG);
applyTownConfig(TOWN_CONFIG);
installRoadImpacts(TOWN_CONFIG);

async function preloadNorthWildwoodExperience(mainPromise) {
  // The initial 2D flood map is sufficient to make the app usable. The 3D
  // launcher owns runtime, terrain, and building loading when selected.
  if (!window.floodmapperMapDependenciesReady) return;
  try {
    await mainPromise;
  } catch (error) {
    console.error(error);
    window.dispatchEvent(new Event('nww:map-dependency-error'));
    return;
  }
  document.body.dataset.sitePreload = "complete";
  document.body.dataset.sitePreloadBlockingPolicy = "initial-flood-renderer-3d-on-demand";
  document.body.dataset.sitePreloadAvoidedBytes = "3d-observed-parcels-nsi-export-libraries";
  document.body.dataset.map3dDeferredWarmup = "on-demand-no-background-camera-traversal";
  document.body.classList.add("nw-app-ready");
}

window.floodmapperMapDependenciesReady = Boolean(window.L && typeof L.map === 'function');
if (!window.floodmapperMapDependenciesReady) window.dispatchEvent(new Event('nww:map-dependency-error'));
preloadNorthWildwoodExperience(window.floodmapperMapDependenciesReady ? main() : null);
