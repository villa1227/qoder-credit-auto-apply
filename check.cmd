@echo off
cd /d "%~dp0"
rem Fallback check. It appends its own output to check.log, so this wrapper
rem holds no file handle and never collides with the scheduled tick.
rem The node path is resolved from PATH; adjust it if node lives elsewhere.
node "%~dp0monitor\credit-watch.mjs" --once --fallback --log-file "%~dp0check.log" > NUL 2>&1
exit /b %ERRORLEVEL%
