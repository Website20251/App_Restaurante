// Puente mínimo y seguro entre la página y la app de escritorio.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  saveTicketPdf: (base64, name, opts) => ipcRenderer.invoke('save-ticket', base64, name, opts),
});
