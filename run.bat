@echo off
rem Run keiba_scraper.py inside the virtual environment.
rem Usage: run.bat                 (interactive)
rem        run.bat [venue] [race no] [date]   e.g. run.bat 35 5 1025
cd /d "%~dp0"
chcp 65001 > nul

if not exist venv\Scripts\python.exe (
    echo Virtual environment not found. Run setup.bat first.
    pause
    exit /b 1
)

venv\Scripts\python.exe keiba_scraper.py %*
pause
