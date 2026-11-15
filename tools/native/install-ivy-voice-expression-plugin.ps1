[CmdletBinding()]
param([switch]$EnableDesktop)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$source = Join-Path $repo 'config/hermes-plugins/stellar-voice-expression'
$profile = 'D:/Hermes/profiles/ivy'
$hermes = 'D:/Hermes/bin/hermes.exe'
$plugins = Join-Path $profile 'plugins'
$target = Join-Path $plugins 'stellar-voice-expression'

if ($EnableDesktop) {
    if (!$env:LOCALAPPDATA -or ![IO.Path]::IsPathRooted($env:LOCALAPPDATA)) {
        throw 'The current user needs a local application-data directory.'
    }
    $cache = Join-Path $env:LOCALAPPDATA 'Stellar/IvyExpression'
    if (!(Test-Path -LiteralPath (Join-Path $cache '.venv/Scripts/python.exe') -PathType Leaf) -or
        !(Test-Path -LiteralPath (Join-Path $cache 'emotion2vec_plus_large/model.pt') -PathType Leaf)) {
        throw 'Run tools/native/setup-expression.py --install before enabling Desktop expression.'
    }
}

if (!(Test-Path -LiteralPath $hermes -PathType Leaf) -or
    !(Test-Path -LiteralPath (Join-Path $profile 'config.yaml') -PathType Leaf)) {
    throw 'The installed Windows Hermes Ivy profile is required.'
}

foreach ($directory in @($profile, $plugins, $target)) {
    if (Test-Path -LiteralPath $directory) {
        $item = Get-Item -LiteralPath $directory
        if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Expected an ordinary directory at $directory."
        }
    }
}

$files = @('__init__.py', 'plugin.yaml')
foreach ($name in $files) {
    if (!(Test-Path -LiteralPath (Join-Path $source $name) -PathType Leaf)) {
        throw "The checkout is missing the plugin file $name."
    }
    $destination = Join-Path $target $name
    if (Test-Path -LiteralPath $destination) {
        $item = Get-Item -LiteralPath $destination
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Expected an ordinary plugin file at $destination."
        }
    }
}

[void][IO.Directory]::CreateDirectory($target)
foreach ($name in $files) {
    $destination = Join-Path $target $name
    $staged = Join-Path $target ([Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::Copy((Join-Path $source $name), $staged)
        if ([IO.File]::Exists($destination)) {
            [IO.File]::Replace($staged, $destination, [NullString]::Value)
        } else {
            [IO.File]::Move($staged, $destination)
        }
    } finally {
        [IO.File]::Delete($staged)
    }
}

$previousHermesHome = [Environment]::GetEnvironmentVariable('HERMES_HOME', 'Process')
try {
    $env:HERMES_HOME = 'D:/Hermes'
    & $hermes -p ivy plugins enable stellar-voice-expression --no-allow-tool-override
    if ($LASTEXITCODE -ne 0) {
        throw 'Hermes did not enable the Ivy voice-expression plugin.'
    }
    & $hermes -p ivy plugins doctor --ci stellar-voice-expression
    if ($LASTEXITCODE -ne 0) {
        throw 'The installed Hermes plugin did not pass its diagnostic.'
    }
} finally {
    [Environment]::SetEnvironmentVariable('HERMES_HOME', $previousHermesHome, 'Process')
}

if ($EnableDesktop) {
    $marker = Join-Path $cache 'enabled'
    if (!(Test-Path -LiteralPath $marker)) {
        $stream = [IO.File]::Open($marker, [IO.FileMode]::CreateNew)
        $stream.Dispose()
    }
    Write-Output 'Voice expression is enabled for the next Stellar Desktop launch.'
}
