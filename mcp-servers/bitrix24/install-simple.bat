@echo off
echo.
echo ========================================
echo  Bitrix24 MCP Server - Simple Install
echo ========================================
echo.
echo This is a simplified installation script.
echo For full automated setup, use: install-complete-setup.bat
echo.

:: Check for Node.js
node --version >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Node.js is required but not found!
    echo.
    echo Please install Node.js from: https://nodejs.org/
    echo Then run this script again.
    echo.
    pause
    exit /b 1
)

echo [INFO] Installing dependencies...
call npm install
if %errorLevel% neq 0 (
    echo [ERROR] Failed to install dependencies
    pause
    exit /b 1
)

echo [INFO] Building project...
call npm run build
if %errorLevel% neq 0 (
    echo [ERROR] Build failed
    pause
    exit /b 1
)

echo [INFO] Creating environment file...
if not exist ".env" (
    copy ".env.example" ".env"
    echo [INFO] Please edit .env file with your Bitrix24 webhook URL
    notepad ".env"
)

echo.
echo [SUCCESS] Basic installation complete!
echo.
echo Next steps:
echo 1. Configure your .env file with Bitrix24 webhook URL
echo 2. Add MCP server to Claude Desktop configuration
echo 3. Restart Claude Desktop
echo.
echo For detailed setup instructions, see SETUP.md
echo.
pause
