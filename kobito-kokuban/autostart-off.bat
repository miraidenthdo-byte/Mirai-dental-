@echo off
rem Remove the autostart shortcut.
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\KobitoKokuban.lnk" 2>nul
echo OK: Autostart has been turned off.
pause
