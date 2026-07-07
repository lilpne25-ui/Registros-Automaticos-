@echo off
REM ========================================
REM  LaserControl - Ejecutor Windows
REM  Este script arranca el servidor y Electron
REM ========================================
REM
REM  Uso: Doble clic en este archivo o:
REM       cmd /c run-laser-control.bat

echo.
echo ========================================
echo     LaserControl - Sistema de Grabado Laser
echo ========================================
echo.

REM Cambiar a la carpeta del proyecto (usa la ruta del script para migrabilidad)
pushd "%~dp0"
if errorlevel 1 (
    echo ERROR: No se pudo cambiar al directorio del script: %~dp0
    echo Asegúrate de que la carpeta del proyecto existe y no hay permisos bloqueando el acceso.
    pause
    exit /b 1
)

echo ✓ Ruta: %cd%
echo.

REM Verificar que node.exe existe
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js no está instalado o no está en PATH
    echo Descarga Node.js desde: https://nodejs.org
    pause
    exit /b 1
)

echo ✓ Node.js encontrado
echo.

REM Iniciar el servidor
echo 1. Iniciando servidor en puerto 3000...
echo    (puede tardar 5-10 segundos)
echo.

timeout /t 2 /nobreak > nul

REM Ejecutar el servidor
node server.js
