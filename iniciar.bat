@echo off
cd /d "%~dp0"
python -m pip install -q -r requirements.txt
REM Opcional: defina um codigo de acesso para quem abrir o site (recomendado ao expor na internet)
REM set ACCESS_CODE=troque-este-codigo
python app.py %*
pause
