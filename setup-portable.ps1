# One-time USB prep: download official Node LTS into runtime\ and npm install --omit=dev.
# Invoked by setup-portable.bat (ExecutionPolicy Bypass). Re-run with -Force to replace Node.

param([switch]$Force)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
$Runtime = Join-Path $Root 'runtime'

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$fileTag = "$arch-zip"

function Get-LtsRelease {
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
    $release = $index |
        Where-Object { $_.lts -and $_.files -contains $fileTag } |
        Select-Object -First 1
    if (-not $release) {
        throw "No Node LTS zip found for $arch. Check https://nodejs.org/dist/"
    }
    return $release
}

function Install-PortableNode {
    Write-Host "Looking up current Node LTS ($arch)..."
    $release = Get-LtsRelease
    $ver = $release.version
    $zipName = "node-$ver-$arch.zip"
    $zipUrl = "https://nodejs.org/dist/$ver/$zipName"
    $sumUrl = "https://nodejs.org/dist/$ver/SHASUMS256.txt"

    $temp = Join-Path $env:TEMP "snuggpro-portable-node"
    if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
    New-Item -ItemType Directory -Path $temp | Out-Null
    $zipPath = Join-Path $temp $zipName

    Write-Host "Downloading $zipUrl"
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing

    Write-Host "Verifying SHA256..."
    $sums = Invoke-WebRequest -Uri $sumUrl -UseBasicParsing
    $line = ($sums.Content -split "`n") | Where-Object { $_.TrimEnd() -like "* $zipName" } | Select-Object -First 1
    if (-not $line) { throw "No SHA256 line for $zipName in SHASUMS256.txt" }
    $expected = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "SHA256 mismatch for $zipName`n  expected $expected`n  got      $actual"
    }

    Write-Host "Extracting to runtime\..."
    Expand-Archive -Path $zipPath -DestinationPath $temp -Force
    $inner = Get-ChildItem -Path $temp -Directory | Select-Object -First 1
    if (-not $inner -or -not (Test-Path (Join-Path $inner.FullName 'node.exe'))) {
        throw 'Extracted Node zip did not contain node.exe'
    }
    if (Test-Path $Runtime) { Remove-Item $Runtime -Recurse -Force }
    Move-Item $inner.FullName $Runtime
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Portable Node $ver installed."
}

$nodeExe = Join-Path $Runtime 'node.exe'
if ($Force -or -not (Test-Path $nodeExe)) {
    Install-PortableNode
} else {
    Write-Host "Portable Node already present ($(& $nodeExe --version)). Pass -Force to replace it."
}

$npm = Join-Path $Runtime 'npm.cmd'
if (-not (Test-Path $npm)) { throw 'runtime\npm.cmd is missing. Re-run with -Force.' }

Write-Host 'Installing dependencies onto this folder (production only)...'
$env:PATH = "$Runtime;$env:PATH"
& $npm install --omit=dev --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }

if (-not (Test-Path (Join-Path $Root '.env'))) {
    Write-Host ''
    Write-Host 'No .env yet. Copy .env.example to .env and fill in your API keys before starting.'
}

Write-Host ''
Write-Host 'Setup complete. Double-click start-portable.bat to run from this drive.'
Write-Host 'This stick still needs internet (SnuggPro API) and should stay writable (exports).'
Write-Host 'Keep .env off shared/lost sticks — it holds live API keys.'
