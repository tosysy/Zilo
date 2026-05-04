@echo off
set ELECTRON_BUILDER_CACHE=%LOCALAPPDATA%\electron-builder\Cache-fixed
set CSC_IDENTITY_AUTO_DISCOVERY=false
node_modules\.bin\electron-builder --win nsis
