// Settings for the hosted site and the plain repo page (npm run serve). The artifact build doesn't use this file:
// scripts/build.mjs writes its own settings (target "artifact": no tiles, no ads, no service worker), and
// `npm run build:site` copies this file with `sw: true` and the versioned data folder. See DEPLOY.md.
window.ELEVATION_CONFIG = Object.assign({
  target: "site",
  data: "data/",
  sw: false,
  // Map tiles for the "Map" layer. OpenStreetMap's standard tiles are free for light use under the tile usage
  // policy (https://operations.osmfoundation.org/policies/tiles/): visible credit, the browser's normal Referer,
  // no prefetching. Heavy traffic should move to a tile provider or self-hosted tiles: change `url` here.
  // maxZoom 11 keeps short routes sharp while summit heights stay off the map (they would give answers away).
  tiles: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 11,
    label: "© OpenStreetMap",
    credit: 'Map © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
  },
  // Ad slots: reserved space only, no provider is loaded (see ADS.md). Off until the owner turns them on.
  ads: { enabled: false, slots: { "below-game": true, result: true } },
}, window.ELEVATION_CONFIG);
