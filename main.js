const { app, BrowserWindow, dialog, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const { spawn, execSync, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');

let mainWindow = null;
let pythonProcess = null;
// false = boot normally, 'deps' = pip modules missing (blocks boot and shows
// the setup screen). OCR is EasyOCR, so a missing engine is just a missing
// dependency and needs no separate gate.
let setupMode = false;
let installerRunning = false;
const BACKEND_PORT = 5678;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
// OCR runs on EasyOCR (pure Python), so its import is part of the same
// preflight gate as the rest — a missing engine is just a missing dep.
const REQUIRED_MODULES = ['flask', 'chromadb', 'pypdf', 'fitz', 'easyocr'];

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
//
// One interpreter launch classifies every module: OK, MISSING (never
// installed), or CRASH (present but raises on import — e.g. chromadb
// without onnxruntime, which dies with ValueError, not ImportError).
// A plain `import a; import b; ...` probe cannot tell those apart, and the
// difference decides the fix, so the classification lives here.
function preflight(pythonExe) {
  const script =
    "import traceback\n" +
    "mods = " + JSON.stringify(REQUIRED_MODULES) + "\n" +
    "for _m in mods:\n" +
    "    try:\n" +
    "        __import__(_m)\n" +
    "        print('OK ' + _m)\n" +
    "    except ModuleNotFoundError as _e:\n" +
    "        _lines = str(_e).splitlines()\n" +
    "        print('MISSING ' + _m + (' :: ' + _lines[0] if _lines else ''))\n" +
    "    except Exception:\n" +
    "        print('CRASH ' + _m)\n" +
    "        traceback.print_exc(limit=3)\n";
  let result;
  try {
    result = spawnSync(pythonExe, ['-c', script], {
      cwd: __dirname,
      encoding: 'utf8',
    });
  } catch (e) {
    // The interpreter itself could not be launched (deleted venv, AV
    // quarantine, broken exe) — distinct from a missing module.
    return { ok: false, missing: ['(unlaunchable)'], err: String((e && e.message) || e) };
  }
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || result.error || '');
  const missing = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (t.startsWith('MISSING ')) {
      const name = t.slice('MISSING '.length).split(' ::')[0].trim();
      if (name) missing.push(name);
    } else if (t.startsWith('CRASH ')) {
      const name = t.slice('CRASH '.length).trim();
      if (name) missing.push(`${name} (crash)`);
    }
  }
  const seen = REQUIRED_MODULES.filter(
    (m) => stdout.split('\n').some((l) => l.trim() === `OK ${m}`)
  );
  const silent = REQUIRED_MODULES.filter((m) => !seen.includes(m) && !missing.some((x) => x === m || x.startsWith(`${m} `)));
  for (const m of silent) missing.push(`${m} (no result)`);
  if (missing.length === 0) return { ok: true, missing: [] };
  const tail = stderr
    .trim()
    .split('\n')
    .slice(-4)
    .join(' | ');
  return { ok: false, missing: [...new Set(missing)], err: tail };
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
  const uv = bundledUv();
  if (!exe) return { python: null, ok: false, missing: [], setupReason: 'deps', uv: !!uv };
  const check = preflight(exe);
  return {
    python: exe,
    ok: check.ok,
    missing: check.missing,
    setupReason: check.ok ? null : 'deps',
    uv: !!uv,
  };
}

// uv ships in bin/ (staged by scripts/fetch-uv.mjs) and fetches its own
// Python, so a machine with no system Python can still self-install.
function bundledUv() {
  const name = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const p = path.join(__dirname, 'bin', name);
  return fs.existsSync(p) ? p : null;
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
      if (bundledUv()) {
        // No system Python, but uv can fetch one: setup screen instead of
        // the fatal quit — the installer bootstraps everything itself.
        setupMode = 'deps';
        console.log('[Electron] No system Python — uv will fetch it; entering setup mode.');
        return;
      }
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
      // Install-dependencies button (SETUP bridge) instead. A missing
      // EasyOCR lands here too — it is just another pip dependency.
      setupMode = 'deps';
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
function progressSender(event) {
  return (line) => {
    try {
      event.sender.send('openbook:install-progress', String(line));
    } catch (_) {}
  };
}

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
  const emit = progressSender(event);
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
    let py = fs.existsSync(venvPy) ? venvPy : null;
    const uv = bundledUv();
    let useUv = !!uv;
    if (!py && useUv) {
      // No venv yet and uv is bundled: fetch a private Python and create
      // the venv with it. No system Python, PATH edits, or python.org visit.
      emit('Fetching Python 3.11 (no system Python needed) ...');
      if ((await spawnStep(uv, ['python', 'install', '3.11'], base, emit)) !== 0) {
        emit('WARNING: uv could not fetch Python — falling back to system Python.');
        useUv = false;
      } else {
        emit('Creating virtual environment in .venv ...');
        const vc = await spawnStep(uv, ['venv', '.venv', '--python', '3.11'], base, emit);
        if (vc !== 0 || !fs.existsSync(venvPy)) {
          emit('WARNING: uv venv failed — falling back to system Python.');
          useUv = false;
        } else {
          py = venvPy;
        }
      }
    }
    if (!py) {
      py = findSystemPython();
      if (!py) {
        emit('ERROR: no Python available — install Python 3.11+ first.');
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
    }
    let code;
    if (useUv) {
      // uv pip targets the venv interpreter directly — no activation needed.
      emit('Installing OpenBook libraries via uv (torch is a ~4GB download) ...');
      code = await spawnStep(uv, ['pip', 'install', '--python', venvPy, '-r', requirements], base, emit);
    } else {
      emit('Upgrading pip ...');
      await spawnStep(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], base, emit);
      emit('Installing OpenBook libraries (torch is a ~4GB download) ...');
      code = await spawnStep(py, ['-m', 'pip', 'install', '-r', requirements], base, emit);
    }
    if (code !== 0) {
      emit('ERROR: installation failed — see output above.');
      return { code };
    }
    // Verify before claiming success: pip reporting "satisfied" while the
    // interpreter still fails its imports is exactly the state that used
    // to surface later as a bare "dependencies still missing".
    emit('Verifying imports ...');
    let verify = preflight(venvPy);
    const onnxSuspect =
      !verify.ok &&
      (verify.missing.some((m) => m.startsWith('chromadb')) ||
        (verify.err || '').toLowerCase().includes('onnxruntime'));
    if (onnxSuspect) {
      // Known shape: chromadb raises ValueError (not ImportError) when its
      // onnxruntime extra is absent, even though pip considered everything
      // satisfied. Retry that one package through the venv's own pip — an
      // unambiguous target, unlike uv's interpreter resolution.
      emit('Chromadb import crashes without onnxruntime — installing it explicitly ...');
      const rc = await spawnStep(venvPy, ['-m', 'pip', 'install', 'onnxruntime'], base, emit);
      if (rc === 0) verify = preflight(venvPy);
    }
    if (!verify.ok) {
      emit(`WARNING: install finished but these still fail to import: ${verify.missing.join(', ')}`);
      if (verify.err) emit(verify.err);
      return { code: 1 };
    }
    emit('Done. Starting the study engine ...');
    return { code: 0 };
  })().finally(() => {
    installerRunning = false;
  });
}

function registerSetupIpc() {
  ipcMain.handle('openbook:deps-status', () => getSetupState());
  ipcMain.handle('openbook:install-deps', (event) => runInstaller(event));
  ipcMain.handle('openbook:start-backend', async () => {
    // Post-install pass-through: the deps gate still applies, so a failed
    // pip run cannot slip through into a dead backend.
    setupMode = false;
    startPythonBackend();
    if (setupMode) {
      // Name the missing modules: without this the setup log proves pip
      // succeeded while the engine still refuses to start, and nobody can
      // tell which import is actually failing.
      let detail = '';
      const exe = findScriptPython();
      if (exe) {
        const recheck = preflight(exe);
        if (!recheck.ok && recheck.missing.length) {
          detail = `: ${recheck.missing.join(', ')}`;
          if (recheck.err && (recheck.missing[0] === '(unknown)' || recheck.missing[0] === '(unlaunchable)')) {
            detail += ` — ${recheck.err}`;
          }
        }
      }
      return { ok: false, error: `dependencies still missing${detail}` };
    }
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
    console.log(`[Electron] Setup mode (${setupMode}) — window will offer setup actions.`);
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
  bundledUv,
  getSetupState,
  waitForBackend,
  getDataRoot,
  preflight,
  BACKEND_PORT,
  BACKEND_URL,
};
