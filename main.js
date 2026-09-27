const { app, BrowserWindow, dialog, Menu, shell } = require('electron');
const path = require('path');
const { spawn, execSync, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');

let mainWindow = null;
let pythonProcess = null;
const BACKEND_PORT = 5678;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const REQUIRED_MODULES = ['flask', 'chromadb', 'pypdf'];

// Data root: OPENBOOK_HOME env override, exe dir when packaged, repo root in dev.
function getDataRoot() {
  if (process.env.OPENBOOK_HOME) return process.env.OPENBOOK_HOME;
  if (app.isPackaged) return path.dirname(app.getPath('exe'));
  return __dirname;
}

// --- PYTHON PROCESS MANAGEMENT ---
function findBackendExecutable() {
  // PRODUCTION: use the bundled backend binary
  if (app.isPackaged) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    return { exe: path.join(process.resourcesPath, `backend${ext}`), args: [] };
  }

  // DEV: check if local virtual environment (venv or .venv) exists and use its python
  const script = path.join(__dirname, 'backend.py');
  const isWin = process.platform === 'win32';
  const localVenvs = ['venv', '.venv'];
  for (const venvDir of localVenvs) {
    const venvPython = isWin
      ? path.join(__dirname, venvDir, 'Scripts', 'python.exe')
      : path.join(__dirname, venvDir, 'bin', 'python');
    if (fs.existsSync(venvPython)) {
      return { exe: venvPython, args: [script] };
    }
  }

  // DEV FALLBACK: find system Python and run backend.py
  const candidates = isWin
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' });
      return { exe: cmd, args: [script] };
    } catch (_) {}
  }

  // Windows fallback: check common install paths
  if (isWin) {
    const bases = [
      `${process.env.LOCALAPPDATA}\\Programs\\Python`,
      'C:\\',
    ];
    const versions = ['Python313', 'Python312', 'Python311', 'Python310'];
    for (const base of bases) {
      for (const ver of versions) {
        const p = path.join(base, ver, 'python.exe');
        if (fs.existsSync(p)) return { exe: p, args: [script] };
      }
    }
  }

  return null;
}

// Verify backend imports resolve before spawn, so a missing dependency
// produces an actionable message instead of a dead window.
function preflight(pythonExe) {
  const probe = REQUIRED_MODULES.map((m) => `import ${m}`).join('; ');
  const result = spawnSync(pythonExe, ['-c', probe], {
    cwd: __dirname,
    encoding: 'utf8',
  });
  if (result.status === 0) return { ok: true, missing: [] };
  const stderr = result.stderr || '';
  const missing = [...new Set(
    stderr
      .split('\n')
      .filter((line) => line.includes('ModuleNotFoundError'))
      .map((line) => line.split(':').pop().trim().replace(/['"]/g, ''))
  )];
  return { ok: false, missing: missing.length > 0 ? missing : ['(unknown)'] };
}

function startPythonBackend() {
  const found = findBackendExecutable();

  if (!found) {
    dialog.showErrorBox(
      'Python Not Found',
      'Could not find Python on this system.\n\nPlease install Python from python.org and check "Add Python to PATH" during installation.'
    );
    app.quit();
    return;
  }

  const check = preflight(found.exe);
  if (!check.ok) {
    dialog.showErrorBox(
      'OpenBook — dependencies missing',
      `Using Python at:\n  ${found.exe}\n\nThese modules are not installed:\n  ${check.missing.join('\n  ')}\n\n` +
      'Fix it by running this in the OpenBook folder:\n' +
      '  install-deps.bat\n\n' +
      'Or manually:\n' +
      '  pip install -r requirements.txt'
    );
    app.quit();
    return;
  }

  const { exe, args } = found;

  if (app.isPackaged && process.platform !== 'win32') {
    try {
      fs.chmodSync(exe, '755');
      console.log(`[Electron] Set executable permissions on ${exe}`);
    } catch (err) {
      console.error(`[Electron] Failed to set executable permissions on ${exe}:`, err);
    }
  }

  pythonProcess = spawn(exe, args, {
    cwd: app.isPackaged ? app.getPath('userData') : __dirname,
    env: { ...process.env, OPENBOOK_HOME: getDataRoot(), PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  pythonProcess.on('error', (err) => {
    console.error(`[Electron] Failed to start Python backend:`, err);
    pythonProcess = null;
  });

  pythonProcess.stdout.on('data', (data) => {
    console.log(`[Python] ${data.toString().trim()}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error(`[Python ERR] ${data.toString().trim()}`);
  });

  pythonProcess.on('exit', (code) => {
    console.log(`[Python] Process exited with code ${code}`);
    pythonProcess = null;
  });

  console.log(`[Electron] Spawned backend: ${exe} (PID ${pythonProcess.pid})`);
}

function ensureBackendRunning() {
  if (!pythonProcess) {
    console.log('[Electron] Python process not running, restarting it...');
    startPythonBackend();
    return waitForBackend();
  }
  return Promise.resolve();
}

function killPythonBackend() {
  if (pythonProcess) {
    pythonProcess.kill();
    pythonProcess = null;
    console.log('[Electron] Python backend terminated.');
  }
}

// Poll until Flask is ready, then open the window
function waitForBackend(retries = 30, delay = 500) {
  return new Promise((resolve, reject) => {
    function attempt(n) {
      if (!pythonProcess) {
        return reject(new Error('Backend process died or failed to start.'));
      }
      const req = http.get(`${BACKEND_URL}/api/config`, (res) => {
        resolve();
      }).on('error', () => {
        if (n <= 0) {
          reject(new Error('Backend did not start in time.'));
        } else {
          setTimeout(() => attempt(n - 1), delay);
        }
      });
      req.setTimeout(1000, () => {
        req.destroy();
      });
    }
    attempt(retries);
  });
}

// --- WINDOW CREATION ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 14 } } : {}),
    backgroundColor: '#f2f4f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // External links open in the real browser instead of navigating the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- NATIVE MENU CREATION ---
function createApplicationMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(process.platform === 'darwin' ? [
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            label: 'Speech',
            submenu: [
              { role: 'startSpeaking' },
              { role: 'stopSpeaking' }
            ]
          }
        ] : [
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ])
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [
          { role: 'close' }
        ])
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// --- APP LIFECYCLE ---
app.whenReady().then(async () => {
  createApplicationMenu();
  startPythonBackend();

  try {
    await waitForBackend();
    console.log('[Electron] Backend ready.');
  } catch (e) {
    console.error('[Electron] Backend failed to start:', e.message);
  }

  createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        await ensureBackendRunning();
      } catch (e) {
        console.error('[Electron] Backend failed to restart on activation:', e.message);
      }
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    killPythonBackend();
    app.quit();
  }
});

app.on('before-quit', () => {
  killPythonBackend();
});

app.on('will-quit', () => {
  killPythonBackend();
});

module.exports = {
  findBackendExecutable,
  waitForBackend,
  getDataRoot,
  preflight,
  BACKEND_PORT,
  BACKEND_URL,
};
