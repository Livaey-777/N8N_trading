<#
.SYNOPSIS
  One-step import of the 9 Gold Intelligence workflows into the LOCAL n8n (Windows local pilot).
.DESCRIPTION
  Uses the project's own launcher (node tools\n8n-local.js), so every n8n CLI call works on the pilot's own
  PostgreSQL database and n8n user folder. No secret is printed or written by this script.
    1-4  check, change nothing: Node + .env secrets set; PostgreSQL running; package audit; credential "GI Postgres"
         (-CreatePostgresCredential builds it from .env when missing)
    5    rollback point: backups\<UTC>\workflows-before-import.json (n8n export of every workflow)
    6    stop n8n; import the 9 workflows by CLI in dependency order (fixed ids kept; imported inactive)
    7    activate exactly the 6 scheduled workflows; start n8n; confirm six "Activated workflow" lines
    8    post-import check (check-import.js): ids, identical content, references, credential links, active set
  Any failure stops the script with exit code 1.
.PARAMETER CreatePostgresCredential
  Create the shared "GI Postgres" credential from .env when it does not exist yet.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\n8n-final\import-all.ps1
#>
param([switch]$CreatePostgresCredential)
$ErrorActionPreference = 'Stop'

$Pkg = $PSScriptRoot
$Root = Split-Path -Parent (Split-Path -Parent $Pkg)
$Launcher = Join-Path (Join-Path $Root 'tools') 'n8n-local.js'
$LocalPg = Join-Path (Join-Path $Root 'tools') 'local-pg.js'
$Checker = Join-Path $Pkg 'check-import.js'
$Runtime = Join-Path $Root 'runtime'
$Order = @('09-error-handler', '03-telegram-sender', '02-ai-analyst', '08-health-monitor', '01-master-pipeline',
           '04-pre-event', '05-post-event', '06-daily-report', '07-telegram-bot')
$Active = @('giHealthMonitor1', 'giMasterPipeline', 'giPreEventEngine', 'giPostEventRevw1', 'giDailyReport001', 'giTelegramBot001')
$Passive = @('giAiAnalystSub01', 'giTelegramSend01', 'giErrorHandler01')
$script:Changed = $false
$script:BackupFile = $null

function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" }
function Fail([string]$Text) {
  Write-Host ''
  Write-Host "IMPORT: FAILED - $Text" -ForegroundColor Red
  if ($script:Changed) {
    Write-Host "Rollback: deploy\n8n-final\ROLLBACK.md R1 with $($script:BackupFile) (or re-run this script after fixing the cause)."
  }
  exit 1
}
# n8n CLI with the pilot's environment; returns the (filtered) output, fails on a non-zero exit code.
function N8n([string[]]$CliArgs) {
  $out = & node $Launcher cli @CliArgs 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "n8n $($CliArgs -join ' ') failed: $out" }
  return $out
}
function TempFile([string]$Name) { Join-Path $Runtime ("import-{0}-{1}" -f $PID, $Name) }

Set-Location $Root

Step '1/8 prerequisites'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed' }
$envFile = Join-Path $Root '.env'
if (-not (Test-Path $envFile)) { Fail '.env not found - run: node tools\setup-local.js, then CREDENTIAL_SETUP.md' }
$envText = Get-Content -Raw -Path $envFile
foreach ($k in @('TELEGRAM_BOT_TOKEN', 'OPENROUTER_API_KEY', 'GI_PG_PASSWORD', 'N8N_ENCRYPTION_KEY')) {
  if ($envText -notmatch "(?m)^$k=\S") { Fail "$k is empty in .env (CREDENTIAL_SETUP.md; Windows: tools\set-secrets.ps1)" }
  Write-Host "  ${k}: set"
}
if ($envText -match '(?m)^TELEGRAM_CHAT_ID=\S') { Write-Host '  TELEGRAM_CHAT_ID: set' }
else { Write-Host '  TELEGRAM_CHAT_ID: empty - the bot starts in setup mode: send /start to it, it replies with your chat id (CREDENTIAL_SETUP.md step 2)' }
New-Item -ItemType Directory -Force -Path $Runtime | Out-Null

Step '2/8 PostgreSQL and n8n'
$pgState = (& node $LocalPg status 2>&1 | Out-String).Trim()
if ($pgState -notmatch 'running') {
  Write-Host '  PostgreSQL stopped - starting it'
  & node $LocalPg start
  if ($LASTEXITCODE -ne 0) { Fail 'PostgreSQL did not start (node tools\local-pg.js start)' }
}
Write-Host '  PostgreSQL running'
$n8nState = (& node $Launcher status 2>&1 | Out-String).Trim()
Write-Host "  n8n: $n8nState"

Step '3/8 package audit'
& node (Join-Path $Pkg 'verify-package.js')
if ($LASTEXITCODE -ne 0) { Fail 'package audit failed' }

Step '4/8 credential GI Postgres'
$credFile = TempFile 'credentials.json'
try {
  try { N8n @('export:credentials', '--all', "--output=$credFile") | Out-Null } catch { Set-Content -Path $credFile -Value '[]' }
  & node $Checker --phase=pre "--credentials=$credFile"
  $credOk = ($LASTEXITCODE -eq 0)
  if (-not $credOk) {
    if (-not $CreatePostgresCredential) { Fail 'create the credential first (CREDENTIAL_SETUP.md), or re-run with -CreatePostgresCredential' }
    Write-Host '  creating GI Postgres from .env (value never printed)'
    & node $Launcher import-credentials
    if ($LASTEXITCODE -ne 0) { Fail 'could not create the credential' }
    N8n @('export:credentials', '--all', "--output=$credFile") | Out-Null
    & node $Checker --phase=pre "--credentials=$credFile"
    if ($LASTEXITCODE -ne 0) { Fail 'credential still missing' }
  }
} finally { Remove-Item -Force -ErrorAction SilentlyContinue $credFile }

Step '5/8 rollback point'
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$backupDir = Join-Path (Join-Path $Root 'backups') $stamp
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$script:BackupFile = Join-Path $backupDir 'workflows-before-import.json'
try { N8n @('export:workflow', '--all', "--output=$($script:BackupFile)") | Out-Null } catch { Set-Content -Path $script:BackupFile -Value '[]' }
Write-Host "  saved $($script:BackupFile)"

Step '6/8 import the 9 workflows (dependency order)'
$script:Changed = $true
& node $Launcher stop | Out-Null
foreach ($f in $Order) {
  $file = Join-Path (Join-Path $Pkg 'workflows') "$f.json"
  try { $out = N8n @('import:workflow', "--input=$file") } catch { Fail "import of $f failed: $_" }
  if ($out -notmatch 'Successfully imported 1 workflow') { Fail "import of $f did not confirm: $out" }
  Write-Host "  imported $f"
}

Step '7/8 activate the 6 scheduled workflows'
foreach ($id in $Active) {
  try { N8n @('update:workflow', "--id=$id", '--active=true') | Out-Null } catch { Fail "activate $id failed: $_" }
  Write-Host "  active   $id"
}
foreach ($id in $Passive) {
  try { N8n @('update:workflow', "--id=$id", '--active=false') | Out-Null } catch { Fail "deactivate $id failed: $_" }
  Write-Host "  inactive $id (called / error workflow)"
}
$log = Join-Path (Join-Path $Runtime 'logs') 'n8n.stdout.log'
$offset = 0
if (Test-Path $log) { $offset = (Get-Item $log).Length }
& node $Launcher start
if ($LASTEXITCODE -ne 0) { Fail 'n8n did not start (runtime\logs\n8n.stdout.log)' }
$acts = 0
for ($i = 0; $i -lt 40; $i++) {
  if (Test-Path $log) {
    $bytes = [System.IO.File]::ReadAllBytes($log)
    $fresh = [System.Text.Encoding]::UTF8.GetString($bytes, [int]$offset, [int]($bytes.Length - $offset))
    $acts = ([regex]::Matches($fresh, 'Activated workflow "GI')).Count
    if ($fresh -match 'problem activating workflow') { Fail 'n8n reported an activation problem (runtime\logs\n8n.stdout.log)' }
  }
  if ($acts -ge 6) { break }
  Start-Sleep -Seconds 3
}
if ($acts -lt 6) { Fail "only $acts of 6 schedules registered (runtime\logs\n8n.stdout.log)" }
Write-Host "  schedules registered: $acts"

Step '8/8 post-import check'
$wfFile = TempFile 'workflows.json'
$credFile = TempFile 'credentials.json'
try {
  N8n @('export:workflow', '--all', "--output=$wfFile") | Out-Null
  N8n @('export:credentials', '--all', "--output=$credFile") | Out-Null
  & node $Checker --phase=post "--workflows=$wfFile" "--credentials=$credFile" "--package=$Pkg"
  if ($LASTEXITCODE -ne 0) { Fail 'post-import check failed' }
} finally { Remove-Item -Force -ErrorAction SilentlyContinue $wfFile, $credFile }

Write-Host ''
Write-Host 'IMPORT: PASSED - 9 workflows imported, references resolved, 6 schedules active.' -ForegroundColor Green
Write-Host 'First test: send /start to the Telegram bot, then /status (VERIFICATION.md).'
