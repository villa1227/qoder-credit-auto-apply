@echo off
cd /d "%~dp0"
rem Fallback check. The script appends its own output to check.log, so this
rem wrapper holds no file handle and never collides with the resident watcher.
"C:\nvm4w\nodejs\node.exe" "%~dp0credit-watch.mjs" --once --fallback --log-file "%~dp0check.log" > NUL 2>&1
exit /b %ERRORLEVEL%
