# =============================================================
# setup-infra.ps1  —  One-time infrastructure creation
# Creates Render DB + Redis + Web Service + Vercel env vars
# Run once. Safe to re-run (checks for existing resources).
#
# REQUIRES: scripts\.env.deploy  (gitignored, not committed)
#
# USAGE:
#   .\scripts\setup-infra.ps1
#   .\scripts\setup-infra.ps1 -Region ohio -AppName demandplanning
# =============================================================
param(
    [string]$Region      = "ohio",
    [string]$AppName     = "demandplanning",
    [string]$FrontendUrl = "https://demandgenius.vercel.app"
)

$ErrorActionPreference = "Stop"

# ── Load secrets from .env.deploy ────────────────────────────
$envFile = Join-Path $PSScriptRoot ".env.deploy"
if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: $envFile not found. Copy .env.deploy.example and fill in tokens." -ForegroundColor Red
    exit 1
}
$secrets = @{}
Get-Content $envFile | Where-Object { $_ -match "^[A-Z]" -and $_ -notmatch "^#" } | ForEach-Object {
    $p = $_ -split "=", 2; if ($p.Count -eq 2) { $secrets[$p[0].Trim()] = $p[1].Trim() }
}

$RENDER_TOKEN   = $secrets["RENDER_TOKEN"]
$GITHUB_TOKEN   = $secrets["GITHUB_TOKEN"]
$VERCEL_TOKEN   = $secrets["VERCEL_TOKEN"]
$VERCEL_TEAM    = $secrets["VERCEL_TEAM"]
$VERCEL_PROJECT = $secrets["VERCEL_PROJECT_ID"]
$GITHUB_REPO    = $secrets["GITHUB_REPO"] ?? "sathiamurthi/$AppName-backend"

# ── Helpers ───────────────────────────────────────────────────
function Write-Step { param($msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK   { param($msg) Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "    WARN $msg" -ForegroundColor Yellow }

function Invoke-Render {
    param([string]$Method="GET", [string]$Path, [object]$Body=$null)
    $h   = @{ "Authorization" = "Bearer $RENDER_TOKEN"; "Content-Type" = "application/json" }
    $url = "https://api.render.com/v1$Path"
    if ($Body) { return Invoke-RestMethod -Method $Method -Uri $url -Headers $h -Body ($Body | ConvertTo-Json -Depth 10) }
    return Invoke-RestMethod -Method $Method -Uri $url -Headers $h
}

function Invoke-Vercel {
    param([string]$Method="GET", [string]$Path, [object]$Body=$null)
    $h   = @{ "Authorization" = "Bearer $VERCEL_TOKEN"; "Content-Type" = "application/json" }
    $url = "https://api.vercel.com$Path"
    if ($Body) { return Invoke-RestMethod -Method $Method -Uri $url -Headers $h -Body ($Body | ConvertTo-Json -Depth 10) }
    return Invoke-RestMethod -Method $Method -Uri $url -Headers $h
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 1 — Render PostgreSQL
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Write-Step "Render PostgreSQL"
$dbs = Invoke-Render -Path "/postgres"
$db  = $dbs | Where-Object { $_.postgres.name -eq "$AppName-db" } | Select-Object -First 1

if ($db) {
    $dbId  = $db.postgres.id
    $dbUrl = $db.postgres.connectionInfo.externalConnectionString
    Write-OK "Existing DB: $dbId"
} else {
    $new  = Invoke-Render -Method POST -Path "/postgres" -Body @{
        name         = "$AppName-db"
        databaseName = ($AppName -replace "-","")
        user         = ($AppName -replace "-","") + "_user"
        region       = $Region
        plan         = "free"
    }
    $dbId  = $new.postgres.id
    $dbUrl = $new.postgres.connectionInfo.externalConnectionString
    Write-OK "Created DB: $dbId"
    Start-Sleep -Seconds 5
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 2 — Render Redis
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Write-Step "Render Redis"
$redises = Invoke-Render -Path "/redis"
$redis   = $redises | Where-Object { $_.redis.name -eq "$AppName-redis" } | Select-Object -First 1

if ($redis) {
    $redisId = $redis.redis.id
    Write-OK "Existing Redis: $redisId"
} else {
    $new     = Invoke-Render -Method POST -Path "/redis" -Body @{ name="$AppName-redis"; region=$Region; plan="free" }
    $redisId = $new.redis.id
    Write-OK "Created Redis: $redisId"
    Start-Sleep -Seconds 3
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 3 — Read backend .env for secrets
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Write-Step "Reading backend secrets"
$beEnvFile = Join-Path $PSScriptRoot "..\backend\.env"
$be = @{}
if (Test-Path $beEnvFile) {
    Get-Content $beEnvFile | Where-Object { $_ -match "^[A-Z]" -and $_ -notmatch "^#" } | ForEach-Object {
        $p = $_ -split "=", 2; if ($p.Count -eq 2) { $be[$p[0].Trim()] = $p[1].Trim() }
    }
    Write-OK "Loaded $($be.Count) vars from backend/.env"
} else {
    Write-Warn "backend/.env not found — some vars will be empty"
}

$envPayload = @(
    @{ key="NODE_ENV";              value="production" }
    @{ key="PORT";                  value="10000" }
    @{ key="DATABASE_URL";          value=$dbUrl }
    @{ key="REDIS_URL";             value="redis://$($redisId):6379" }
    @{ key="FRONTEND_URL";          value=$FrontendUrl }
    @{ key="JWT_SECRET";            value=($be["JWT_SECRET"]               ?? "change-me") }
    @{ key="JWT_REFRESH_SECRET";    value=($be["JWT_REFRESH_SECRET"]       ?? "change-me") }
    @{ key="CLAUDE_API_KEY";        value=($be["CLAUDE_API_KEY"]           ?? "") }
    @{ key="ENABLE_AI";             value="true" }
    @{ key="ENABLE_BILLING";        value="true" }
    @{ key="ENABLE_AUDIT_LOG";      value="true" }
    @{ key="ENABLE_WHATSAPP";       value="true" }
    @{ key="WHATSAPP_API_VERSION";  value=($be["WHATSAPP_API_VERSION"]     ?? "v25.0") }
    @{ key="WHATSAPP_PHONE_NUMBER_ID"; value=($be["WHATSAPP_PHONE_NUMBER_ID"] ?? "") }
    @{ key="WHATSAPP_WABA_ID";      value=($be["WHATSAPP_WABA_ID"]         ?? "") }
    @{ key="WHATSAPP_APP_ID";       value=($be["WHATSAPP_APP_ID"]          ?? "") }
    @{ key="WHATSAPP_ACCESS_TOKEN"; value=($be["WHATSAPP_ACCESS_TOKEN"]    ?? "") }
    @{ key="WHATSAPP_APP_SECRET";   value=($be["WHATSAPP_APP_SECRET"]      ?? "") }
    @{ key="WHATSAPP_VERIFY_TOKEN"; value=($be["WHATSAPP_VERIFY_TOKEN"]    ?? "") }
    @{ key="SMTP_HOST";             value=($be["SMTP_HOST"]                ?? "smtp.gmail.com") }
    @{ key="SMTP_PORT";             value=($be["SMTP_PORT"]                ?? "587") }
    @{ key="SMTP_USER";             value=($be["SMTP_USER"]                ?? "") }
    @{ key="SMTP_PASS";             value=($be["SMTP_PASS"]                ?? "") }
    @{ key="SMTP_FROM_NAME";        value=($be["SMTP_FROM_NAME"]           ?? "DemandGenius") }
    @{ key="SMTP_FROM_EMAIL";       value=($be["SMTP_FROM_EMAIL"]          ?? "") }
    @{ key="LOG_LEVEL";             value="info" }
)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 4 — Render Web Service
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Write-Step "Render Web Service"
$services = Invoke-Render -Path "/services?type=web_service"
$svc      = $services | Where-Object { $_.service.name -eq "$AppName-backend" } | Select-Object -First 1

if ($svc) {
    $svcId = $svc.service.id
    Write-OK "Existing service: $svcId"
    Invoke-Render -Method PUT -Path "/services/$svcId/env-vars" -Body $envPayload | Out-Null
    Write-OK "Env vars updated ($($envPayload.Count) vars)"
} else {
    $new  = Invoke-Render -Method POST -Path "/services" -Body @{
        type        = "web_service"
        name        = "$AppName-backend"
        region      = $Region
        plan        = "free"
        repo        = "https://github.com/$GITHUB_REPO"
        branch      = "main"
        autoDeploy  = "no"
        serviceDetails = @{
            envSpecificDetails = @{
                buildCommand = "npm install --include=dev && npm run build"
                startCommand = "node dist/index.js"
            }
            healthCheckPath = "/v1/health"
            envVars = $envPayload
        }
    }
    $svcId = $new.service.id
    Write-OK "Created service: $svcId"
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 5 — Vercel BACKEND_URL
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Write-Step "Vercel BACKEND_URL"
$backendUrl = "https://$AppName-backend.onrender.com"
try {
    $envList  = Invoke-Vercel -Path "/v10/projects/$VERCEL_PROJECT/env?teamId=$VERCEL_TEAM"
    $existing = $envList.envs | Where-Object { $_.key -eq "BACKEND_URL" } | Select-Object -First 1
    if ($existing) {
        Invoke-Vercel -Method PATCH -Path "/v10/projects/$VERCEL_PROJECT/env/$($existing.id)?teamId=$VERCEL_TEAM" `
            -Body @{ value = $backendUrl } | Out-Null
        Write-OK "BACKEND_URL updated → $backendUrl"
    } else {
        Invoke-Vercel -Method POST -Path "/v10/projects/$VERCEL_PROJECT/env?teamId=$VERCEL_TEAM" `
            -Body @{ key="BACKEND_URL"; value=$backendUrl; type="plain"; target=@("production","preview") } | Out-Null
        Write-OK "BACKEND_URL set → $backendUrl"
    }
} catch { Write-Warn "Vercel env update failed: $_" }

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SUMMARY
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "  Infrastructure ready" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "  DB      : $dbId"
Write-Host "  Redis   : $redisId"
Write-Host "  Backend : $svcId  =>  $backendUrl"
Write-Host "  Frontend: $FrontendUrl"
Write-Host ""
Write-Host "  Next: run  .\scripts\deploy.ps1" -ForegroundColor Yellow
Write-Host ""

# Save IDs to .env.deploy for deploy.ps1
$content = Get-Content $envFile -Raw
foreach ($kv in @(@("RENDER_SVC_ID",$svcId))) {
    if ($content -match "$($kv[0])=") {
        $content = $content -replace "$($kv[0])=.*", "$($kv[0])=$($kv[1])"
    } else {
        $content += "`n$($kv[0])=$($kv[1])"
    }
}
Set-Content $envFile $content -Encoding utf8
Write-OK ".env.deploy updated with RENDER_SVC_ID=$svcId"
