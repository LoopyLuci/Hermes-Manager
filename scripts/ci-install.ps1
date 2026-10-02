<#
.SYNOPSIS
    Installs the Python dependencies the bridge needs at runtime.

.DESCRIPTION
    The bridge (FastAPI + uvicorn + yaml) must run on the interpreter that Hermes
    Manager spawns: Hermes's own venv when present, otherwise python on PATH.
    CI sets HM_BRIDGE_PYTHON and runs this before the e2e suite.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')

$runtime = Get-PythonWithPip -FallbackRuntime (Get-HermesManagerRuntime)
Write-Host "installing bridge runtime deps with $($runtime.Path)" -ForegroundColor Cyan
& $runtime.Path -m pip install --disable-pip-version-check --quiet fastapi uvicorn pydantic PyYAML
if ($LASTEXITCODE -ne 0) { throw 'failed to install bridge runtime dependencies' }
Write-Host 'bridge runtime deps: OK' -ForegroundColor Green