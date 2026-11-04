param(
    [string]$ModelPath = 'D:/Hermes/profiles/ivy/reflex/models/Qwen3-4B-Q4_K_M.gguf',
    [string]$LlamaPath = 'D:/Hermes/tools/llamacpp-cuda-11370-win32-x64/llama-server.exe',
    [switch]$Gpu,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$workspacePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (!(Get-Command cargo -ErrorAction SilentlyContinue) -or !(Get-Command rustup -ErrorAction SilentlyContinue)) {
    $toolchainPath = Join-Path (Split-Path $workspacePath -Parent) '.stellar-toolchains'
    $cargoPath = Join-Path $toolchainPath 'cargo'
    $rustupPath = Join-Path $toolchainPath 'rustup'
    $binaryPath = Join-Path $cargoPath 'bin'
    if (!(Test-Path -LiteralPath (Join-Path $binaryPath 'cargo.exe') -PathType Leaf) -or
        !(Test-Path -LiteralPath (Join-Path $binaryPath 'rustup.exe') -PathType Leaf) -or
        !(Test-Path -LiteralPath $rustupPath -PathType Container)) {
        throw 'The existing Rust toolchain is unavailable. Complete the documented Windows setup first; this launcher installs nothing.'
    }
    $env:CARGO_HOME = $cargoPath
    $env:RUSTUP_HOME = $rustupPath
    $env:PATH = "$binaryPath;$env:PATH"
    Write-Host 'Using the existing Stellar Rust toolchain for this process.'
}
$channel = [regex]::Match((Get-Content -LiteralPath (Join-Path $workspacePath 'rust-toolchain.toml') -Raw), '(?m)^channel\s*=\s*"([^"]+)"')
if (!$channel.Success) { throw 'Cannot read the repository Rust toolchain pin.' }
# `which` checks an installed toolchain; it does not install a missing toolchain.
& rustup which --toolchain $channel.Groups[1].Value cargo | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The pinned Rust toolchain is not installed. No installation was attempted.' }
if (!(Get-Command corepack -ErrorAction SilentlyContinue)) { throw 'Corepack is unavailable. Complete the documented Windows setup first.' }
$expectedHash = '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5'
if (!(Test-Path -LiteralPath $ModelPath -PathType Leaf) -or !(Test-Path -LiteralPath $LlamaPath -PathType Leaf)) {
    throw 'Installed Qwen3-4B model or llama.cpp engine missing. Nothing will be downloaded.'
}
$provenancePath = [IO.Path]::ChangeExtension($ModelPath, 'provenance.json')
$provenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
if ($provenance.source -cne 'Qwen/Qwen3-4B-GGUF' -or
    $provenance.revision -cne 'bc640142c66e1fdd12af0bd68f40445458f3869b' -or
    $provenance.license -cne 'Apache-2.0' -or $provenance.sha256 -cne $expectedHash -or
    (Get-FileHash -LiteralPath $ModelPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash) {
    throw 'The installed model does not match the authorized pinned artifact.'
}
$env:STELLAR_REFLEX_MODEL = (Resolve-Path -LiteralPath $ModelPath).Path
$env:STELLAR_REFLEX_LLAMA = (Resolve-Path -LiteralPath $LlamaPath).Path
$env:STELLAR_REFLEX_GPU_LAYERS = if ($Gpu) { '36' } else { '0' }
Write-Host "Ivy Reflex: Qwen3-4B Q4_K_M, GPU layers $env:STELLAR_REFLEX_GPU_LAYERS. Menu: M > Ivy Reflex."
if (!$Gpu) { Write-Warning 'CPU mode does not meet the instant-action target on the qualified PC. Use -Gpu to explicitly opt into the validated GPU configuration.' }
if ($CheckOnly) { return }
Push-Location -LiteralPath $workspacePath
try {
    & corepack pnpm exec nx run stellar-desktop:native-launch
    if ($LASTEXITCODE -ne 0) { throw "Desktop launch failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
