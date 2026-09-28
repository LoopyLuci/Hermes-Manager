Set-StrictMode -Version Latest

function Get-HermesHome {
    if ($env:HERMES_HOME -and (Test-Path -LiteralPath $env:HERMES_HOME)) { return $env:HERMES_HOME }
    foreach ($base in @($env:LOCALAPPDATA, $env:APPDATA)) {
        if (-not $base) { continue }
        $candidate = Join-Path $base 'hermes'
        if ((Test-Path -LiteralPath (Join-Path $candidate 'hermes-agent')) -or (Test-Path -LiteralPath (Join-Path $candidate 'logs'))) {
            return $candidate
        }
    }
    return $null
}

function Get-HermesManagerRuntime {
    $hermesHome = Get-HermesHome
    if ($hermesHome) {
        $venvs = Get-ChildItem -Path (Join-Path $hermesHome 'installs') -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem -Path (Join-Path $_.FullName 'environments') -Directory -ErrorAction SilentlyContinue } |
            ForEach-Object { Join-Path $_.FullName 'venv\Scripts\python.exe' } |
            Where-Object { Test-Path -LiteralPath $_ }
        if ($venvs) { return [pscustomobject]@{ Path = @($venvs)[0]; Kind = 'hermes-venv'; Home = $hermesHome } }

        $store = Get-ChildItem -Path (Join-Path $hermesHome 'tools') -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'python-*' } |
            ForEach-Object { Join-Path $_.FullName 'python.exe' } |
            Where-Object { Test-Path -LiteralPath $_ }
        if ($store) { return [pscustomobject]@{ Path = @($store)[0]; Kind = 'store'; Home = $hermesHome } }
    }

    $onPath = Get-Command python -ErrorAction SilentlyContinue
    if ($onPath) { return [pscustomobject]@{ Path = $onPath.Source; Kind = 'unknown'; Home = $hermesHome } }

    throw 'No Python interpreter found for Hermes Manager tests.'
}

function Get-PythonWithPip {
    param($FallbackRuntime)
    if ($FallbackRuntime.Path) {
        & $FallbackRuntime.Path -m pip --version 2>$null
        if ($LASTEXITCODE -eq 0) { return $FallbackRuntime }
    }
    $hermesHome = Get-HermesHome
    if ($hermesHome) {
        $store = Get-ChildItem -Path (Join-Path $hermesHome 'tools') -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'python-*' } |
            ForEach-Object { Join-Path $_.FullName 'python.exe' } |
            Where-Object { Test-Path -LiteralPath $_ }
        if ($store) { return [pscustomobject]@{ Path = @($store)[0]; Kind = 'store'; Home = $hermesHome } }
    }
    $onPath = Get-Command python -ErrorAction SilentlyContinue
    if ($onPath) { return [pscustomobject]@{ Path = $onPath.Source; Kind = 'unknown'; Home = $null } }
    throw 'No Python with pip found for Hermes Manager tests.'
}

function Get-BridgeSourcePath {
    $root = Split-Path -Parent $PSScriptRoot
    return (Join-Path $root 'src\bridge')
}

function Use-PytestRuntime {
    param(
        [Parameter(Mandatory)] $Runtime,
        [Parameter(Mandatory)] [string] $ProjectRoot
    )
    $overlay = Join-Path $ProjectRoot '.pytest-deps'
    if (-not (Test-Path -LiteralPath (Join-Path $overlay 'pytest'))) {
        $pipPython = Get-PythonWithPip -FallbackRuntime $Runtime
        Write-Host "-> installing pytest deps into .pytest-deps with $($pipPython.Path)" -ForegroundColor DarkGray
        & $pipPython.Path -m pip install --quiet --target $overlay pytest pytest-asyncio fastapi uvicorn pydantic starlette httpx
        if ($LASTEXITCODE -ne 0) { throw 'failed to install pytest deps' }
    }
    $env:PYTHONPATH = (@($overlay, $env:PYTHONPATH) | Where-Object { $_ }) -join ';'
    return (Get-PythonWithPip -FallbackRuntime $Runtime)
}
