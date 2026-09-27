// scripts/check-main.mjs — load main.js under a stubbed Electron and drive
// the real setup IPC handlers.
//
// `node --check main.js` only parses, so it happily accepts a function that
// is called but never defined (a ReferenceError at runtime, in the install
// path, where nobody is watching). This harness requires the module, runs
// the app-ready path, then invokes each IPC handler for real.
import { createRequire } from "module";
import assert from "assert";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// --- stub electron before main.js loads -------------------------------------
const handlers = new Map();
let readyResolve;
const readyPromise = new Promise((r) => {
  readyResolve = r;
});

const electronStub = {
  app: {
    isPackaged: false,
    whenReady: () => readyPromise,
    on: () => {},
    quit: () => {},
    getPath: () => path.join(root, ".tmp-check-main"),
    getVersion: () => "0.1.0",
    name: "OpenBook",
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
    constructor() {
      this.webContents = { setWindowOpenHandler() {} };
    }
    loadFile() {}
    once() {}
    on() {}
    show() {}
  },
  dialog: { showErrorBox() {} },
  Menu: { buildFromTemplate: (t) => t, setApplicationMenu() {} },
  shell: { openExternal() {} },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
  },
};

const realElectron = require("electron");
require.cache[require.resolve("electron")] = { id: "electron", filename: "electron", loaded: true, exports: electronStub };

// --- stub child_process.spawn so the installer never really runs pip -------
const childProc = require("child_process");
const realSpawn = childProc.spawn;
childProc.spawn = (cmd, args) => {
  const handlers = { stdout: null, stderr: null, error: null, exit: null };
  const child = {
    stdout: { on() {} },
    stderr: { on() {} },
    on(evt, fn) {
      handlers[evt] = fn;
      if (evt === "exit") setImmediate(() => fn(0));
    },
    kill() {},
  };
  return child;
};

// --- load main.js and run the app-ready path -------------------------------
const main = require(path.join(root, "main.js"));
readyResolve();
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));

// Every helper main.js calls must be defined — this is the regression that
// `node --check` cannot see.
for (const fn of ["findBackendExecutable", "findScriptPython", "findSystemPython", "backendBinaryExists", "getSetupState", "waitForBackend", "getDataRoot", "preflight"]) {
  assert.strictEqual(typeof main[fn], "function", `main.js must export ${fn}`);
}
assert.ok(
  main.getSetupState && typeof main.getSetupState() === "object",
  "getSetupState() must return an object"
);

// --- exercise the real IPC handlers ----------------------------------------
for (const channel of ["openbook:deps-status", "openbook:install-deps", "openbook:start-backend"]) {
  assert.ok(handlers.has(channel), `IPC channel ${channel} must be registered`);
}

const status = await handlers.get("openbook:deps-status")();
assert.ok(status && typeof status === "object", "deps-status must return an object");
assert.ok("ok" in status && "setupReason" in status, "deps-status must report ok + setupReason");

// Install path: exercise progressSender + spawnStep for real. The stubbed
// spawn reports success, so the installer proceeds to the venv step and then
// reports that no venv exists — a fast, deterministic end state.
const lines = [];
const fakeEvent = { sender: { send: (_ch, line) => lines.push(String(line)) } };
const result = await handlers.get("openbook:install-deps")(fakeEvent);
assert.ok(result && typeof result.code === "number", "install-deps must resolve with a numeric code");
assert.ok(lines.length > 0, "install-deps must stream progress lines");
// A ReferenceError inside the handler rejects the promise; reaching here
// means the whole chain ran.
assert.ok(
  lines.some((l) => l.includes("virtual environment") || l.includes("ERROR") || l.includes("$")),
  `expected real installer output, got: ${JSON.stringify(lines.slice(0, 4))}`
);

childProc.spawn = realSpawn;
console.log(`check-main: PASS — ${handlers.size} IPC channels, install streamed ${lines.length} line(s)`);
