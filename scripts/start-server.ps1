Param(
    [switch]$OpenBrowser
)

# Script para iniciar el servidor Node desde un acceso directo en Windows.
# Comportamiento:
# 1) Arranca `node server.js` en el directorio del proyecto.
# 2) Espera hasta `http://localhost:3000/status` (timeout configurable).
# 3) Muestra un mensaje indicando éxito o fallo y opcionalmente abre el navegador.

try {
    $projectRoot = Split-Path -Parent $PSScriptRoot
} catch {
    $projectRoot = Get-Location
}

function Get-LanUrls([int]$Port) {
    $urls = @()
    try {
        $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -and $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' }
        foreach ($a in $addrs) {
            $ip = $a.IPAddress
            if ($ip -and ($urls -notcontains "http://$ip`:$Port")) {
                $urls += "http://$ip`:$Port"
            }
        }
    } catch {
        # ignore
    }
    return $urls
}

$serverScript = Join-Path $projectRoot 'server.js'
if (-not (Test-Path $serverScript)) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("No se encontró server.js en: `n$projectRoot","Error arrancando servidor")
    exit 1
}

# Si el puerto ya está ocupado, intentar reiniciar el servidor (solo si es node)
$port = 3000
try {
    $existingPid = $null
    try {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) { $existingPid = $conn.OwningProcess }
    } catch { }

    if (-not $existingPid) {
        # Fallback por netstat (por compatibilidad)
        $line = (netstat -ano | Select-String -Pattern (":$port\s+.*LISTENING") | Select-Object -First 1)
        if ($line) {
            $parts = ($line -split "\s+") | Where-Object { $_ -and $_.Trim().Length -gt 0 }
            if ($parts.Count -ge 5) { $existingPid = [int]$parts[-1] }
        }
    }

    if ($existingPid) {
        $p = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -match '^node$') {
            Write-Output "[i] Puerto $port en uso por node (PID: $existingPid). Reiniciando para aplicar cambios..."
            Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 700
        } else {
            Add-Type -AssemblyName PresentationFramework
            $pname = if ($p) { $p.ProcessName } else { 'desconocido' }
            [System.Windows.MessageBox]::Show("El puerto $port está en uso por otro proceso (PID: $existingPid - $pname).\nCierra esa aplicación e intenta de nuevo.","Puerto en uso")
            exit 3
        }
    }
} catch {
    # Si falla la detección, continuar sin bloquear
}

# Crear carpeta de logs si no existe
$logDir = Join-Path $projectRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -Path $logDir -ItemType Directory -Force | Out-Null }

# Intentar iniciar Node en background (ventana minimizada)
try {
    Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $projectRoot -WindowStyle Minimized
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("No se pudo iniciar Node. Asegúrate de que 'node' está en el PATH.\nError: $_","Error")
    exit 1
}

# Poll a /status para verificar arranque
$statusUrl = 'http://localhost:3000/status'
$timeoutSec = 30
$elapsed = 0
Write-Output "Esperando que el servidor responda en $statusUrl (timeout ${timeoutSec}s)..."
while ($elapsed -lt $timeoutSec) {
    try {
        $r = Invoke-RestMethod -Uri $statusUrl -Method Get -TimeoutSec 3
        if ($r) { break }
    } catch { }
    Start-Sleep -Seconds 1
    $elapsed++
}

Add-Type -AssemblyName PresentationFramework
if ($elapsed -lt $timeoutSec) {
    $lan = Get-LanUrls -Port $port
    $lanText = if ($lan -and $lan.Count -gt 0) { "\n\nMultiusuario (otras PCs):\n" + ($lan -join "\n") } else { "" }
    $hint = "\n\nSi otra PC no conecta: abre el puerto TCP 3000 en Firewall de Windows (en la PC Servidor)."
    [System.Windows.MessageBox]::Show("Servidor iniciado correctamente.\nUI local: http://localhost:3000" + $lanText + $hint,"Servidor iniciado")
    if ($OpenBrowser) { Start-Process 'http://localhost:3000' }
    exit 0
} else {
    [System.Windows.MessageBox]::Show("Timeout: no se pudo conectar a $statusUrl en ${timeoutSec}s. Revisa que no haya otro proceso usando el puerto o mira los logs.","Error al iniciar servidor")
    exit 2
}
