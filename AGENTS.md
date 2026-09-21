# shimmer-capture-web

Shimmer Capture: one static page that configures, streams, plots and records a single
Shimmer3R from a browser. No native app, no build step, no bundler, no `npm install` —
the browser loads what is checked in. Published to GitHub Pages at
`shimmerresearch.github.io/shimmer-capture-web/`.

## Layout

`index.html` is the whole page and sits at the repository root, so it is the site root.
`common/` is the UI library behind it — framework-free ES modules and one stylesheet,
one module per panel. `vendor/` is the vendored SDK build.

The page imports as `./common/x.js` and `./vendor/shimmer-web-sdk.esm.js`; modules in
`common/` import each other as `./x.js` and reach the SDK at `../vendor/…`. Write the
leading `./` — a bare `common/x.js` is a bare specifier and the browser goes looking
for an import map.

## The SDK is vendored, never hand-copied

`vendor/` holds a build of [`shimmer-web-sdk`](https://github.com/ShimmerResearch/shimmer-web-sdk).
Update it with the scripts, which stamp `sdk-source.json`:

```
./sync-local-sdk.ps1      # sync only
./update-local-sdk.ps1    # build the SDK first, then sync
```

`C:\dev\web\sync-all-vendors.ps1` does every consumer repo in one pass and is the
better habit — the same bundle is vendored into `verisense-device-console` and
`webBLEDemos`, and they are not allowed to drift.

## Verify before you push

`common/dev/verify.mjs` drives the real page in a real browser over CDP against the
`?mock=1` transport — around 290 checks. It runs in CI on every pull request and on
main, and it gates on **change**: `common/dev/verify-known-failures.json` is empty and
is meant to stay that way. A failure not in that list fails the build, and a listed
check that starts passing fails it too.

```bash
npx http-server . -p 8129 -c-1
chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<scratch dir>
node common/dev/verify.mjs 9333
```

Adding a panel means adding its busy flag to the refusal-text matrix in that file, and
adding an SDK importer means adding it to `SDK_CONSUMERS`.

## Requirements to keep stated on the page

Shimmer3R, firmware ≥ v1.0.22, Chrome/Edge — Web Bluetooth for BLE, Web Serial for
Classic Bluetooth and USB, and a secure origin (`https://` or `localhost`).

## Formatting

`html-format.yml` runs prettier 3.3.3 over `**/*.html` only and auto-commits. It does
not touch `.js`, `.css` or `.md` — format those yourself, with that exact version:

```bash
npx --yes prettier@3.3.3 --write "common/**/*.{js,css,md}"
```

Do not run prettier across the whole repo from a Windows checkout: CRLF here makes
`--list-different "**/*.html"` flag files CI sees as clean.

## Lineage

This page lived in [`webBLEDemos`](https://github.com/ShimmerResearch/webBLEDemos)
until it split out, and `…/webBLEDemos/ShimmerCapture/` now redirects here. `common/`
came with it — no other demo imported it. The other demos and the Chrome extension
stayed behind, which is why `sync-local-sdk.ps1` has one vendor target here and two
there. A fix to `common/` no longer reaches anything in webBLEDemos.
