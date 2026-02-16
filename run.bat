@echo off
title PANOPTICUM
echo ==========================================
echo   PANOPTICUM — Surveillance Art Installation
echo ==========================================
echo.
echo Starting... Press ESC in the window to quit.
echo.

cd /d "%~dp0"

if exist "venv\Scripts\python.exe" (
    venv\Scripts\python.exe main.py
) else (
    python main.py
)

pause
