# Gold Intelligence n8n — store owner secrets in .env without echoing them.
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File tools\set-secrets.ps1
# Leave an answer empty to keep the current value. Nothing is printed back.

$ErrorActionPreference = 'Stop'
$envFile = Join-Path (Get-Location) '.env'
if (-not (Test-Path $envFile)) { throw ".env not found in $(Get-Location). Run: node tools/setup-local.js" }

function Read-Secret([string]$prompt) {
  $secure = Read-Host -Prompt $prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Set-EnvValue([string]$key, [string]$value) {
  $lines = Get-Content -LiteralPath $envFile -Encoding UTF8
  $found = $false
  $out = foreach ($l in $lines) {
    if ($l -match "^$key=") { $found = $true; "$key=$value" } else { $l }
  }
  if (-not $found) { $out += "$key=$value" }
  [IO.File]::WriteAllLines($envFile, $out, (New-Object Text.UTF8Encoding($false)))
}

$items = @(
  @{ Key = 'TELEGRAM_BOT_TOKEN'; Prompt = 'TELEGRAM_BOT_TOKEN (hidden, Enter = keep)' },
  @{ Key = 'TELEGRAM_CHAT_ID';   Prompt = 'TELEGRAM_CHAT_ID (hidden, Enter = keep; empty = discover via /start)' },
  @{ Key = 'OPENROUTER_API_KEY'; Prompt = 'OPENROUTER_API_KEY (hidden, Enter = keep)' },
  @{ Key = 'FRED_API_KEY';       Prompt = 'FRED_API_KEY (optional, hidden, Enter = keep)' }
)
foreach ($i in $items) {
  $v = Read-Secret $i.Prompt
  if ($v) { Set-EnvValue $i.Key $v; Write-Host "$($i.Key): CONFIGURED" } else { Write-Host "$($i.Key): unchanged" }
}
Write-Host 'Done. Restart n8n so it picks up the new environment: node tools/n8n-local.js restart'
