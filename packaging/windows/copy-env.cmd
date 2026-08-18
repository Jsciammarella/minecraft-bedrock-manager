@echo off
setlocal
if exist ".env" exit /b 0
if exist ".env.example" copy /Y ".env.example" ".env" >nul
exit /b 0
