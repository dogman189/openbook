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
echo "Install Complete!"
