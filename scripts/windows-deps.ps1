# Builds the C libraries Iruka needs on Windows (FreeRDP 3, OpenSSL, zlib, cJSON, pkgconf) with
# vcpkg in manifest mode: vcpkg.json at the repository root lists them and pins their versions,
# and they land in vcpkg_installed\x64-windows\ inside the clone (ignored by git).
#   powershell -ExecutionPolicy Bypass -File scripts\windows-deps.ps1
# About 10-20 minutes the first time; later runs only check. See docs/windows-client.md.
#
# Which vcpkg runs, first match wins:
#   -Vcpkg <path to vcpkg.exe>
#   $env:VCPKG_ROOT\vcpkg.exe   (your own clone of microsoft/vcpkg, or a Developer PowerShell)
#   the vcpkg that comes with Visual Studio ("vcpkg package manager", part of the C++ workload)
param([string]$Vcpkg = "")
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot

if (-not $Vcpkg -and $env:VCPKG_ROOT -and (Test-Path "$env:VCPKG_ROOT\vcpkg.exe")) {
    $Vcpkg = "$env:VCPKG_ROOT\vcpkg.exe"
}
if (-not $Vcpkg) {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $vs = & $vswhere -latest -prerelease -products * -requires Microsoft.VisualStudio.Component.Vcpkg -property installationPath
        if ($vs -and (Test-Path "$vs\VC\vcpkg\vcpkg.exe")) { $Vcpkg = "$vs\VC\vcpkg\vcpkg.exe" }
    }
}
if (-not $Vcpkg) {
    throw ("No vcpkg found. Either add 'vcpkg package manager' to Visual Studio (Visual Studio Installer -> " +
        "Modify -> Individual components), or clone https://github.com/microsoft/vcpkg, run its " +
        "bootstrap-vcpkg.bat and set VCPKG_ROOT to that folder.")
}

Write-Host "== Using $Vcpkg"
Push-Location $root
try {
    & $Vcpkg install --triplet x64-windows --disable-metrics
    if ($LASTEXITCODE -ne 0) { throw "vcpkg install failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
Write-Host "== Done: $root\vcpkg_installed\x64-windows. Next: . scripts\windows-env.ps1"
