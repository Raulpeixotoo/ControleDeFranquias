@echo off
cd /d "%~dp0"
python -m pip install -r requirements.txt
if errorlevel 1 goto fim
python migrar_para_neon.py
:fim
pause
