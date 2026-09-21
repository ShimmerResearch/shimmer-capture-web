param(
    [string]$SdkRepoPath = "..\shimmer-web-sdk"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)
# One target. `vendor` is the copy the page and every module under common/
# imports, and the only one in this repository.
#
# In webBLEDemos this was a list of two, because the Chrome extension there
# has to carry its own copy -- only that folder is packed for the store. The
# extension stayed behind when this page split out. If you are porting a
# change between the two scripts, that missing second target is the only
# difference that matters.
$vendorTargets = @(
    (Join-Path $repoRoot "vendor")
)
$sdkSourceConfigPath = Join-Path $repoRoot "sdk-source.json"

if (-not (Test-Path $sdkSourceConfigPath)) {
    throw "SDK source config not found: $sdkSourceConfigPath"
}

$sourceConfig = Get-Content $sdkSourceConfigPath -Raw | ConvertFrom-Json
$sourceMode = $sourceConfig.sourceMode

if (-not $sourceMode) {
    throw "sdk-source.json is missing required field: sourceMode"
}

if ($sourceMode -notin @("local-repo", "local-version", "local-latest")) {
    throw "Unsupported sourceMode '$sourceMode' in sdk-source.json. Supported: local-repo, local-version, local-latest"
}

foreach ($vendorDir in $vendorTargets) {
    if (-not (Test-Path $vendorDir)) {
        New-Item -ItemType Directory -Path $vendorDir -Force | Out-Null
    }
}

$files = @(
    "shimmer-web-sdk.esm.js",
    "shimmer-web-sdk.esm.js.map",
    "shimmer-web-sdk.cjs",
    "shimmer-web-sdk.cjs.map",
    "shimmer-web-sdk.umd.js",
    "shimmer-web-sdk.umd.js.map",
    "shimmer-web-sdk.d.ts"
)

$sdkRoot = Resolve-Path (Join-Path $repoRoot $SdkRepoPath)
$distDir = Join-Path $sdkRoot "dist"

if (-not (Test-Path $distDir)) {
    throw "SDK dist folder not found: $distDir"
}

foreach ($name in $files) {
    $src = Join-Path $distDir $name

    if (-not (Test-Path $src)) {
        throw "Missing SDK artifact: $src"
    }

    foreach ($vendorDir in $vendorTargets) {
        $dst = Join-Path $vendorDir $name
        Copy-Item -Path $src -Destination $dst -Force
    }
}

# In local-repo mode the version field is provenance output, not input: stamp
# the built SDK's package.json version back into sdk-source.json so the file
# cannot claim a version the vendored bundles are not. It said 0.3.0 while
# vendor/ held a 0.4.x build, because this script read sdk-source.json for its
# sourceMode and never wrote it back - though AGENTS.md here and in the SDK
# both say the sync scripts stamp it. verisense-device-console's copy of this
# script has always stamped; this is that block, ported.
# (In local-version mode the field is the user's selector, so it is left alone;
# local-latest builds a tag that may not match the working copy's package.json,
# so it is not stamped either.)
if ($sourceMode -eq "local-repo") {
    $sdkPackageJson = Get-Content (Join-Path $sdkRoot "package.json") -Raw | ConvertFrom-Json
    $sdkVersion = $sdkPackageJson.version
    if ($sdkVersion -and $sourceConfig.version -ne $sdkVersion) {
        $sourceConfig | Add-Member -NotePropertyName version -NotePropertyValue $sdkVersion -Force
        $json = ($sourceConfig | ConvertTo-Json) -replace '":  ', '": ' -replace "`r`n", "`n"
        [System.IO.File]::WriteAllText($sdkSourceConfigPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "Stamped sdk-source.json version: $sdkVersion"
    }
}

$targetList = $vendorTargets -join ", "
Write-Host "Synced SDK artifacts from '$distDir' to [$targetList] (sourceMode=$sourceMode)."