// Aplicación de escritorio: arranca el servidor interno y lo muestra en una ventana.
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');

process.env.PORT = process.env.PORT || '3000';
// Los datos van a la carpeta del usuario, así sobreviven a actualizaciones del programa.
process.env.RESTAURANTE_DATA = path.join(app.getPath('userData'), 'data');

const URL = `http://localhost:${process.env.PORT}`;
let main;

function open(pathname, opts = {}) {
  const w = new BrowserWindow({
    width: 1280, height: 800, backgroundColor: '#f3f5f8', autoHideMenuBar: false, ...opts,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  w.loadURL(URL + pathname);
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(URL)) return { action: 'allow' };
    shell.openExternal(url); return { action: 'deny' };
  });
  return w;
}

function buildMenu() {
  const go = p => () => BrowserWindow.getFocusedWindow()?.loadURL(URL + p);
  const win = (p, o) => () => open(p, o);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Pantallas', submenu: [
      { label: 'Inicio', click: go('/') },
      { label: 'Mesero', click: go('/mesero.html') },
      { label: 'Cocina', click: go('/cocina.html?e=cocina') },
      { label: 'Barra', click: go('/cocina.html?e=barra') },
      { label: 'Caja', click: go('/caja.html') },
      { label: 'Administración', click: go('/admin.html') },
      { type: 'separator' },
      { label: '📱 Conectar celulares / tablets (IP y QR)', accelerator: 'CmdOrCtrl+K', click: go('/conectar.html') },
    ] },
    { label: 'Nueva ventana', submenu: [
      { label: 'Cocina (otra ventana)', click: win('/cocina.html?e=cocina') },
      { label: 'Barra (otra ventana)', click: win('/cocina.html?e=barra') },
      { label: 'Mesero (otra ventana)', click: win('/mesero.html') },
      { label: 'Caja (otra ventana)', click: win('/caja.html') },
    ] },
    { label: 'Ver', submenu: [
      { role: 'togglefullscreen', label: 'Pantalla completa' },
      { role: 'zoomIn', label: 'Acercar' }, { role: 'zoomOut', label: 'Alejar' }, { role: 'resetZoom', label: 'Zoom normal' },
      { role: 'reload', label: 'Recargar' },
    ] },
  ]));
}

// Una sola instancia: si ya está abierta, se enfoca esa.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (main) { if (main.isMinimized()) main.restore(); main.focus(); } });
  app.whenReady().then(() => {
    require('./ticket-ipc.js').register({ ipcMain, app, shell, baseUrl: URL + '/' });
    const srv = require('./server.js'); // levanta HTTP + tiempo real; también sirve a celulares/tablets en la red local
    app.on('before-quit', () => srv.flush()); // no perder el último cambio al cerrar
    buildMenu();
    setTimeout(() => { main = open('/'); main.maximize(); }, 400);
  });
  app.on('window-all-closed', () => app.quit());
}
