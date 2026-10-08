param(
    [string]$Repo = '',
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
$appArguments = @('--state-dir', $StateDir)
if ($Repo) { $appArguments += @('--repo', (Resolve-Path -LiteralPath $Repo).Path) }
if ($Setup) { $appArguments += '--setup' }
if ($Language) { $appArguments += @('--lang', $Language) }
if ($Here) {
    & $binary @appArguments
    exit $LASTEXITCODE
}

# EncodedCommand preserves spaces and quotes in paths in the new console.
$quote = { param($value) "'" + $value.Replace("'", "''") + "'" }
$command = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); " +
    "`$Host.UI.RawUI.WindowTitle = 'Fluke / Your projects'; " +
    "Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue; " +
    "try { `$Host.UI.RawUI.SetWindowSize([System.Management.Automation.Host.Size]::new(140, 40)) } catch {}; " +
    '& ' + (& $quote $binary) + ' ' + (($appArguments | ForEach-Object { & $quote $_ }) -join ' ')
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
Start-Process -WindowStyle Normal -FilePath 'powershell.exe' -ArgumentList @('-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', $encoded)
