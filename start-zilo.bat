@echo off
cd /d "C:\Users\Tosy\Desktop\Zilo"
where npm >nul 2>&1
if %errorlevel% neq 0 (
    set PATH=%PATH%;C:\Program Files\nodejs;C:\Users\Tosy\AppData\Roaming\npm
)
npm start
