// scripts/fetch-uv.mjs — stage the uv binary for bundling.
//
// uv (astral-sh) manages its own Python: `uv python install` downloads a
// standalone interpreter, so the portable app no longer needs python.org,
// PATH checkboxes, or a system Python at all. Single ~15MB binary, fetched
// once here and shipped in bin/ via the package.json files list, where
// main.js resolves it as __dirname/bin/uv(.exe).
//
// Keep UV_VER in sync with install-deps.bat. Idempotent: skips when
// bin/uv.exe already exists. Windows-only download; other platforms warn
// and continue (system python + pip path applies there).
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const UV_VER = "0.12.21";
const UV_ZIP = `uv-x86_64-pc-windows-msvc.zip`;
const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VER}/${UV_ZIP}`;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binDir = path.join(root, "bin");
const destExe = path.join(binDir, "uv.exe");

if (fs.existsSync(destExe)) {
  console.log("fetch-uv: bin/uv.exe already staged — skipping download.");
  process.exit(0);
}

if (process.platform !== "win32") {
  console.log("fetch-uv: WARNING: uv staging is Windows-only here; pack continues without a bundled uv (system-python path applies).");
  process.exit(0);
}

const zipPath = path.join(os.tmpdir(), "uv-openbook-pack.zip");
const dlDir = path.join(os.tmpdir(), "uv-openbook-pack");
console.log(`fetch-uv: downloading uv ${UV_VER} (~15MB) ...`);
const dl = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -UserAgent 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' -Uri '${UV_URL}' -OutFile '${zipPath}'`,
  ],
  { stdio: "inherit" }
);
if (dl.status !== 0 || !fs.existsSync(zipPath)) {
  throw new Error(`fetch-uv: download failed — check network and ${UV_VER}.`);
}

console.log("fetch-uv: extracting uv.exe ...");
fs.rmSync(dlDir, { recursive: true, force: true });
fs.mkdirSync(dlDir, { recursive: true });
const unz = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${dlDir}' -Force`,
  ],
  { stdio: "inherit" }
);
try {
  fs.unlinkSync(zipPath);
} catch (_) {}
if (unz.status !== 0) {
  throw new Error("fetch-uv: extraction failed.");
}
const staged = path.join(dlDir, "uv-x86_64-pc-windows-msvc", "uv.exe");
const flat = path.join(dlDir, "uv.exe");
const src = fs.existsSync(staged) ? staged : flat;
if (!fs.existsSync(src)) {
  throw new Error("fetch-uv: uv.exe not found inside the downloaded zip.");
}
fs.mkdirSync(binDir, { recursive: true });
fs.copyFileSync(src, destExe);
fs.rmSync(dlDir, { recursive: true, force: true });

// Sanity: the staged binary must run headless.
try {
  execFileSync(destExe, ["--version"], { stdio: "ignore" });
} catch {
  throw new Error("fetch-uv: staged uv.exe does not run (--version failed).");
}
console.log("fetch-uv: staged bin/uv.exe OK.");
