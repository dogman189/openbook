# tests/conftest.py — put the flat repo root on sys.path so
# `import backend` works no matter where pytest is invoked from.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
