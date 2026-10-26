# Portable Windows zip: release iruka.exe + the FreeRDP / OpenSSL DLLs from vcpkg, no installer.
# Run from the repository root after dot-sourcing the environment script (docs/windows-client.md):
#   .\node_modules\.bin\tauri.cmd build --no-bundle
#   powershell -ExecutionPolicy Bypass -File scripts\make-zip.ps1
# The zip lands in release\ (ignored). Unsigned: Smart App Control blocks it (KNOWN_ISSUES.md).
param(
    [string]$Vcpkg = "$env:USERPROFILE\Foundry\vcpkg\installed\x64-windows",
    [string]$OutDir = "release"
)
$ErrorActionPreference = "Stop"

$exe = "src-tauri\target\release\iruka.exe"
if (-not (Test-Path $exe)) { throw "$exe not found; run 'tauri.cmd build --no-bundle' first" }
$version = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
$name = "iruka-$version-windows-x64"
$stage = Join-Path $OutDir $name

# Everything iruka.exe loads from vcpkg; legacy.dll is OpenSSL's legacy provider (NTLM), found
# through OPENSSL_MODULES, which Iruka points at its own folder at startup (src-tauri/src/lib.rs).
$dlls = "freerdp3.dll", "freerdp-client3.dll", "winpr3.dll", "libcrypto-3-x64.dll",
    "libssl-3-x64.dll", "legacy.dll", "z.dll", "cjson.dll"

Write-Host "== Staging $stage"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item $exe $stage
foreach ($d in $dlls) { Copy-Item (Join-Path "$Vcpkg\bin" $d) $stage }
Copy-Item LICENSE (Join-Path $stage "LICENSE.txt")
Copy-Item "$Vcpkg\share\freerdp\copyright" (Join-Path $stage "FreeRDP.copyright.txt")
Copy-Item "$Vcpkg\share\openssl\copyright" (Join-Path $stage "OpenSSL.copyright.txt")

$freerdp = (Get-Item "$Vcpkg\bin\freerdp3.dll").VersionInfo.ProductVersion
$os = (Get-CimInstance Win32_OperatingSystem).Caption
$readme = @"
Iruka $version (Windows x64) - console and remote desktop fleet viewer
https://github.com/tsdhgm/Iruka

Run iruka.exe. No installation or administrator rights are needed; keep the DLLs next to
iruka.exe. WebView2 is required (preinstalled on Windows 11).

This build is not signed:
- SmartScreen may warn about a downloaded zip: choose "More info", then "Run anyway".
- With Smart App Control on (Windows Security > App & browser control), Windows blocks it
  outright and offers no way to run it.

Bundled: FreeRDP $freerdp (Apache-2.0, FreeRDP.copyright.txt) and OpenSSL 3 (Apache-2.0,
OpenSSL.copyright.txt) with zlib and cJSON, built with vcpkg.

Logs: start it from a terminal to see them; set IRUKA_LOG to filter, e.g.
    `$env:IRUKA_LOG = "iruka_mem=debug"; .\iruka.exe

Built on $os, $(Get-Date -Format yyyy-MM-dd).
"@
[IO.File]::WriteAllText((Join-Path $stage "README.txt"), $readme.Replace("`r`n", "`n").Replace("`n", "`r`n"))

Write-Host "== Packing"
$zip = Join-Path $OutDir "$name.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path $stage -DestinationPath $zip
$unpacked = (Get-ChildItem $stage | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("Wrote {0} ({1:N1} MB; {2:N1} MB unpacked)" -f $zip, ((Get-Item $zip).Length / 1MB), $unpacked)
