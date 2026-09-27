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
echo Done. Open OpenBook.exe - it will use .venv automatically.
echo.
pause
endlocal
