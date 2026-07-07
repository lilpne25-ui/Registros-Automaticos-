@echo off
REM Script para ejecutar LaserControl en Windows CMD
REM Este script evita problemas de permisos de PowerShell
REM Uso: ejecutar este archivo directamente o desde cmd.exe

title LaserControl - Sistema de Grabado Laser

REM Cambiar al directorio del script (permitir migración entre PCs)
pushd "%~dp0"

echo.
echo ========================================
echo     LaserControl - Control Panel
echo ========================================
echo.
echo Iniciando aplicacion...
echo.

node start-laser-control.js

pause
