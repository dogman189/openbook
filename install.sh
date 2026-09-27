#!/bin/sh
set -e
# Detect python command
PYTHON_CMD="python3"
if ! command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD="python"
fi

$PYTHON_CMD -m venv venv
. venv/bin/activate
pip install -r requirements.txt
if command -v tesseract >/dev/null 2>&1; then
  echo "Tesseract OCR found."
else
  echo "NOTE: tesseract not found - scanned PDFs will be rejected."
  echo "  macOS: brew install tesseract"
  echo "  Ubuntu/Debian: sudo apt install tesseract-ocr"
fi
echo "Install Complete!"
