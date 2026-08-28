@echo off
setlocal
set "APPDIR=%~dp0"
if exist "%APPDIR%.env" exit /b 0
if not exist "%APPDIR%.env.example" exit /b 1
copy /Y "%APPDIR%.env.example" "%APPDIR%.env" >nul
if errorlevel 1 exit /b 1
if not exist "%APPDIR%.env" exit /b 1
exit /b 0
