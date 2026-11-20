@echo off
rem Stand-in for go on a VibeNode session's PATH: heavy subcommands queue (see ..\runq_shim.py).
setlocal
set "_RQPY=%RUNQ_PYTHON%"
if not defined _RQPY set "_RQPY=python"
"%_RQPY%" -E -s "%~dp0..\runq_shim.py" go %*
exit /b %ERRORLEVEL%
