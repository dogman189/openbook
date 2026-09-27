@echo off
REM OpenBook dependency installer.
REM Creates a local .venv next to this script and installs the Python libraries.
REM CUDA (NVIDIA) torch is pinned in requirements.txt and is a ~4.2GB download.
REM On a machine with no NVIDIA GPU, edit requirements.txt first and replace
REM     torch==2.14.0+cu126
REM with
REM     torch==2.14.0
REM to pull the much smaller CPU-only wheel (~200MB, slower inference).

setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Python was not found on this machine.
  echo Install Python 3.11+ from https://www.python.org/downloads/
  echo and tick "Add Python to PATH" during setup, then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo Creating virtual environment in .venv ...
python -m venv .venv
if errorlevel 1 (
  echo ERROR: could not create the virtual environment.
  pause
  exit /b 1
)

echo.
echo Upgrading pip ...
.venv\Scripts\python.exe -m pip install --upgrade pip

echo.
echo Installing OpenBook libraries (this downloads torch, ~4.2GB) ...
echo Press Ctrl+C to cancel.
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo ERROR: installation failed. Scroll up for the failing package.
  pause
  exit /b 1
)

echo.
echo Checking for Tesseract OCR (needed for scanned PDFs) ...
if exist "tesseract\tesseract.exe" (
  echo Tesseract already present in tesseract\ - skipping download.
  goto :skip_tesseract
)
where tesseract >nul 2>nul
if not errorlevel 1 (
  echo Tesseract found on PATH - skipping download.
  goto :skip_tesseract
)
set TESSERACT_VER=5.5.0.20241110
set TESSERACT_URL=https://github.com/UB-Mannheim/tesseract/releases/download/%TESSERACT_VER%/tesseract-ocr-w64-setup-%TESSERACT_VER%.exe
set TESSERACT_EXE=%TEMP%\tesseract-setup-openbook.exe
echo Downloading Tesseract %TESSERACT_VER% installer (~50MB) ...
powershell -NoProfile -Command "Invoke-WebRequest -Uri '%TESSERACT_URL%' -OutFile '%TESSERACT_EXE%'"
if errorlevel 1 (
  echo WARNING: Tesseract download failed. Scanned PDFs will be rejected until Tesseract is installed.
  echo See docs\troubleshooting.md for manual setup.
  goto :skip_tesseract
)
echo Installing Tesseract into tesseract\ ...
"%TESSERACT_EXE%" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="%~dp0tesseract"
if errorlevel 1 (
  echo WARNING: Tesseract installer failed. Scanned PDFs will be rejected until Tesseract is installed.
  echo See docs\troubleshooting.md for manual setup.
)
del "%TESSERACT_EXE%" >nul 2>nul
:skip_tesseract

echo.
echo Done. Open OpenBook.exe - it will use .venv automatically.
echo.
pause
endlocal
