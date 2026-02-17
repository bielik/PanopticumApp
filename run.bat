@echo off
title PANOPTICUM
echo ==========================================
echo   PANOPTICUM — Surveillance Art Installation
echo ==========================================
echo.
echo Starting web server...
echo Open http://localhost:8000/ for controls
echo Open http://localhost:8000/exhibit for exhibition mode
echo Press Ctrl+C to quit.
echo.

cd /d "%~dp0"

if exist "venv\Scripts\python.exe" (
    venv\Scripts\python.exe main.py
) else (
    python main.py
)

pause
