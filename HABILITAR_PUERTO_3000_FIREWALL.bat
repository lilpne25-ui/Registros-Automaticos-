@echo off
setlocal

echo Este script crea una regla de Firewall para permitir conexiones entrantes al puerto 3000 (TCP).
echo Requiere ejecutar como Administrador.
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo ❌ No tienes permisos de Administrador.
  echo    Cierra esta ventana y ejecuta el .bat como Administrador.
  pause
  exit /b 1
)

echo ✅ Creando regla de Firewall...
netsh advfirewall firewall add rule name="LaserControl HTTP 3000" dir=in action=allow protocol=TCP localport=3000 profile=any enable=yes >nul

if %errorlevel% neq 0 (
  echo ❌ No se pudo crear la regla.
  echo    Intenta abrir manualmente el puerto 3000 en Firewall de Windows.
  pause
  exit /b 1
)

echo ✅ Regla creada: "LaserControl HTTP 3000"
echo.
echo Si aun no conecta desde otra PC, revisa:
echo - Que el servidor este corriendo en la PC Servidor
echo - Que la IP sea correcta
echo - Que ambas PCs esten en la misma red
echo.
pause
exit /b 0
