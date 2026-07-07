<#
  migrate.ps1 - Ayuda a preparar/migrar el proyecto en Windows

  Uso:
    .\migrate.ps1 -Install    # Ejecuta npm install si hay package.json
    .\migrate.ps1 -Start      # Inicia node server.js (proceso en background)
    .\migrate.ps1 -Install -Start
#>

param(
    [switch]$Install,
    [switch]$Start
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $scriptDir
Write-Host "Directorio del proyecto: $scriptDir`n" -ForegroundColor Cyan

# 1) Comprobar Node
try {
    $nodeVersion = (& node --version) -join ""
    Write-Host "Node detectado: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Node.js no está instalado o no está en PATH. Instala Node.js desde https://nodejs.org" -ForegroundColor Red
    exit 1
}

# 2) npm install si se pidió o si existe package.json
if ($Install -or (Test-Path "$scriptDir\package.json")) {
    if (Test-Path "$scriptDir\package.json") {
        Write-Host "Ejecutando npm install..." -ForegroundColor Yellow
        & npm install
        if ($LASTEXITCODE -ne 0) {
            Write-Host "npm install falló. Revisa los errores arriba." -ForegroundColor Red
            exit 1
        }
        Write-Host "npm install completado." -ForegroundColor Green
    } else {
        Write-Host "No se encontró package.json en el proyecto; omitiendo npm install." -ForegroundColor Yellow
    }
}

# 3) Iniciar servidor si se pidió
if ($Start) {
    if (Test-Path "$scriptDir\server.js") {
        Write-Host "Iniciando server.js en background..." -ForegroundColor Yellow
        Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory $scriptDir
        Start-Sleep -Seconds 2
        Write-Host "Abriendo navegador en http://localhost:3000" -ForegroundColor Cyan
        Start-Process "http://localhost:3000"
    } else {
        Write-Host "No se encontró server.js en el directorio del proyecto." -ForegroundColor Red
        exit 1
    }
}

Write-Host "Listo. Revisa los pasos anteriores y ejecuta los .bat si prefieres (ej.: start-laser-control.bat)." -ForegroundColor Green