@echo off
cd /d "%~dp0"
rem Resident watcher. It appends to watch.log itself through short-lived handles,
rem because a shell redirect would hold the file open for the whole run and
rem every other writer (or a restart) would fail with "file in use".
rem stdout/stderr go to NUL so this wrapper holds no file handle either.
"C:\nvm4w\nodejs\node.exe" "%~dp0credit-watch.mjs" --watch > NUL 2>&1
exit /b %ERRORLEVEL%
