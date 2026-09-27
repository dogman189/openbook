#!/bin/sh
set -e
pip install pyinstaller
pyinstaller --onefile backend.py -w
npm run build
