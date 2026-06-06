@echo off
echo ========================================
echo Git Push Fix Script
echo ========================================
echo.

echo [1/4] Clearing Windows Credential Manager git credentials...
cmdkey /delete:LegacyGeneric:target=git:https://github.com 2>nul
if %errorlevel% equ 0 (
    echo Successfully cleared git credentials
) else (
    echo No git credentials found or already cleared
)
echo.

echo [2/4] Resetting Git credential helper...
git config --global --unset credential.helper 2>nul
git config --global credential.helper store
echo Git credential helper reset to use store
echo.

echo [3/4] Checking current git repository...
if not exist .git (
    echo WARNING: Not a git repository. Initializing...
    git init
    git add .
    git commit -m "Initial commit"
) else (
    echo Git repository exists
)
echo.

echo [4/4] Checking remote configuration...
git remote -v
echo.

echo ========================================
echo Ready to push to GitHub
echo ========================================
echo.
echo Next steps:
echo 1. Verify the remote URL above is correct
echo 2. If needed, update with: git remote set-url origin https://github.com/USERNAME/REPO
echo 3. Push with: git push -u origin main
echo 4. When prompted, enter:
echo    - Username: Your GitHub username (e.g., Sidimad-tv)
echo    - Password: Your personal access token (not account password)
echo.
echo Create personal access token at: https://github.com/settings/tokens
echo.
pause
