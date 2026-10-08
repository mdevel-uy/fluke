param(
    [string]$Repo = (Join-Path $PSScriptRoot '../..'),
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'fluke-console'),
    [switch]$Here,
    [switch]$Setup,
    [ValidateSet('', 'en', 'es')][string]$Language = ''
)

$ErrorActionPreference = 'Stop'
$binary = Join-Path $PSScriptRoot 'fluke-console.exe'
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw 'Falta fluke-console.exe. Compilá el módulo Go antes de abrirlo.'
}
$repoPath = (Resolve-Path -LiteralPath $Repo).Path
$appArguments = @('--repo', $repoPath, '--state-dir', $StateDir)
if ($Setup) { $appArguments += '--setup' }
if ($Language) { $appArguments += @('--lang', $Language) }
if ($Here -or -not (Get-Command wt.exe -ErrorAction SilentlyContinue)) {
    & $binary @appArguments
    exit $LASTEXITCODE
}

# EncodedCommand avoids Windows Terminal reinterpreting spaces/backslashes in
# executable/repo paths. Only this child receives the console environment.
$quote = { param($value) "'" + $value.Replace("'", "''") + "'" }
$command = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); " +
    "Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue; " +
    "try { `$Host.UI.RawUI.SetWindowSize([System.Management.Automation.Host.Size]::new(140, 40)) } catch {}; " +
    '& ' + (& $quote $binary) + ' ' + (($appArguments | ForEach-Object { & $quote $_ }) -join ' ')
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
Start-Process -WindowStyle Normal -FilePath 'wt.exe' -ArgumentList @('--window', 'new', 'new-tab', '--title', '"Fluke / Your project, in motion"', 'powershell.exe', '-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', $encoded)
