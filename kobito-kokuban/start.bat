@echo off
rem ============================================================
rem  Kobito Kokuban launcher (fullscreen kiosk mode)
rem  To exit: press Alt + F4 on the keyboard.
rem ============================================================
setlocal
set "APP=%~dp0index.html"
set "PROFILE=%LOCALAPPDATA%\KobitoKokuban"
set "FLAGS=--kiosk --no-first-run --no-default-browser-check --disable-pinch --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required --disable-features=TouchpadOverscrollHistoryNavigation,Translate --user-data-dir="%PROFILE%""

set "BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if defined BROWSER (
  start "" "%BROWSER%" %FLAGS% "%APP%"
  goto :eof
)

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if defined BROWSER (
  start "" "%BROWSER%" %FLAGS% --edge-kiosk-type=fullscreen "%APP%"
  goto :eof
)

rem Fallback: open with the default browser (press F11 for fullscreen)
start "" "%APP%"
