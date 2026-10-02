<#
.SYNOPSIS
    Configures the GitHub repository for SignPath code signing.

.DESCRIPTION
    Stores the SignPath API token as a repository secret and the organization,
    project and signing-policy identifiers as repository variables, using the
    authenticated GitHub CLI. Run this once, after the SignPath project exists
    (see docs/signing.md).

.EXAMPLE
    pwsh -NoProfile -File scripts/setup-signing.ps1 -ApiToken '<token>' -OrganizationId '<org id>' -ProjectSlug 'hermes-manager' -SigningPolicySlug 'release-signing'
#>
[CmdletBinding()]
param(
    [string] $ApiToken,
    [string] $OrganizationId,
    [string] $ProjectSlug = 'hermes-manager',
    [string] $SigningPolicySlug = 'release-signing',
    [string] $ArtifactConfigSlug = '',
    [string] $Repository = 'LoopyLuci/Hermes-Manager'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'the GitHub CLI (gh) is required'
}

$repo = gh repo view $Repository --json name --jq '.name' 2>$null
if ($LASTEXITCODE -ne 0) { throw "cannot reach $Repository with gh (run 'gh auth login')" }

if (-not $ApiToken) {
    $ApiToken = Read-Host -Prompt 'SignPath API token (submitted as the SIGNPATH_API_TOKEN secret)' -MaskInput
}
if (-not $OrganizationId) {
    $OrganizationId = Read-Host -Prompt 'SignPath organization id'
}

Write-Host "-> secret SIGNPATH_API_TOKEN on $Repository" -ForegroundColor Cyan
$ApiToken | gh secret set SIGNPATH_API_TOKEN --repo $Repository

$variables = @{
    SIGNPATH_ORGANIZATION_ID        = $OrganizationId
    SIGNPATH_PROJECT_SLUG           = $ProjectSlug
    SIGNPATH_SIGNING_POLICY_SLUG    = $SigningPolicySlug
}
if ($ArtifactConfigSlug) { $variables['SIGNPATH_ARTIFACT_CONFIG_SLUG'] = $ArtifactConfigSlug }

foreach ($entry in $variables.GetEnumerator()) {
    Write-Host "-> variable $($entry.Key) = $($entry.Value)" -ForegroundColor Cyan
    $entry.Value | gh variable set $entry.Key --body $entry.Value --repo $Repository
}

Write-Host 'signing configured. Next:' -ForegroundColor Green
Write-Host "  1. confirm the SignPath GitHub App is installed on $Repository"
Write-Host '  2. push a version tag: git tag v0.1.0; git push origin v0.1.0'
Write-Host '  3. approve the two signing requests (binaries, then installer) in SignPath'
Write-Host ''
Write-Host 'dry run the release pipeline without publishing:'
Write-Host "  gh workflow run release.yml -f tag=$(git describe --tags --abbrev=0 2>$null; if (-not $?) { 'v0.1.0' })"