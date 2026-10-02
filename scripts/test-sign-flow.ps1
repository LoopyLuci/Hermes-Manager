<#
.SYNOPSIS
    Verifies scripts/sign.ps1 against a mock SignPath service.

.DESCRIPTION
    Exercises the full submit -> poll -> download flow without credentials or a
    network call, so the release pipeline's signing step cannot silently rot.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 8799
$work = Join-Path ([System.IO.Path]::GetTempPath()) "signpath-test-$PID"
New-Item -ItemType Directory -Path $work -Force | Out-Null

$mock = Start-Process -FilePath 'node' -ArgumentList @(
    (Join-Path $PSScriptRoot 'mock-signpath.mjs')
) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $work 'mock.out')
Start-Sleep -Seconds 2

try {
    $artifact = Join-Path $work 'HermesManager-test.exe'
    Set-Content -LiteralPath $artifact -Value 'unsigned payload' -Encoding utf8

    & (Join-Path $PSScriptRoot 'sign.ps1') `
        -Path $artifact `
        -ApiUrl "http://127.0.0.1:$port" `
        -OrganizationId 'org-test' `
        -ApiToken 'test-token' `
        -ProjectSlug 'hermes-manager' `
        -SigningPolicySlug 'release-signing' `
        -PollSeconds 1 `
        -TimeoutSeconds 30 `
        -SkipSignatureValidation
    if ($LASTEXITCODE -ne 0) { throw 'sign.ps1 exited non-zero' }

    $content = Get-Content -LiteralPath $artifact -Raw
    if ($content -notmatch 'SIGNED-BY-MOCK') {
        throw "signed artifact was not written back: $content"
    }
    Write-Host '  flow: submit -> poll -> download -> replace OK' -ForegroundColor DarkGray

    # Unconfigured SignPath must warn and leave the file alone.
    $untouched = Join-Path $work 'untouched.exe'
    Set-Content -LiteralPath $untouched -Value 'payload' -Encoding utf8
    & (Join-Path $PSScriptRoot 'sign.ps1') -Path $untouched -ApiUrl "http://127.0.0.1:$port"
    if ((Get-Content -LiteralPath $untouched -Raw).Trim() -ne 'payload') { throw 'unconfigured run modified the artifact' }
    Write-Host '  unconfigured: warns and leaves artifacts untouched OK' -ForegroundColor DarkGray

    # -Required must fail loudly when SignPath is not configured at all.
    & (Join-Path $PSScriptRoot 'sign.ps1') -Path $untouched -Required
    if ($LASTEXITCODE -eq 0) { throw '-Required did not fail without SignPath configuration' }
    Write-Host '  required-without-config: fails as expected OK' -ForegroundColor DarkGray

    Write-Host 'sign flow: OK' -ForegroundColor Green
}
finally {
    if ($mock -and -not $mock.HasExited) { $mock.Kill() }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}