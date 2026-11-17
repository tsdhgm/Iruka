# Environment for building and running Iruka on Windows. Dot-source it in every PowerShell session
# that builds or runs Iruka (after scripts\windows-deps.ps1 has built the libraries):
#   . scripts\windows-env.ps1
# It works from anywhere: every path is relative to this clone, nothing per machine or per user.
$irukaVcpkg = Join-Path (Split-Path $PSScriptRoot) "vcpkg_installed\x64-windows"
if (-not (Test-Path "$irukaVcpkg\bin\freerdp3.dll")) {
    Write-Warning "FreeRDP not found in $irukaVcpkg; run scripts\windows-deps.ps1 first"
}

# cargo is normally on the user's Path already; adding it covers a shell opened before rustup ran.
# vcpkg's bin is how iruka.exe finds freerdp3.dll and the OpenSSL / zlib / cJSON DLLs at run time.
foreach ($dir in "$irukaVcpkg\tools\pkgconf", "$irukaVcpkg\bin", "$env:USERPROFILE\.cargo\bin") {
    if (($env:Path -split ";") -notcontains $dir) { $env:Path = "$dir;" + $env:Path }
}
$env:PKG_CONFIG = "$irukaVcpkg\tools\pkgconf\pkgconf.exe"   # build: build.rs finds FreeRDP through pkg-config
$env:PKG_CONFIG_PATH = "$irukaVcpkg\lib\pkgconfig"
$env:OPENSSL_MODULES = "$irukaVcpkg\bin"                    # run: OpenSSL legacy provider for NTLM (KNOWN_ISSUES.md)
Remove-Variable dir, irukaVcpkg -ErrorAction SilentlyContinue
