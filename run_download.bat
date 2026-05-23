@echo off
cd /d "%~dp0"
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" download_images.py
echo.
echo Done. Press any key to close.
pause >nul
