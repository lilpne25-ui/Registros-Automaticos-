# Manual de Usuario — Sistema de Grabado Láser

Fecha: 2026-01-05

Este manual es práctico y va directo a los botones y pasos que usarás día a día.

## 1) Arrancar el sistema

1. En Windows, haz doble clic en `INICIAR_LASER_CONTROL.bat`.
2. Se abre el navegador en `http://localhost:3000` (si no, ábrelo manualmente).
3. Verifica que el dashboard muestre totales (sin errores). Listo para trabajar.

## 1.1) Modo multiusuario (3–10 PCs en red local)

Para que **varias personas vean y editen lo mismo** sin errores, la regla de oro es:

- ✅ **Solo 1 PC corre el servidor (Node.js) y la base de datos**.
- ✅ Las demás PCs **solo abren el sistema en el navegador**.
- ❌ No corras `node server.js` en cada PC apuntando al mismo `.db` en red: SQLite en carpeta compartida suele dar errores de bloqueo/permisos.

### Recomendado (estable): 1 “PC Servidor” + varios clientes

1. Elige una PC que se quede encendida (la “PC Servidor”).
2. En esa PC, arranca el sistema con `INICIAR_LASER_CONTROL.bat`.
3. En las otras PCs, abre el navegador y entra a:

- `http://IP_DE_LA_PC_SERVIDOR:3000`
- Ejemplo: `http://192.168.1.50:3000`

> Nota: el sistema ya detecta el “origen” (IP/host) automáticamente para que no intente conectarse a `localhost` desde otra PC.

### Carpetas compartidas (imágenes) y ruta de BD

- Las **imágenes** pueden estar en servidor/carpeta compartida (UNC).
- La **BD** idealmente debe estar en el disco local de la PC Servidor (más estable). Si la pones en red, debe haber permisos de lectura/escritura.

El archivo `.env` controla esto:

- `LASER_DB_PATH` = ruta de la base SQLite (`laser_engraving.db`)
- `TO_ENGRAVE_DIR` = carpeta de trabajo / imágenes

## 1.2) Si en otra PC te sale “error en la base de datos”

Esto casi siempre pasa por una de estas causas:

1. **La PC no tiene acceso a la ruta de red (UNC)**

- Prueba abrir en el Explorador: `\\ociserver\INNOVAX\...`
- Si pide usuario/contraseña o no abre, hay que dar permisos/credenciales.

2. **Estás intentando correr el servidor en más de una PC contra la misma BD**

- Síntomas comunes:
  - `SQLITE_BUSY: database is locked`
  - `SQLITE_CANTOPEN: unable to open database file`
- Solución: deja **solo una** instancia del servidor usando esa BD.

3. **Firewall bloquea el acceso al puerto 3000**

- Si desde otra PC no carga `http://IP:3000`, revisa Firewall de Windows en la PC Servidor.

Si me copias aquí el texto exacto del error (las líneas que salen en la consola), te digo exactamente cuál de las tres es y cómo corregirlo.

## 1.3) Si en otra PC sale “No puede conectarse” a `http://IP:3000`

Ese mensaje (como en Firefox) significa **conexión bloqueada o servidor no accesible**, no es un error de la BD.

Checklist rápido:

1. En la **PC Servidor**, abre `http://localhost:3000`.

- Si tampoco abre ahí, el servidor no está corriendo.

2. Verifica la IP correcta de la PC Servidor.

- En la PC Servidor: `ipconfig` y busca “Dirección IPv4”.
- Usa esa IP en las otras PCs: `http://IP:3000`

3. Firewall de Windows (muy común):

- En la PC Servidor, ejecuta como Administrador: `HABILITAR_PUERTO_3000_FIREWALL.bat`
- O abre manualmente el puerto TCP 3000 en Firewall.

4. Misma red:

- Ambas PCs deben estar en la misma red/VLAN.
- Prueba hacer ping a la IP de la PC Servidor.

Si después de eso sigue sin abrir, casi siempre es Firewall corporativo, política de red o la IP cambió.

## 1.4) WhatsApp — Opción B (mantener filtro por grupo)

Este modo es el recomendado si quieres que el bot **solo responda en grupos autorizados**.

### Cómo funciona

- El filtro está controlado por `allowed_groups.json`.
- En desktop ese archivo vive en `%LOCALAPPDATA%\LaserControl\allowed_groups.json`.
- Si el archivo tiene **al menos 1 entrada**, el filtro queda **ACTIVO**.
- Si escriben desde un grupo/chat no autorizado, el bot **ignora** o **avisa** que no está autorizado (y te muestra el ID del chat/grupo).

### Autorizar un grupo nuevo (paso a paso)

1. Abre el sistema y verifica que el servidor esté corriendo.
2. En WhatsApp, entra al **grupo** donde quieres usar el bot y manda un mensaje cualquiera.
3. Si ese grupo NO está autorizado, el bot te responderá con el **ID del grupo** (algo como `1203...@g.us`).
4. Abre `%LOCALAPPDATA%\LaserControl\allowed_groups.json` y agrega una línea con ese ID y un nombre.

Ejemplo:

- Antes:
  - (ya tienes algunos IDs)
- Agrega:
  - `"1203630XXXXXXXXXXXX@g.us": "Nombre de tu grupo"`

5. Reinicia el servidor (cierra y vuelve a abrir con `INICIAR_LASER_CONTROL.bat`).
6. Listo: el bot ya responderá y registrará solo en ese grupo.

### Si quieres aceptar mensajes privados también

Además de grupos (`@g.us`), puedes autorizar un contacto agregando:

- el número: `"521XXXXXXXXXX": "Nombre"`
- o el JID: `"521XXXXXXXXXX@c.us": "Nombre"`

> Nota: si el filtro está activo y un chat no está autorizado, es normal que parezca “no conectado”. En realidad está conectado, solo está filtrando.

## 2) Dónde hacer cada cosa (mapa rápido)

- **Acciones** (tarjeta de la izquierda):
  - **Cierre de Mes (Todo)**: limpia datos operativos de Láser y Pavonado (no borra lotes).
  - **Exportar**: baja un respaldo completo (JSON).
  - **Importar**: sube un respaldo previo.
- **Reportes**: botones “Ver Reporte Láser” y “Ver Reporte Pavonado” para imprimir o revisar.
- **Registro** (sección central): donde ves y editas piezas por lote.

## 3) Cómo agregar piezas

1. Abre el Registro y elige el lote (ej. `LOTES`).
2. Usa el formulario de agregar pieza (parte y cantidad). Si viene de WhatsApp con foto, ya aparecerá con su imagen.
3. Guarda; la pieza queda en el lote seleccionado.

## 4) Cómo editar o borrar piezas

1. En el Registro, selecciona el lote.
2. Busca la pieza en la lista.
3. Edita los campos necesarios y guarda, o elimina si ya no se necesita.

## 5) Cómo agregar métricas

1. Ve al reporte (Láser o Pavonado).
2. En la sección de métricas del lote, usa los campos para capturar valores (piezas buenas, reproceso, etc.).
3. Guarda; las métricas quedan ligadas al lote.

## 6) Cómo generar reportes

- Haz clic en **Ver Reporte Láser** o **Ver Reporte Pavonado**.
- Verás tabla de piezas, métricas y fotos (miniaturas). Puedes imprimir desde el navegador (Ctrl+P) o exportar usando el botón **Exportar** de Acciones para un respaldo completo.

## 7) Cómo agregar nuevos lotes

1. En el Registro, crea un lote nuevo (ej. `laser-lot-0003` o `pavonado-lot-0003`).
2. Asigna proceso (Láser o Pavonado).
3. Ese lote aparecerá en los reportes según su proceso.

## 8) Cierre de Mes (Todo)

- Botón verde en **Acciones**.
- Qué hace: borra piezas de `LOTES` y de lotes Láser/Pavonado; borra métricas láser/pavonado; **no borra los lotes**.
- Pasos: clic → confirmar → ingresa la contraseña (la que esté en `.env` como `RESET_PASSWORD`) → espera el aviso y recarga.
- Protección extra: guarda un “corte” de fecha para que nada anterior al cierre se reimporte solo.

## 9) Copias de seguridad

- **Exportar**: genera un archivo JSON con todo. Úsalo antes de cambios grandes o cierres.
- **Importar**: restaura un backup exportado.

## 10) Consejos rápidos

- Siempre arranca con `INICIAR_LASER_CONTROL.bat` para usar el servidor actualizado.
- Si notas datos “viejos” tras un cierre, repite el cierre y verifica que el botón responda 200 OK (ya está probado).
- Mantén la contraseña (`RESET_PASSWORD`) en `.env` y cámbiala si la dejas de fábrica.

¡Listo! Con estos pasos puedes operar día a día: agregar/editar piezas, capturar métricas, generar reportes y ejecutar el cierre mensual cuando toque.
