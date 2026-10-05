@echo off
rem Register start.bat to run automatically when Windows starts.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\KobitoKokuban.lnk'); $s.TargetPath='%~dp0start.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if errorlevel 1 (
  echo Failed to register autostart.
) else (
  echo OK: Kobito Kokuban will start automatically when Windows starts.
)
pause
