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
