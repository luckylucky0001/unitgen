@echo off
rem Windows launcher: runs the TypeScript sources directly with Node >= 22.18 (built-in type stripping).
rem UNITGEN_ENV (a .cmd file) is called first when set, to put Node / JDK / SDK paths in this process only.
setlocal
if defined UNITGEN_ENV (
  if not exist "%UNITGEN_ENV%" (
    echo unitgen: UNITGEN_ENV file not found: %UNITGEN_ENV% 1>&2
    exit /b 1
  )
  call "%UNITGEN_ENV%"
)
if defined JAVA_HOME set "PATH=%JAVA_HOME%\bin;%PATH%"
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)" >nul 2>nul
if errorlevel 1 (
  echo unitgen: Node ^>= 22.18 is required; install it or configure PATH / UNITGEN_ENV 1>&2
  exit /b 1
)
node --disable-warning=ExperimentalWarning "%~dp0..\src\cli.ts" %*
exit /b %errorlevel%
