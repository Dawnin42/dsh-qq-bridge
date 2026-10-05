@echo off
rem Resume the bot: the watchdog starts it again within ~15 seconds.
rem No administrator rights needed.
if exist "%~dp0bot-pause.flag" del /q "%~dp0bot-pause.flag"
echo.
echo   QQ bot resumed. The watchdog will start it within 15 seconds.
echo   Log: %~dp0logs\keepalive.log
echo.
timeout /t 8 >nul
