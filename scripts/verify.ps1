[CmdletBinding()]
param(
    [switch] $BridgeOnly,
    [switch] $RendererOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

. (Join-Path $PSScriptRoot 'runtime.ps1')

$failures = @()

if (-not $RendererOnly) {
    Write-Host '== bridge tests ==' -ForegroundColor Cyan
    $runtime = Get-HermesManagerRuntime
    $runtime = Use-PytestRuntime -Runtime $runtime -ProjectRoot $root
    Write-Host "python: $($runtime.Path) ($($runtime.Kind))" -ForegroundColor DarkGray
    $env:PYTHONPATH = (@((Get-BridgeSourcePath), $env:PYTHONPATH) | Where-Object { $_ }) -join ';'
    & $runtime.Path -m pytest tests/bridge -q
    if ($LASTEXITCODE -ne 0) { $failures += 'bridge tests' }
}

if (-not $BridgeOnly) {
    Write-Host '== typecheck ==' -ForegroundColor Cyan
    npm run typecheck --silent
    if ($LASTEXITCODE -ne 0) { $failures += 'typecheck' }

    Write-Host '== renderer tests ==' -ForegroundColor Cyan
    npm run test:renderer --silent
    if ($LASTEXITCODE -ne 0) { $failures += 'renderer tests' }
}

if ($failures.Count -gt 0) {
    Write-Host "FAILED: $($failures -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host 'verify: OK' -ForegroundColor Green
