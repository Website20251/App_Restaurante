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
- Datos en `%APPDATA%\Restaurante\data\db.json` (hacer copia de respaldo).
