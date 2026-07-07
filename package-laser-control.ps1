# PowerShell script para empaquetar la app Electron en Windows
# Uso: .\package-laser-control.ps1
# Asegurate de ejecutar como administrador para poder matar procesos si es necesario

Write-Host "================================" -ForegroundColor Green
Write-Host "LaserControl Packaging Tool" -ForegroundColor Green
Write-Host "================================`n" -ForegroundColor Green

# Validar que estamos en la raiz del proyecto
$projectRoot = (Get-Location).Path
if (-not (Test-Path "$projectRoot\desktop\main.js")) {
    Write-Host "ERROR: No se detecto la estructura del proyecto" -ForegroundColor Red
    Write-Host "Asegurate de ejecutar este script desde la raiz del proyecto (la carpeta donde se encuentra este script)" -ForegroundColor Yellow
    exit 1
}

function Ensure-InstallerIcon {
    $iconPng = "$projectRoot\desktop\icon.png"
    $iconIco = "$projectRoot\desktop\icon.ico"
    $fallbackIco = "$projectRoot\public\favicon.ico"

    $magick = Get-Command magick -ErrorAction SilentlyContinue
    if ($magick -and (Test-Path $iconPng)) {
        try {
            & $magick.Source convert "$iconPng" -define icon:auto-resize=256,128,64,48,32,16 "$iconIco" | Out-Null
            Write-Host "OK icon.ico regenerado con ImageMagick: $iconIco" -ForegroundColor Green
            return
        } catch {
            Write-Host "AVISO No se pudo regenerar icon.ico con ImageMagick: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    if (Test-Path $fallbackIco) {
        try {
            Copy-Item -Force $fallbackIco $iconIco
            Write-Host "OK icon.ico reemplazado con favicon.ico" -ForegroundColor Green
            return
        } catch {
            Write-Host "AVISO No se pudo copiar favicon.ico: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    Write-Host "AVISO No se pudo preparar un icono valido" -ForegroundColor Yellow
}

# Step 1: Verificar requisitos
Write-Host "PASO 1: Verificando requisitos..." -ForegroundColor Cyan
node verificar_empaquetado.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "`nSoluciona los problemas anteriores antes de continuar" -ForegroundColor Red
    exit 1
}

# Step 2: Preguntar si detener procesos
Write-Host "`nPASO 2: Detener procesos bloqueantes (opcional)..." -ForegroundColor Cyan
$response = Read-Host "Deseas detener procesos LaserControl/electron/node? (S/N)"
if ($response -eq "S" -or $response -eq "s") {
    Write-Host "Deteniendo procesos..." -ForegroundColor Yellow
    try {
        taskkill /IM LaserControl.exe /F 2>$null | Out-Null
        taskkill /IM electron.exe /F 2>$null | Out-Null
        # No matamos node.exe de forma global para no afectar otros scripts
        Write-Host "OK Procesos detenidos`n" -ForegroundColor Green
    } catch {
        Write-Host "AVISO No se pudieron detener algunos procesos (continuar de todos modos)" -ForegroundColor Yellow
    }
}

Write-Host "`nPASO 2.1: Preparando icono..." -ForegroundColor Cyan
Ensure-InstallerIcon

# Step 3: Ejecutar empaquetado
Write-Host "PASO 3: Empaquetando aplicacion..." -ForegroundColor Cyan
Write-Host "(Esto puede tardar 1-2 minutos)`n" -ForegroundColor Yellow
Set-Location "$projectRoot\desktop"
node build-package.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "`nERROR: El empaquetado fallo" -ForegroundColor Red
    exit 1
}

# Step 4: Generar instalador
Write-Host "`nPASO 4: Generando instalador (NSIS)..." -ForegroundColor Cyan
npm run installer-win
if ($LASTEXITCODE -ne 0) {
    Write-Host "`nERROR: La generacion del instalador fallo" -ForegroundColor Red
    exit 1
}

# Step 5: Verificar resultado
Write-Host "`nPASO 5: Verificando resultado..." -ForegroundColor Cyan
$exePath = "$projectRoot\dist\LaserControl-win32-x64\LaserControl.exe"
$installerPath = Get-ChildItem "$projectRoot\dist\LaserControl Setup *.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (Test-Path $exePath) {
    Write-Host "OK LaserControl.exe creado exitosamente" -ForegroundColor Green
    $fileSize = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
    Write-Host "  Tamano: $fileSize MB" -ForegroundColor Green
} else {
    Write-Host "ERROR: No se encontro LaserControl.exe" -ForegroundColor Red
    exit 1
}

if ($installerPath) {
    Write-Host "OK Instalador creado: $($installerPath.FullName)" -ForegroundColor Green
} else {
    Write-Host "ERROR: No se encontro el instalador" -ForegroundColor Red
    exit 1
}

# Step 6: Verificar archivos dentro del instalador (win-unpacked)
Write-Host "`nPASO 6: Verificando contenido en win-unpacked..." -ForegroundColor Cyan
$hasMismatch = $false

function Compare-FileHash {
    param(
        [string]$src,
        [string]$dst,
        [string]$label
    )
    if (-not (Test-Path $src)) {
        Write-Host "ERROR Falta origen: $label -> $src" -ForegroundColor Red
        return $true
    }
    if (-not (Test-Path $dst)) {
        Write-Host "ERROR Falta en paquete: $label -> $dst" -ForegroundColor Red
        return $true
    }
    $srcHash = (Get-FileHash $src -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash $dst -Algorithm SHA256).Hash
    if ($srcHash -ne $dstHash) {
        Write-Host "ERROR No coincide: $label" -ForegroundColor Red
        return $true
    }
    Write-Host "OK $label" -ForegroundColor Green
    return $false
}

$hasMismatch = (Compare-FileHash "$projectRoot\server.js" "$projectRoot\dist\win-unpacked\resources\server\server.js" "server.js") -or $hasMismatch
$hasMismatch = (Compare-FileHash "$projectRoot\public\sistema_de_grabado_laserv1.html" "$projectRoot\dist\win-unpacked\resources\server\public\sistema_de_grabado_laserv1.html" "sistema_de_grabado_laserv1.html") -or $hasMismatch

if ($hasMismatch) {
    Write-Host "`nERROR: El instalador no contiene los cambios actuales" -ForegroundColor Red
    exit 1
}

Write-Host "`nOK El instalador contiene los cambios actuales" -ForegroundColor Green

# Step 7: Preguntar si probar
Write-Host "`nPASO 7: Prueba..." -ForegroundColor Cyan
$testResponse = Read-Host "Deseas ejecutar LaserControl.exe ahora? (S/N)"
if ($testResponse -eq "S" -or $testResponse -eq "s") {
    Write-Host "Iniciando LaserControl.exe...`n" -ForegroundColor Yellow
    & $exePath
} else {
    Write-Host "`nPuedes ejecutar manualmente:" -ForegroundColor Cyan
    Write-Host "  $exePath" -ForegroundColor White
    Write-Host "  $($installerPath.FullName)`n" -ForegroundColor White
}

Write-Host "Proceso completado" -ForegroundColor Green
Write-Host "Consulta README_EMPAQUETADO.md para mas informacion`n" -ForegroundColor Cyan
