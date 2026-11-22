# Client Flood Mapper entry point

The shared North Wildwood mapper assets are pinned by full Git commit and
integrity hash in index.template.html. The release is hosted in the
[Highlands client repository](https://github.com/hondrospj/Highlands-Borough-floodmapper/tree/client-mapper-ui-releases).

Edit the local settings in town-profile.json, then regenerate the entry point.

    node tools/build_north_wildwood_app.mjs
    node tools/build_north_wildwood_app.mjs --check

To update the shared UI, publish one release containing the browser assets,
then update the template's pinned URLs and integrity hashes. Keep data paths
and town settings local to this mapper.
