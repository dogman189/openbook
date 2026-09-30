@echo off
REM OpenBook dependency installer.
REM Prefers the bundled bin\uv.exe (shipped in the portable app), which
REM fetches its own Python - no python.org visit needed. Falls back to a
REM system Python when uv is unavailable.
REM CUDA (NVIDIA) torch is pinned in requirements.txt and is a ~4.2GB download.
REM On a machine with no NVIDIA GPU, edit requirements.txt first and replace
REM     torch==2.14.0+cu126
REM with
REM     torch==2.14.0
REM to pull the much smaller CPU-only wheel (~200MB, slower inference).

setlocal
cd /d "%~dp0"

if exist "bin\uv.exe" goto :uv_install

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Python was not found on this machine and bin\uv.exe is missing.
  echo Re-run the portable pack or install Python 3.11+ from https://www.python.org/downloads/
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
goto :done

:uv_install
echo.
echo Fetching Python 3.11 via uv (no system Python needed) ...
bin\uv.exe python install 3.11
if errorlevel 1 (
  echo WARNING: uv could not fetch Python - check your network, then re-run.
  pause
  exit /b 1
)

echo.
echo Creating virtual environment in .venv ...
bin\uv.exe venv .venv --python 3.11
if errorlevel 1 (
  echo ERROR: could not create the virtual environment.
  pause
  exit /b 1
)

echo.
echo Installing OpenBook libraries via uv (this downloads torch, ~4.2GB) ...
echo Press Ctrl+C to cancel.
bin\uv.exe pip install --python .venv\Scripts\python.exe -r requirements.txt
if errorlevel 1 (
  echo.
  echo ERROR: installation failed. Scroll up for the failing package.
  pause
  exit /b 1
)

:done
echo.
echo Done. Open OpenBook.exe - it will use .venv automatically.
echo.
pause
endlocal
