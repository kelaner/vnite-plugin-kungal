# Pack a Vnite plugin into a .vnpkg (zip with manifest.json at the archive root)
# Usage: powershell -File scripts/pack.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$manifestPath = Join-Path $root 'package.json'
$manifestJson = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
$manifest = $manifestJson | ConvertFrom-Json

$id = $manifest.id
$version = $manifest.version
$main = $manifest.main

if (-not $id -or -not $version -or -not $main) {
  throw 'package.json missing required fields: id / name / version / main'
}
if (-not (Test-Path (Join-Path $root $main))) {
  throw "Main entry not found: $main (run npm run build first)"
}

$distDir = Join-Path $root 'dist'
$tmp = Join-Path $distDir '.temp-package'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

# Keep the archive layout aligned with manifest.main ("dist/index.js")
New-Item -ItemType Directory -Path (Join-Path $tmp 'dist') -Force | Out-Null
Copy-Item (Join-Path $root 'dist\*.js') (Join-Path $tmp 'dist')
if (Test-Path (Join-Path $root 'README.md')) { Copy-Item (Join-Path $root 'README.md') $tmp }
[System.IO.File]::WriteAllText((Join-Path $tmp 'manifest.json'), $manifestJson, $utf8NoBom)

$safeId = ($id -replace '[\\/:*?"<>|\s]', '_')
$out = Join-Path $distDir "$safeId-$version.vnpkg"
if (Test-Path $out) { Remove-Item $out -Force }
Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $out -CompressionLevel Optimal
Remove-Item $tmp -Recurse -Force

$size = [math]::Round((Get-Item $out).Length / 1KB, 2)
Write-Host "Packed: $out ($size KB)"
