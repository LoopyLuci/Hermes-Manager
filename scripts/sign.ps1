<#
.SYNOPSIS
    Signs built artifacts with SignPath (REST API) and replaces them in place.

.DESCRIPTION
    Flow (https://docs.signpath.io/build-system-integration):
      1. POST  /SigningRequests/SubmitWithArtifact   (multipart: projectSlug, signingPolicySlug, artifact)
      2. GET   /SigningRequests/{id}                 (poll until isFinalStatus)
      3. GET   /SigningRequests/{id}/SignedArtifact  (download the signed file)

    The script is deliberately tolerant: with no API token it warns and exits 0
    so unsigned community/local builds keep working. Set -Required to fail
    instead (used by the release workflow once secrets exist).

.EXAMPLE
    pwsh -NoProfile -File scripts/sign.ps1 -Path 'dist/*.exe' -Required
#>
[CmdletBinding()]
param(
    [string] $Path = 'dist/*.exe',
    [string] $OrganizationId = $env:SIGNPATH_ORGANIZATION_ID,
    [string] $ApiToken = $env:SIGNPATH_API_TOKEN,
    [string] $ProjectSlug = $env:SIGNPATH_PROJECT_SLUG,
    [string] $SigningPolicySlug = $env:SIGNPATH_SIGNING_POLICY_SLUG,
    [string] $ArtifactConfigurationSlug = $env:SIGNPATH_ARTIFACT_CONFIG_SLUG,
    [string] $ApiUrl = $(if ($env:SIGNPATH_API_URL) { $env:SIGNPATH_API_URL } else { 'https://app.signpath.io' }),
    [int] $TimeoutSeconds = 900,
    [int] $PollSeconds = 10,
    [switch] $Required,
    [switch] $SkipSignatureValidation
)

$ErrorActionPreference = 'Stop'
$apiBase = "$($ApiUrl.TrimEnd('/'))/Api/v1/$OrganizationId"
$headers = @{ Authorization = "Bearer $ApiToken" }

$targets = @(Get-ChildItem -Path $Path -File -ErrorAction SilentlyContinue)
if ($targets.Count -eq 0) {
    Write-Host "no artifacts matched '$Path'" -ForegroundColor Yellow
    exit 1
}

if (-not $ApiToken -or -not $OrganizationId -or -not $ProjectSlug -or -not $SigningPolicySlug) {
    $message = 'SignPath not configured (SIGNPATH_API_TOKEN / SIGNPATH_ORGANIZATION_ID / SIGNPATH_PROJECT_SLUG / SIGNPATH_SIGNING_POLICY_SLUG)'
    if ($Required) {
        Write-Host $message -ForegroundColor Red
        exit 1
    }
    Write-Host "$message - shipping unsigned artifacts" -ForegroundColor Yellow
    exit 0
}

function Submit-SigningRequest {
    param([string] $Artifact)
    $form = @{
        projectSlug        = $ProjectSlug
        signingPolicySlug  = $SigningPolicySlug
        description        = "Hermes Manager $([System.IO.Path]::GetFileName($Artifact)) from $env:GITHUB_REPOSITORY@$env:GITHUB_SHA"
        artifact           = Get-Item -LiteralPath $Artifact
    }
    if ($ArtifactConfigurationSlug) { $form['artifactConfigurationSlug'] = $ArtifactConfigurationSlug }

    $response = Invoke-WebRequest -Uri "$apiBase/SigningRequests/SubmitWithArtifact" `
        -Method Post -Headers $headers -Form $form -MaximumRedirection 0 `
        -SkipHttpErrorCheck
    if ($response.StatusCode -ne 201) {
        throw "SubmitWithArtifact failed: HTTP $($response.StatusCode) $($response.Content)"
    }
    $location = ($response.Headers | Out-String)
    if ($location -notmatch 'SigningRequests/([0-9a-fA-F\-]{36})') {
        throw "could not parse signing request id from Location header: $location"
    }
    return $Matches[1]
}

function Wait-SigningRequest {
    param([string] $Id)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $response = Invoke-WebRequest -Uri "$apiBase/SigningRequests/$Id" -Headers $headers
        $data = $response.Content | ConvertFrom-Json
        if ($data.isFinalStatus) {
            if ($data.status -ne 'Completed') {
                throw "signing request $Id finished as $($data.status)"
            }
            return $data
        }
        Write-Host "  signing request $Id is $($data.status); waiting..." -ForegroundColor DarkGray
        Start-Sleep -Seconds $PollSeconds
    }
    throw "signing request $Id did not complete within $TimeoutSeconds s"
}

foreach ($target in $targets) {
    Write-Host "-> submitting $($target.Name) ($([math]::Round($target.Length / 1MB, 1)) MB)" -ForegroundColor Cyan
    $id = Submit-SigningRequest -Artifact $target.FullName
    Write-Host "   signing request $id submitted" -ForegroundColor DarkGray
    Wait-SigningRequest -Id $id | Out-Null

    $signed = Join-Path $env:TEMP "$($target.Name).signed"
    Invoke-WebRequest -Uri "$apiBase/SigningRequests/$id/SignedArtifact" -Headers $headers -OutFile $signed
    Move-Item -LiteralPath $signed -Destination $target.FullName -Force
    Write-Host "   signed artifact replaced $($target.Name)" -ForegroundColor Green

    $signature = Get-AuthenticodeSignature -LiteralPath $target.FullName
    if ($signature.Status -ne 'Valid' -and -not $SkipSignatureValidation) {
        throw "Authenticode validation failed for $($target.Name): $($signature.Status)"
    }
    Write-Host "   signature $($signature.Status) / $($signature.SignerCertificate.Subject)" -ForegroundColor Green
}

Write-Host 'sign: OK' -ForegroundColor Green
exit 0