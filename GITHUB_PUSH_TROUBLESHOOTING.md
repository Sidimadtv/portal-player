# GitHub Push Troubleshooting Guide

## Common Issues and Fixes

### Issue 1: "Repository not found" even though repository exists

**Error:**
```
fatal: repository 'https://github.com/username/repo.git/' not found
```

**Causes:**
- Authentication issues with wrong GitHub account
- Cached credentials for different username
- Repository name mismatch

**Fixes:**
1. **Clear cached credentials:**
   ```cmd
   cmdkey /delete:LegacyGeneric:target=git:https://github.com
   ```

2. **Reset git credential helper:**
   ```cmd
   git config --global --unset credential.helper
   git config --global credential.helper store
   ```

3. **Verify correct username in remote URL**
   ```cmd
   git remote -v
   git remote set-url origin https://github.com/CORRECT_USERNAME/repo
   ```

---

### Issue 2: "Permission denied" with wrong username

**Error:**
```
remote: Permission to username/repo.git denied to wrongusername
fatal: unable to access 'https://github.com/username/repo/': The requested URL returned error: 403
```

**Causes:**
- Git is using cached credentials for wrong account
- Multiple GitHub accounts with similar usernames
- Credential manager has old/stale credentials

**Fixes:**
1. **Clear Windows Credential Manager:**
   ```cmd
   cmdkey /list | findstr git
   cmdkey /delete:LegacyGeneric:target=git:https://github.com
   ```

2. **Remove git credential configuration:**
   ```cmd
   git config --global --unset credential.helper
   ```

3. **Re-authenticate when pushing:**
   ```cmd
   git push -u origin main
   # Enter correct username and token when prompted
   ```

---

### Issue 3: Authentication with different GitHub accounts

**Problem:** Multiple GitHub accounts (e.g., `Sidimadtv` vs `Sidimad-tv`)

**Fixes:**
1. **Use personal access token in URL:**
   ```cmd
   git remote set-url origin https://USERNAME:TOKEN@github.com/USERNAME/repo
   git push -u origin main
   ```

2. **Create token at:** https://github.com/settings/tokens
   - Select `repo` permissions
   - Copy and use in URL above

---

### Issue 4: Lost .git folder (repository initialization)

**Error:**
```
fatal: not a git repository (or any of the parent directories): .git
```

**Fixes:**
1. **Reinitialize repository:**
   ```cmd
   git init
   git add .
   git commit -m "Initial commit"
   ```

2. **Set up remote and push:**
   ```cmd
   git remote add origin https://github.com/username/repo
   git branch -M main
   git push -u origin main
   ```

---

### Issue 5: "Everything up-to-date" but repository is empty

**Error:**
```
Everything up-to-date
```
But GitHub repository shows empty

**Fixes:**
1. **Force push to ensure upload:**
   ```cmd
   git push -f origin main
   ```

2. **Push HEAD explicitly:**
   ```cmd
   git push origin HEAD:main
   ```

3. **Check if tracking is correct:**
   ```cmd
   git branch -vv
   git push -u origin main
   ```

---

## Permanent Solutions

### Option 1: Use SSH instead of HTTPS

1. **Generate SSH key:**
   ```cmd
   ssh-keygen -t ed25519 -C "your_email@example.com"
   ```

2. **Add to GitHub:** https://github.com/settings/keys

3. **Change remote URL:**
   ```cmd
   git remote set-url origin git@github.com:username/repo.git
   ```

### Option 2: Use GitHub CLI (gh)

1. **Install GitHub CLI:** https://cli.github.com/

2. **Authenticate:**
   ```cmd
   gh auth login
   ```

3. **Push with CLI:**
   ```cmd
   gh repo create username/repo --public --source=.
   git push -u origin main
   ```

### Option 3: Credential Manager Configuration

```cmd
git config --global credential.helper manager-core
git config --global credential.manager.core.gitHubAuthenticationModes "pat;oauth;web"
```

---

## Quick Fix Batch Script (Last Resort)

Save as `fix-git-push.bat`:

```batch
@echo off
echo Clearing Git Credentials...
cmdkey /delete:LegacyGeneric:target=git:https://github.com 2>nul

echo Resetting Git Credential Helper...
git config --global --unset credential.helper
git config --global credential.helper store

echo Done. Now run: git push -u origin main
echo When prompted, enter your GitHub username and personal access token
pause
```

---

## Prevention Tips

1. **Always verify remote URL before pushing:**
   ```cmd
   git remote -v
   ```

2. **Check current git user:**
   ```cmd
   git config user.name
   git config user.email
   ```

3. **Use consistent account authentication**

4. **Keep personal access tokens secure and updated**

5. **Consider using SSH for more reliable authentication**

---

## Summary of This Session's Issues

1. **Repository not found** - Fixed by updating remote URL to correct repository
2. **Permission denied to wrong username** - Fixed by clearing cached credentials with `cmdkey`
3. **Multiple account confusion** (Sidimadtv vs Sidimad-tv) - Fixed by re-authenticating with correct account
4. **Lost .git folder** - Fixed by reinitializing with `git init`
5. **Cached credential issues** - Fixed by clearing Windows Credential Manager

## Key Takeaway

The main issue was **cached credentials in Windows Credential Manager** for the wrong GitHub account. The permanent fix is to:

1. Clear old credentials when switching accounts
2. Use SSH authentication for better account management
3. Or use personal access tokens in remote URLs for explicit authentication
