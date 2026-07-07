@echo off
REM ========================================
REM  LASER CONTROL - Script de Inicio
REM  Haz doble clic en este archivo
REM ========================================

setlocal EnableExtensions EnableDelayedExpansion

REM Nota: evitamos cambiar codepage para no romper findstr/netstat en algunos entornos.

REM Cambiar a la carpeta del proyecto (usa la ruta del script para migrabilidad)
pushd "%~dp0"
if errorlevel 1 (
    echo No se pudo cambiar al directorio del script: %~dp0
    pause
    exit /b 1
)

if not exist "server.js" (
    echo ERROR: No se encontro server.js en %~dp0
    pause
    exit /b 1
)

REM Base de datos central (ruta fija indicada por el usuario)
set "LASER_DB_PATH=\\ociserver\INNOVAX\AREA DE TRABAJO\6.- ENSAMBLE\Nueva carpeta\BASE DATOS SISTEMA DE GRABADO LASER Y PAVONADO\laser_engraving.db"
if not exist "%LASER_DB_PATH%" (
    echo ERROR: No se encontro la base de datos configurada:
    echo %LASER_DB_PATH%
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js no esta instalado o no esta en PATH.
    echo Instala Node.js LTS desde https://nodejs.org y vuelve a intentar.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [INFO] No se encontro node_modules. Instalando dependencias...
    if exist "package-lock.json" (
        call npm ci
    ) else (
        call npm install
    )
    if errorlevel 1 (
        echo ERROR: Fallo la instalacion de dependencias.
        pause
        exit /b 1
    )
)

echo.
echo ========================================
echo   LASER CONTROL - Sistema de Grabado Laser
echo ========================================
echo.
echo Iniciando servidor...
echo Se abrira el navegador en unos segundos
echo.

echo [TIP] Multiusuario: otras PCs deben entrar a http://IP_DE_ESTA_PC:3000
echo       Si no conecta, abre el puerto TCP 3000 en Firewall (ver HABILITAR_PUERTO_3000_FIREWALL.bat)
echo [DB] Usando: %LASER_DB_PATH%
echo.

REM Evitar doble instancia del servidor (Error EADDRINUSE)
set "PORT_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    set "PORT_PID=%%P"
    goto :PORT_PID_FOUND
)

:PORT_PID_FOUND

if not defined PORT_PID goto PORT_FREE

echo [WARN] El puerto 3000 ya esta en uso (PID %PORT_PID%).

REM Si /status responde, asumimos que LaserControl ya esta corriendo y no abrimos una segunda instancia.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Uri 'http://localhost:3000/status' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 goto PORT_OCCUPIED_OTHER

echo [INFO] Se detecto servidor activo en http://localhost:3000
echo [INFO] Abriendo navegador...
start "" "http://localhost:3000"
exit /b 0

:PORT_OCCUPIED_OTHER
set "PORT_PROC="
for /f "tokens=1 delims=," %%N in ('tasklist /FI "PID eq %PORT_PID%" /FO CSV /NH') do set "PORT_PROC=%%~N"

if /I "%PORT_PROC%"=="node.exe" (
    echo [WARN] Se detecto un proceso Node sin respuesta en el puerto 3000. Reiniciando...
    taskkill /PID %PORT_PID% /F >nul 2>nul
    timeout /t 1 >nul
    goto PORT_FREE
)

echo [ERROR] El puerto 3000 esta ocupado por otro proceso (%PORT_PROC%).
echo         Libera ese puerto o cambia PORT en .env antes de iniciar.
pause
exit /b 1

:PORT_FREE

REM Mostrar IPs IPv4 (LAN) para facilitar la URL
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -and $_.IPAddress -ne '127.0.0.1' } | Select-Object -ExpandProperty IPAddress; if($ips){ Write-Host 'IPs detectadas:'; $ips | ForEach-Object { Write-Host (' - http://{0}:3000' -f $_) } } else { Write-Host 'No se detectaron IPs LAN (solo 127.0.0.1).' }"

echo [INFO] Abriendo servidor en ventana separada...
start "LaserControl Server" cmd /k "cd /d ""%~dp0"" && node server.js"
timeout /t 1 >nul
start "" "http://localhost:3000"

exit /b 0