@echo off
rem ASCII only on purpose: Chinese bytes plus `chcp 65001` makes cmd.exe
rem mis-parse the rest of the file.
rem
rem Registers the keep-alive scheduled task. Needs one UAC prompt.

net session >nul 2>&1
if %ERRORLEVEL% == 0 goto run
echo Requesting administrator rights (UAC prompt)...
powershell -Command "Start-Process 'wt.exe' -ArgumentList 'cmd /c cd /d \"%cd%\" && \"%~f0\"' -Verb runAs"
exit /b

:run
echo Administrator rights OK. Registering the keep-alive task...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-keepalive.ps1"
echo.
echo Log: %~dp0logs\install-keepalive.log
timeout /t 12
