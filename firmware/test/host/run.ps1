# Builds and runs the host tests (no board needed). Windows PowerShell 5.1+:
#
#   powershell -ExecutionPolicy Bypass -File firmware\test\host\run.ps1
#   powershell -ExecutionPolicy Bypass -File firmware\test\host\run.ps1 -v   # every per-second line
#
# Uses $env:CC, else cc / gcc / clang from PATH. With none of those, the first
# run installs Zig's C compiler (pip package "ziglang", ~50 MB) into
# test\host\.venv, which stays local to this folder.
param([switch]$v)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Find-Compiler {
    if ($env:CC) {
        return , ($env:CC -split ' ')
    }
    foreach ($c in 'cc', 'gcc', 'clang') {
        if (Get-Command $c -ErrorAction SilentlyContinue) {
            return , @($c)
        }
    }
    $venv = Join-Path $PSScriptRoot '.venv'
    $py = Join-Path $venv 'Scripts\python.exe'
    if (-not (Test-Path $py)) {
        Write-Host "No C compiler found. Installing Zig's C compiler (pip 'ziglang') into $venv ..."
        & python -m venv $venv
        if ($LASTEXITCODE -ne 0) { throw 'python -m venv failed (is Python 3 installed?)' }
        & $py -m pip install --quiet --disable-pip-version-check ziglang
        if ($LASTEXITCODE -ne 0) { throw 'pip install ziglang failed' }
    }
    return , @($py, '-m', 'ziglang', 'cc')
}

$cc = Find-Compiler
$ccExe = $cc[0]
$ccArgs = @()
if ($cc.Count -gt 1) {
    $ccArgs = $cc[1..($cc.Count - 1)]
}
$flags = @('-std=c11', '-O1', '-Wall', '-Werror', '-Wno-unused-parameter', '-Wno-unused-function',
           '-I', 'stubs', '-I', 'support', '-I', '../../src')
$src = '../../src'

$tests = [ordered]@{
    'test_csi_window' = @("$src/csi_window.c")
    'test_estimator'  = @("$src/estimator.c")
    'test_commands'   = @("$src/commands.c", "$src/estimator.c")
    'test_pipeline'   = @("$src/csi_window.c", "$src/estimator.c")
}

# Native tools write warnings to stderr; judge them by exit code only
$ErrorActionPreference = 'Continue'

foreach ($name in $tests.Keys) {
    Write-Host "building $name"
    & $ccExe @ccArgs @flags "$name.c" 'support/host_stubs.c' @($tests[$name]) '-lm' '-o' "$name.exe"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "BUILD FAILED: $name" -ForegroundColor Red
        exit 1
    }
}

$runArgs = @()
if ($v) {
    $runArgs += '-v'
}
$failed = 0
foreach ($name in $tests.Keys) {
    Write-Host "########## $name"
    & ".\$name.exe" @runArgs
    if ($LASTEXITCODE -ne 0) {
        $failed++
    }
}

Write-Host ''
if ($failed -eq 0) {
    Write-Host 'ALL HOST TESTS PASSED' -ForegroundColor Green
} else {
    Write-Host "$failed TEST PROGRAM(S) FAILED" -ForegroundColor Red
}
exit $failed
