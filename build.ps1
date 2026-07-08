# Packages the plugin into build\zoro.xpi (a zip with manifest.json + bootstrap.js at the root).
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$build = Join-Path $root "build"
$zip = Join-Path $build "zoro.zip"
$xpi = Join-Path $build "zoro.xpi"

if (-not (Test-Path $build)) { New-Item -ItemType Directory -Path $build | Out-Null }
if (Test-Path $zip) { Remove-Item $zip -Force }
if (Test-Path $xpi) { Remove-Item $xpi -Force }

# Files that must sit at the ROOT of the archive.
$files = @("manifest.json", "bootstrap.js") | ForEach-Object { Join-Path $root $_ }

# Compress-Archive only writes .zip, so build a zip then rename to .xpi (same format).
Compress-Archive -Path $files -DestinationPath $zip -Force
Rename-Item -Path $zip -NewName "zoro.xpi" -Force
Write-Host "Built $xpi"
