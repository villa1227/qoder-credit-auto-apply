@echo off
cd /d "%~dp0"
rem Single scheduled tick: checks whether Qoder Desktop is running and only then
rem looks at the quota in the log. It appends to watch.log itself through
rem short-lived handles, because a shell redirect would hold the file open for
rem the whole run and every other writer (or a restart) would fail with
rem "file in use". stdout/stderr go to NUL so this wrapper holds no file handle.
rem The node path is resolved from PATH; adjust it if node lives elsewhere.
node "%~dp0monitor\credit-watch.mjs" --tick > NUL 2>&1
exit /b %ERRORLEVEL%
