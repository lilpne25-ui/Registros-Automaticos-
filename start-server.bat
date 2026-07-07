@echo off
REM Llama al script PowerShell que inicia el servidor en background y muestra un mensaje de éxito/fallo
REM Uso: doble click en este archivo o crear acceso directo en el escritorio apuntando a él

SET SCRIPT_DIR=%~dp0scripts
IF NOT EXIST "%SCRIPT_DIR%\start-server.ps1" (
    echo No se encontro scripts\start-server.ps1. Asegurate de que la estructura del repo no fue modificada.
    pause
    exit /b 1
)

REM Ejecutar PowerShell con ExecutionPolicy Bypass para evitar restricciones de política local
powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\start-server.ps1" -OpenBrowser
