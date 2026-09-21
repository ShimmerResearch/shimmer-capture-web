# Vendored `shimmer-web-sdk`

The build output of [`shimmer-web-sdk`](https://github.com/ShimmerResearch/shimmer-web-sdk),
checked in so the GitHub Pages site works with no build step. The page and every
module under `common/` imports the SDK from here:

```js
// from the page, at the repository root
import { Shimmer3RClient } from "./vendor/shimmer-web-sdk.esm.js";
// from a module in common/
import { Shimmer3RClient } from "../vendor/shimmer-web-sdk.esm.js";
```

Seven artifacts, copied byte for byte from the SDK's `dist/`:
`shimmer-web-sdk.{esm.js,esm.js.map,cjs,cjs.map,umd.js,umd.js.map,d.ts}`.
The page loads the ESM bundle; the others are kept so the set matches a release
and a source map resolves when someone opens the devtools on a live page.

## One copy, and the verification pass enforces it

Two module instances means two class identities, and `client.connect()` does
`if (t instanceof WebBluetoothTransport) this.device = t.device`, which then
silently stops matching. Nothing throws; one `instanceof` just goes quiet.

`common/dev/verify.mjs` resolves every `shimmer-web-sdk` import in the page and
in `common/` and fails if one lands anywhere but this folder — doc-comment
examples included, since those are what the next module copies from.

This page used to live in
[`webBLEDemos`](https://github.com/ShimmerResearch/webBLEDemos), where the SDK
is deliberately vendored **twice**: the Chrome extension there has to carry its
own copy, because only its folder is packed for the store and a symlink would
not survive packing. That second copy stayed behind. If you are porting a change
between the two repositories, that is the difference to watch.

## Updating

From the repository root, with a local SDK checkout beside it:

```powershell
powershell -ExecutionPolicy Bypass -File .\update-local-sdk.ps1 -SdkRepoPath "C:\path\to\shimmer-web-sdk"
```

`sdk-source.json` selects which SDK source is built or copied, and the sync
script stamps the built version back into it. Do not edit these files by hand
and do not run prettier over them — they are upstream output, and
`.prettierignore` covers the directory for that reason.

`C:\dev\web\sync-all-vendors.ps1` re-vendors every consumer of the SDK in one
pass, by delegating to each repository's own `sync-local-sdk.ps1`. Prefer it
over running this repository's script alone, so the copies here, in
`verisense-device-console` and in `webBLEDemos` cannot drift apart.
