# Sistema de pedidos para restaurante

Instalar: ejecutar `instalador\Instalar-Restaurante.exe`. Para desarrollo: `npm run server`.

## Usuarios y permisos
Cada persona entra con su usuario y contraseña propia.

| Rol | Puede abrir |
|---|---|
| Administrador | Todo (mesero, cocina, barra, caja, administración, conectar celulares) |
| Mesero | Solo /mesero.html |
| Cocina | Solo /cocina.html?e=cocina |
| Barra | Solo /cocina.html?e=barra |
| Caja | Solo /caja.html |

- Primer ingreso: usuarios migrados/nuevos tienen la clave temporal **1234** y el sistema obliga a cambiarla.
- El administrador crea, desactiva, borra usuarios y restablece claves en Administración > Usuarios.
- Cancelar un pedido ajeno o ya en preparación pide la contraseña de un administrador.
- Datos en `%APPDATA%\Restaurante\data\db.json`.

## Datos y respaldos
- **Respaldo automático**: una copia diaria en `data\backups\` (se conservan 14). Si `db.json` se daña, al arrancar se restaura la última copia.
- **Archivo**: los pedidos cobrados o cancelados de hace más de 60 días pasan a `data\archivo\pedidos-AAAA-MM.json` y siguen entrando en los reportes por rango de fechas.
- Las sesiones se guardan aparte en `sessions.json`, y al cerrar la aplicación se guarda todo lo pendiente.

## Caja y reportes
- **Descuentos**: hasta el % configurado caja decide sola; por encima pide la contraseña de un administrador y queda registrado quién autorizó y el motivo.
- **Pago dividido**: una cuenta se puede pagar con varios métodos (ej. mitad efectivo, mitad Yape).
- **Impuesto incluido**: en Ajustes se elige si los precios ya incluyen el impuesto o si se suma encima.
- **Día de trabajo**: empieza a la hora configurada (por defecto 4:00), así un turno que pasa de medianoche cuenta como un solo día.
- **Reportes**: Hoy / 7 / 30 días o rango de fechas, con descarga en CSV (se abre en Excel).
- **Pedidos**: se puede quitar un producto suelto de un pedido enviado (con autorización del administrador si ya está en preparación o es de otro mesero).
- **Categorías**: se crean, renombran y borran en Administración > Menú.

## Versión web (nube)
El mismo servidor funciona en internet. Variables de entorno:

| Variable | Para qué |
|---|---|
| `PORT` | Puerto (la mayoría de hostings lo ponen solos) |
| `RESTAURANTE_DATA` | Carpeta de datos. **Debe ser un disco persistente**, si no se pierden los pedidos al reiniciar |
| `TRUST_PROXY=1` | Detrás de un proxy HTTPS: usa la IP real del cliente y marca la cookie como `Secure` |
| `ADMIN_PASSWORD` | Solo en la primera ejecución: crea únicamente al administrador con esta clave temporal (se obliga a cambiarla) y oculta la lista de usuarios en el login |
| `PUBLIC_URL` | (opcional) dirección pública, p. ej. `https://mi-restaurante.com`, para el QR de "Conectar celulares" |

Con Docker: `docker build -t restaurante .` y `docker run -p 3000:3000 -v restaurante-data:/data -e ADMIN_PASSWORD=ClaveInicial1 restaurante`.
En Render/Railway/Fly: usar el `Dockerfile`, montar un volumen en `/data` y definir `ADMIN_PASSWORD`. Usar **una sola instancia**.
Comprobación de salud: `/healthz`. Los tickets se imprimen con el diálogo de impresión del navegador.
La app de escritorio (Electron) sigue funcionando igual; el respaldo anterior está en `..\App_Restaurante_respaldo_escritorio`.

### AWS (Lightsail o EC2)
1. Crea una instancia Ubuntu 22.04/24.04 (Lightsail: plan de 1–2 GB) y asígnale una **IP estática**. En el firewall abre los puertos **80 y 443** (el 22 solo para ti).
2. Apunta un dominio o subdominio (registro A) a esa IP. Sin dominio no hay HTTPS automático.
3. Conéctate por SSH e instala Docker: `curl -fsSL https://get.docker.com | sh`
4. Copia el proyecto al servidor (`git clone` o `scp`, sin `node_modules`).
5. Crea `.env` junto a `docker-compose.yml`:
   ```
   DOMAIN=pedidos.tudominio.com
   ADMIN_PASSWORD=UnaClaveTemporalLarga1
   ```
6. `docker compose up -d --build`. Entra a `https://pedidos.tudominio.com` como `Administrador`.
7. Activa **snapshots automáticos** del disco (Lightsail: Snapshots) además de los respaldos diarios de la app, que viven en el mismo disco.
Para actualizar: `git pull && docker compose up -d --build` (los datos están en el volumen y no se pierden).
