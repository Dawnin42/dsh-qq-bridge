@echo off
rem Pause the bot: the watchdog kills it within ~15 seconds and stops reviving it
rem until start-bot.bat is run. No administrator rights needed.
echo paused > "%~dp0bot-pause.flag"
echo.
echo   QQ bot stopping. The watchdog kills it within 15 seconds and stays paused.
echo   Double-click start-bot.bat to bring it back.
echo.
timeout /t 8 >nul
