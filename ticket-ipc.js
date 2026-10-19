// Guardado de tickets en PDF desde la app de escritorio.
// La ventana (página web local) pide guardar el PDF; aquí se escribe en Documentos\Restaurante\Tickets
// y, en Windows, se deja copiado en el portapapeles como archivo para pegarlo (Ctrl+V) en el chat de WhatsApp.
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

function register({ ipcMain, app, shell, baseUrl }) {
  ipcMain.handle('save-ticket', async (event, b64, name, opts = {}) => {
    // Solo la propia aplicación (página servida desde este equipo) puede escribir archivos.
    if (!String(event.senderFrame && event.senderFrame.url || '').startsWith(baseUrl)) throw new Error('Origen no permitido');
    const buf = Buffer.from(String(b64), 'base64');
    if (buf.length < 100 || buf.length > 2000000 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('PDF inválido');
    const safe = String(name || 'ticket').replace(/\.pdf$/i, '').replace(/[^\w\- ]/g, '_').slice(0, 60) + '.pdf';
    const dir = path.join(app.getPath('documents'), 'Restaurante', 'Tickets');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safe);
    fs.writeFileSync(file, buf);

    let copied = false;
    if (opts.copy && process.platform === 'win32') {
      // Set-Clipboard -LiteralPath copia el archivo igual que el Explorador (se puede pegar en WhatsApp).
      copied = await new Promise(resolve => execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -LiteralPath $env:TICKET_FILE'],
        { env: { ...process.env, TICKET_FILE: file }, windowsHide: true, timeout: 8000 }, err => resolve(!err)));
    }
    if (opts.reveal) shell.showItemInFolder(file);
    return { path: file, copied };
  });
}

module.exports = { register };
