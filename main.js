const { app, BrowserWindow, dialog, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const { spawn, execSync, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');

let mainWindow = null;
let pythonProcess = null;
let setupMode = false;
let installerRunning = false;
const BACKEND_PORT = 5678;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const REQUIRED_MODULES = ['flask', 'chromadb', 'pypdf', 'fitz', 'pytesseract', 'PIL'];

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

// --- SETUP-MODE PYTHON (dev + portable Phase-1: run backend.py directly) ---
// findBackendExecutable() prefers a bundled backend.exe that only exists
// after a Phase-2 pyinstaller build. These helpers resolve a script-capable
// Python instead, so missing deps can be installed from inside the app.
function findSystemPython() {
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' });
      return cmd;
    } catch (_) {}
  }

  if (isWin) {
    const bases = [
      `${process.env.LOCALAPPDATA}\\Programs\\Python`,
      'C:\\',
    ];
    const versions = ['Python313', 'Python312', 'Python311', 'Python310'];
    for (const base of bases) {
      for (const ver of versions) {
        const p = path.join(base, ver, 'python.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  }

  return null;
}

function findScriptPython() {
  const isWin = process.platform === 'win32';
  const venvBase = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
  for (const venvDir of ['.venv', 'venv']) {
    const p = isWin
      ? path.join(venvBase, venvDir, 'Scripts', 'python.exe')
      : path.join(venvBase, venvDir, 'bin', 'python');
    if (fs.existsSync(p)) return p;
  }
  return findSystemPython();
}

function backendBinaryExists() {
  if (!app.isPackaged) return false;
  const ext = process.platform === 'win32' ? '.exe' : '';
  return fs.existsSync(path.join(process.resourcesPath, `backend${ext}`));
}

// State for the setup screen (preload SETUP bridge): which Python would
// run backend.py, and whether its imports already resolve.
function getSetupState() {
  const exe = findScriptPython();
  if (!exe) return { python: null, ok: false, missing: [], ocr: ocrStatus() };
  const check = preflight(exe);
  return { python: exe, ok: check.ok, missing: check.missing, ocr: ocrStatus() };
}

// Tesseract native binary status for the setup screen: explicit override,
// app-bundled copy (exe dir when packaged), then PATH. Mirrors the
// backend's _tesseract_cmd() resolution without importing Python.
function ocrStatus() {
  const env = process.env.TESSERACT_CMD;
  if (env && fs.existsSync(env)) return { available: true, cmd: env };
  const bundled = bundledTesseract();
  if (bundled) return { available: true, cmd: bundled };
  if (ocrOnPath()) return { available: true, cmd: 'tesseract (PATH)' };
  return { available: false, cmd: null };
}

function bundledTesseract() {
  const root = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
  for (const c of [path.join(root, 'tesseract', 'tesseract.exe'), path.join(root, 'tesseract', 'bin', 'tesseract.exe')]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function ocrOnPath() {
  try {
    execSync('tesseract --version', { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function startPythonBackend() {
  let exe;
  let args;
  let cwd;

  if (backendBinaryExists()) {
    // Phase-2 onefile build: the bundled binary needs no preflight (-c
    // would fail against it, so it is deliberately skipped here).
    const ext = process.platform === 'win32' ? '.exe' : '';
    exe = path.join(process.resourcesPath, `backend${ext}`);
    args = [];
    cwd = app.getPath('userData');
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(exe, '755');
        console.log(`[Electron] Set executable permissions on ${exe}`);
      } catch (err) {
        console.error(`[Electron] Failed to set executable permissions on ${exe}:`, err);
      }
    }
  } else {
    // Dev + portable Phase-1: run backend.py with a script-capable Python.
    exe = findScriptPython();
    if (!exe) {
      dialog.showErrorBox(
        'Python Not Found',
        'Could not find Python on this system.\n\nPlease install Python from python.org and check "Add Python to PATH" during installation.'
      );
      app.quit();
      return;
    }
    const check = preflight(exe);
    if (!check.ok) {
      // No fatal quit: the window opens in setup mode with an
      // Install-dependencies button (SETUP bridge) instead.
      setupMode = true;
      console.log(`[Electron] Dependencies missing for ${exe}: ${check.missing.join(', ')} — entering setup mode.`);
      return;
    }
    args = [path.join(__dirname, 'backend.py')];
    cwd = app.isPackaged ? app.getPath('userData') : __dirname;
  }

  pythonProcess = spawn(exe, args, {
    cwd,
    env: { ...process.env, OPENBOOK_HOME: getDataRoot(), PYTHONUNBUFFERED: '1' },
    windowsHide: true,
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
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          res.resume();
          if (n <= 0) {
            reject(new Error('Backend did not start in time.'));
          } else {
            setTimeout(() => attempt(n - 1), delay);
          }
        }
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

// --- IN-APP DEPENDENCY INSTALLER (setup mode) ---
// Mirrors install-deps.bat so the portable dist can self-repair: creates
// .venv next to the app (exe dir when packaged) and pip-installs
// requirements.txt, streaming pip output to the setup screen.
function spawnStep(cmd, args, cwd, emit) {
  return new Promise((resolve) => {
    emit(`$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    child.stdout.on('data', (d) => emit(d.toString().trimEnd()));
    child.stderr.on('data', (d) => emit(d.toString().trimEnd()));
    child.on('error', (e) => {
      emit(`ERROR: failed to launch ${cmd}: ${e.message}`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code == null ? 1 : code));
  });
}

function runInstaller(event) {
  if (installerRunning) return Promise.resolve({ code: 2, error: 'install already running' });
  installerRunning = true;
  const emit = (line) => {
    try {
      event.sender.send('openbook:install-progress', String(line));
    } catch (_) {}
  };
  const base = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
  const isWin = process.platform === 'win32';
  const venvPath = path.join(base, '.venv');
  const venvPy = isWin
    ? path.join(venvPath, 'Scripts', 'python.exe')
    : path.join(venvPath, 'bin', 'python');
  const requirements = path.join(__dirname, 'requirements.txt');

  return (async () => {
    if (!fs.existsSync(requirements)) {
      emit('ERROR: requirements.txt not found next to the app.');
      return { code: 1 };
    }
    let py = fs.existsSync(venvPy) ? venvPy : findSystemPython();
    if (!py) {
      emit('ERROR: no system Python found — install Python 3.11+ first.');
      return { code: 1 };
    }
    if (!fs.existsSync(venvPy)) {
      emit('Creating virtual environment in .venv ...');
      const code = await spawnStep(py, ['-m', 'venv', '.venv'], base, emit);
      if (code !== 0 || !fs.existsSync(venvPy)) {
        emit('ERROR: could not create the virtual environment.');
        return { code: 1 };
      }
      py = venvPy;
    }
    emit('Upgrading pip ...');
    await spawnStep(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], base, emit);
    emit('Installing OpenBook libraries (torch is a ~4GB download) ...');
    const code = await spawnStep(py, ['-m', 'pip', 'install', '-r', requirements], base, emit);
    if (code !== 0) {
      emit('ERROR: installation failed — see output above.');
      return { code, ocrAvailable: false };
    }
    const ocrAvailable = await installTesseract(base, emit);
    emit('Done. Starting the study engine ...');
    return { code: 0, ocrAvailable };
  })().finally(() => {
    installerRunning = false;
  });
}

// Pinned UB Mannheim build, mirroring install-deps.bat. Bumped by editing
// the version in both places.
const TESSERACT_VER = '5.5.0.20241110';
const TESSERACT_URL =
  `https://github.com/UB-Mannheim/tesseract/releases/download/${TESSERACT_VER}/tesseract-ocr-w64-setup-${TESSERACT_VER}.exe`;

// Tesseract native binary for scanned-PDF OCR. Skips when bundled or on
// PATH; downloads + silent-installs into <app>/tesseract on Windows only
// (other platforms get the brew/apt hint). Returns true when OCR is usable.
function installTesseract(base, emit) {
  return (async () => {
    if (bundledTesseract()) {
      emit('Tesseract already present — skipping download.');
      return true;
    }
    if (ocrOnPath()) {
      emit('Tesseract found on PATH — skipping download.');
      return true;
    }
    if (process.platform !== 'win32') {
      emit('NOTE: automatic Tesseract download is Windows-only.');
      emit('  macOS: brew install tesseract | Ubuntu/Debian: sudo apt install tesseract-ocr');
      return false;
    }
    const os = require('os');
    const setupExe = path.join(os.tmpdir(), 'tesseract-setup-openbook.exe');
    emit(`Downloading Tesseract ${TESSERACT_VER} installer (~50MB) ...`);
    const dl = await spawnStep(
      'powershell.exe',
      ['-NoProfile', '-Command', `Invoke-WebRequest -Uri '${TESSERACT_URL}' -OutFile '${setupExe}'`],
      base,
      emit
    );
    if (dl !== 0 || !fs.existsSync(setupExe)) {
      emit('WARNING: Tesseract download failed — scanned PDFs will be rejected. See docs/troubleshooting.md.');
      return false;
    }
    emit('Installing Tesseract into tesseract\\ ...');
    const inst = await spawnStep(
      setupExe,
      ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${path.join(base, 'tesseract')}`],
      base,
      emit
    );
    try {
      fs.unlinkSync(setupExe);
    } catch (_) {}
    if (inst !== 0 || !bundledTesseract()) {
      emit('WARNING: Tesseract installer failed — scanned PDFs will be rejected. See docs/troubleshooting.md.');
      return false;
    }
    emit('Tesseract installed.');
    return true;
  })();
}

function registerSetupIpc() {
  ipcMain.handle('openbook:deps-status', () => getSetupState());
  ipcMain.handle('openbook:install-deps', (event) => runInstaller(event));
  ipcMain.handle('openbook:start-backend', async () => {
    setupMode = false;
    startPythonBackend();
    if (setupMode) return { ok: false, error: 'dependencies still missing' };
    if (!pythonProcess) return { ok: false, error: 'backend process failed to spawn' };
    try {
      await waitForBackend();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

// --- APP LIFECYCLE ---
app.whenReady().then(async () => {
  createApplicationMenu();
  registerSetupIpc();
  startPythonBackend();

  if (!setupMode) {
    try {
      await waitForBackend();
      console.log('[Electron] Backend ready.');
    } catch (e) {
      console.error('[Electron] Backend failed to start:', e.message);
    }
  } else {
    console.log('[Electron] Setup mode — window will offer dependency install.');
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
  findScriptPython,
  findSystemPython,
  backendBinaryExists,
  getSetupState,
  ocrStatus,
  waitForBackend,
  getDataRoot,
  preflight,
  BACKEND_PORT,
  BACKEND_URL,
};
