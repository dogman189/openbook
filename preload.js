// preload.js — context bridge between renderer and Node
const { contextBridge, ipcRenderer } = require('electron');

// Expose the backend URL to the renderer safely
contextBridge.exposeInMainWorld('APP_CONFIG', {
  backendUrl: 'http://127.0.0.1:5678',
  platform: process.platform,
});

// Setup-mode bridge: dependency status + in-app installer. The backend
// itself cannot serve these (it may not even import), so they go over IPC
// to the Electron main process, which owns the Python install.
contextBridge.exposeInMainWorld('SETUP', {
  getStatus: () => ipcRenderer.invoke('openbook:deps-status'),
  installDeps: () => ipcRenderer.invoke('openbook:install-deps'),
  onProgress: (cb) => ipcRenderer.on('openbook:install-progress', (_event, line) => cb(line)),
  startBackend: () => ipcRenderer.invoke('openbook:start-backend'),
});

// macOS traffic-light button offset — apply class before page renders
if (process.platform === 'darwin') {
  document.documentElement.classList.add('is-mac');
}
