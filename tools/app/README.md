# North Wildwood application sources

The November 1 follow-up uses the exact function inverses in
`north-wildwood-20261101-review-fixes.json`. It covers drawer section scrolling,
obsolete requests after Reload, and per-zone alert outage/expiry handling.
Every previous fixture remains pinned; the new layer restores full original
file hashes before the earlier audits. See `docs/2026-11-01-review-fixes.md`.

`index.template.html` owns the unchanged HTML controls and layout. The manifest
records each original inline block, its attributes and its source files.

Edit the source files here, then run:

```sh
node tools/build_north_wildwood_app.mjs
node tools/build_north_wildwood_app.mjs --check
node tools/test_north_wildwood_refactor_parity.mjs
```

Styles retain their original cascade order and compile into five bundles,
separated wherever an existing external stylesheet or script intervened. No
selectors, declarations, breakpoints or override precedence were changed by the
extraction. Individual style sources remain separate so future changes can be
reviewed against the original behavior.

The 29 runtime domain files compile into one classic script. They share the
original lexical scope intentionally: splitting them into independently executed
scripts would change hoisting and microtask timing. Other presentation and
integration controllers keep their original execution positions and attributes.
Generated browser assets live in `assets/app` and `assets/styles`; the publisher
already excludes `tools`, so authoring sources are not uploaded.

Source-level regression tests use `tools/app_source.mjs` to reconstruct an
inline document from the built files. The independent parity test
checks pinned baseline hashes and every output, while browser tests exercise the
real external-script and stylesheet loading path. Never edit generated files or
relax the parity fixture to conceal a behavior change.

The sole audited JavaScript exception is month-label idempotence in
`runtime/22-calendar-and-modes.js`: an unchanged month label keeps its existing
Text node so an asynchronous archive refresh cannot invalidate WebKit's held
mouse click. The visible text, CSS and HTML remain unchanged. The parity checker
requires the exact fixed snippet once in `script-004` and its authoring source,
then reverses that one snippet only while verifying the original script and
whole-document hashes. The original baseline fixture is preserved. Generated
outputs and syntax are still checked against the actual fixed code. Running the
parity test with `--self-test` also proves that removing the guard, changing
adjacent code or duplicating the exception is rejected.

The external export preview also defers its final canvas/ready update until an
active pointer gesture has finished. This prevents its existing loading caption
from moving the format controls under a held pointer. Its CSS, markup, labels
and final layout are unchanged: the three UI-producing functions are separately
pinned to upstream `cd99390` in `north-wildwood-export-preview-ui.json`. The only
HTML dependency change is that controller's cache version. The parity check
reverses that exact cache key for the original whole-document hash and rejects
preview CSS/markup changes. A real-browser test completes an actual capture
during a held gesture; unit cases cover cancellation, closure and download
handoff so waiting previews cannot deadlock the exporter.

The municipal boundary is seeded synchronously from the exact committed
`Boundaries/North Wildwood.geojson` before map construction. Startup reuses that
geometry without a second network request or late outline replacement. The
initial camera retains its configured extent independently of boundary loading,
including on narrow screens. If no
valid polygon is available, the map shows neither a fabricated rectangular town
outline nor a world-only gray mask, and its boundary request can be retried.
`test_north_wildwood_boundary_startup.mjs` exercises those startup and recovery
cases. The separately pinned boundary-startup audit reverses only the eight named
functions, new seed helper and exact geometry assignment for original source
parity; the original refactor fixture, UI, CSS and scientific behavior remain
unchanged.

Desktop panes use their finished widths and positioning in the initial
stylesheet, and forecast labels are already final in the template. The late
presentation controller no longer needs to shrink the visible pane or replace
its heading during startup. The pane-startup browser regression holds that
controller request while checking the first painted cards, then releases it
and verifies stable widths, labels and card placement. Timeline-aware scrolling
still reserves space for the actual timestamp on short windows. A separately
pinned pane audit covers only this CSS insertion and the three initial labels.

The remaining startup presentation also begins with its finished static markup:
the unused town logo is omitted, address controls use the configured town copy,
and layer order and the play icon match the final controller. Initial CSS uses
the same title/navigation lane and reserves the responsive top-flood list only
until real rows arrive. Both panes initially reserve the same timestamp/dock
clearance as the finished controller, with the same scrollable clipping. A
neutral, hidden timestamp uses the real text classes
for its natural footprint; actual forecast metadata replaces it before reveal.
Missing-data timestamps remain hidden without inventing a forecast. The short
mobile navigation media query is equivalent to its former late class gate.
`north-wildwood-ui-startup.json` pins only these exact CSS/template fragments,
with all earlier audit fixtures and scientific logic unchanged.
The top-flood disclosure is created with its final plus/label spans and existing
idempotence marker, so the controller does not replace a visible SVG later. Its
single presentation markup statement has its own exact runtime inverse audit;
the surrounding history, event selection and scientific logic remain pinned.

The 2D/3D navigation pill keeps its solid surface during selection, hover and
renderer startup. Its selected blue is the opaque composite of the previous
16%-alpha accent over the normal navy, including the shared zoom-hover style.
The existing busy cursor and accessible state remain, while the view button's
opacity stays at 1. `north-wildwood-view-pill-surface.json` audits only those
two CSS fragments; geometry and renderer behavior are unchanged.

The original ShorelySafe welcome screen is restored through its unchanged
deferred controller and existing loading stylesheet. The overlay owns startup
focus/progress and reveals controls after renderer readiness, with the original
reduced-motion and stalled-request recovery. Stable pane rules remain intact;
only the legacy loader-hiding/early-reveal overrides are removed. The separate
`north-wildwood-loader-restore.json` audit pins those exact lifecycle fragments,
the added script tag and the controller's unchanged content hash.

The common UI font family lives in `assets/north-wildwood-font.css`, loaded as
the first head dependency. Its first cascade layer changes only the family,
including controls and pseudo-element labels; existing sizes, weights, spacing
and line heights remain in their original rules. Parity pins the exact external
stylesheet hash, audits its family-only declarations, and reverses only its exact
head tag for the original document hash. The baseline fixture and all original
source, layout and runtime checks remain unchanged. Mutation checks reject a
missing, moved, duplicated or altered tag and changes to the reviewed stylesheet.

The October 26 code audit fixes have their own exact-fragment inverse fixture,
`north-wildwood-20261026-bug-fixes.json`, based on `de65f0d`. The checker pins the
fixture digest, restores only its reviewed runtime, camera style and template
diffs, and then runs all earlier inverse audits and the original immutable
extraction hashes. No complete runtime or stylesheet is exempted. Mutation
checks reject alterations to the fixes and attempts to broaden this fixture.
Behavior regressions cover stable Top 10 rankings and lazy replay, USGS no-data,
building interaction races and missing elevations, address request recovery,
positional date editing, daylight-saving exports, and archive cancellation.

The October 27 follow-up fixes use a further exact-fragment inverse fixture,
`north-wildwood-20261027-line-fixes.json`, based on `4177f020`. This layer also
verifies each complete restored file hash before applying the unchanged earlier
audits. The welcome controller now executes immediately before the third-party
core scripts so its watchdog can run while parsing waits for a stalled library;
it displays a retry state without releasing unfinished controls. This intentional
dependency-order change supersedes the earlier deferred-controller placement.
See `docs/2026-10-27-line-audit-fixes.md` for the 17 fixes and their regressions.
