# Third-Party Notices

MGOServer is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).
It stands on the following third-party software.

## Runtime dependencies (npm)

| Package | License | Used for |
|---------|---------|----------|
| [fastify](https://fastify.dev), [@fastify/static](https://github.com/fastify/fastify-static), [@fastify/multipart](https://github.com/fastify/fastify-multipart) | MIT | HTTP server, artifact hosting, chunked uploads |
| [@fastify/proxy-addr](https://github.com/fastify/proxy-addr) (via fastify) | MIT | client-IP resolution under `MGO_TRUST_PROXY` |
| [zod](https://zod.dev) | MIT | job option schemas |
| [yauzl](https://github.com/thejoshwolfe/yauzl) | MIT | streamed, bomb-safe ZIP extraction for OSGB uploads |
| [tree-kill](https://github.com/sapertree/tree-kill) | MIT | killing an `mgo` process tree on cancel/timeout |

`devDependencies`: [playwright](https://playwright.dev) (Apache-2.0) for the page-level
suite, [yazl](https://github.com/thejoshwolfe/yazl) (MIT) to build the test archives.

## Front-end assets served to the browser

| Component | Version | License | Notes |
|-----------|---------|---------|-------|
| [CesiumJS](https://cesium.com/platform/cesiumjs/) | 1.111 | Apache-2.0 | Pinned to match the quantized-mesh decoder calibration in TerrainConverter. `npm run sync:cesium` copies `node_modules/cesium/Build/Cesium` into `public/cesium/` (gitignored); otherwise the viewer loads the same version from the CDN. |
| Esri World Imagery / World Street Map, OpenStreetMap, CARTO, OpenTopoMap tiles | — | see each provider | Optional online basemaps in the viewer HUD, fetched by the browser directly from the tile providers; attribution is rendered automatically and usage remains subject to each provider's policy. |

## The MGO binary

The conversion work happens in `MGOConsole`, built from
[MGO](https://github.com/Johnly1986/MGO) (Apache-2.0), which in turn links Assimp,
meshoptimizer, PROJ, Eigen, GDAL/libtiff, libjpeg/libpng and optionally
OpenSceneGraph — see that repository's `THIRD_PARTY_NOTICES.md` for their licenses.
This service only shells out to that executable and parses its documented
`[Module] Progress: X/Y` / `Done:` stdout protocol.

Product names and trademarks are the property of their respective owners and are used
here for identification purposes only.
