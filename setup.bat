@echo off
rem First-time setup: create venv, install packages and Chromium.
cd /d "%~dp0"

set PY=
where py > nul 2>&1 && set PY=py -3
if not defined PY (
    where python > nul 2>&1 && set PY=python
)
if not defined PY (
    echo Python was not found. Install Python 3.10 or later, e.g.:
    echo     winget install Python.Python.3.12
    pause
    exit /b 1
)

%PY% -m venv venv || goto :error
venv\Scripts\python.exe -m pip install --upgrade pip || goto :error
venv\Scripts\python.exe -m pip install -r requirements.txt || goto :error
venv\Scripts\python.exe -m playwright install chromium || goto :error

echo.
echo Setup finished. Double-click run.bat to start.
pause
exit /b 0

:error
echo.
echo Setup failed. Check the messages above.
pause
exit /b 1
