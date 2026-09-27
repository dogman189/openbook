python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
if (Get-Command tesseract -ErrorAction SilentlyContinue) {
  echo "Tesseract OCR found."
} else {
  echo "NOTE: tesseract not found - scanned PDFs will be rejected."
  echo "Run install-deps.bat (downloads Tesseract) or see docs/troubleshooting.md."
}
echo "Install Complete!"
