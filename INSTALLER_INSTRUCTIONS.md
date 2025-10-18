# TikFinityLive - GitHub Release Installer Setup

This guide explains how to set up automated installers for Windows and macOS on GitHub Releases.

## Prerequisites

1. **GitHub Repository** with TikFinityLive code
2. **GitHub Actions** enabled on your repository
3. **Code signing certificates** (optional but recommended for production)

## Step 1: Setup GitHub Actions Workflow

Create `.github/workflows/build-release.yml` in your repository:

```yaml
name: Build and Release TikFinityLive

on:
  push:
    tags:
      - 'v*'  # Triggers on version tags like v1.0.0
  workflow_dispatch:  # Allows manual trigger

jobs:
  build:
    strategy:
      matrix:
        os: [windows-latest, macos-latest]
    
    runs-on: ${{ matrix.os }}
    
    steps:
    - name: Checkout code
      uses: actions/checkout@v3
    
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'
        cache: 'npm'
    
    - name: Install dependencies
      run: npm ci
    
    - name: Build application (Windows)
      if: matrix.os == 'windows-latest'
      run: npm run build-win
      env:
        GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    
    - name: Build application (macOS)
      if: matrix.os == 'macos-latest'
      run: npm run build-mac
      env:
        GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        CSC_LINK: ${{ secrets.MAC_CERT_P12 }}  # Optional: for code signing
        CSC_KEY_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}  # Optional
    
    - name: Upload Windows artifacts
      if: matrix.os == 'windows-latest'
      uses: actions/upload-artifact@v3
      with:
        name: windows-installer
        path: |
          dist/*.exe
          dist/*.msi
          dist/latest.yml
    
    - name: Upload macOS artifacts
      if: matrix.os == 'macos-latest'
      uses: actions/upload-artifact@v3
      with:
        name: macos-installer
        path: |
          dist/*.dmg
          dist/*.zip
          dist/latest-mac.yml

  release:
    needs: build
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/')
    
    steps:
    - name: Checkout code
      uses: actions/checkout@v3
    
    - name: Download Windows artifacts
      uses: actions/download-artifact@v3
      with:
        name: windows-installer
        path: dist-windows/
    
    - name: Download macOS artifacts
      uses: actions/download-artifact@v3
      with:
        name: macos-installer
        path: dist-macos/
    
    - name: Create Release
      uses: softprops/action-gh-release@v1
      with:
        files: |
          dist-windows/*
          dist-macos/*
        generate_release_notes: true
        draft: false
        prerelease: false
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Step 2: Update package.json Scripts

Add these scripts to your `package.json`:

```json
{
  "scripts": {
    "start": "electron .",
    "build": "electron-builder",
    "build-mac": "electron-builder --mac --publish=never",
    "build-win": "electron-builder --win --publish=never",
    "build-linux": "electron-builder --linux --publish=never",
    "release": "electron-builder --publish=always",
    "generate-icons": "node convert-icon.js"
  }
}
```

## Step 3: Enhanced electron-builder Configuration

Update your `package.json` build configuration:

```json
{
  "build": {
    "appId": "com.tikfinitylive.app",
    "productName": "TikFinityLive",
    "directories": {
      "output": "dist",
      "buildResources": "build"
    },
    "files": [
      "main.js",
      "index.html",
      "connectionWrapper.js",
      "limiter.js",
      "TikFinityLive.{ico,icns,png}",
      "node_modules/**/*",
      "!node_modules/.cache/**/*"
    ],
    "publish": {
      "provider": "github",
      "owner": "YOUR_GITHUB_USERNAME",
      "repo": "YOUR_REPO_NAME"
    },
    "mac": {
      "icon": "TikFinityLive.icns",
      "category": "public.app-category.social-networking",
      "target": [
        {
          "target": "dmg",
          "arch": ["x64", "arm64"]
        },
        {
          "target": "zip",
          "arch": ["x64", "arm64"]
        }
      ],
      "hardenedRuntime": true,
      "gatekeeperAssess": false,
      "notarize": false
    },
    "win": {
      "icon": "TikFinityLive.ico",
      "target": [
        {
          "target": "nsis",
          "arch": ["x64", "ia32"]
        },
        {
          "target": "portable",
          "arch": ["x64", "ia32"]
        }
      ]
    },
    "nsis": {
      "oneClick": false,
      "allowElevation": true,
      "allowToChangeInstallationDirectory": true,
      "installerIcon": "TikFinityLive.ico",
      "uninstallerIcon": "TikFinityLive.ico",
      "installerHeaderIcon": "TikFinityLive.ico",
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "TikFinityLive"
    },
    "dmg": {
      "icon": "TikFinityLive.icns",
      "iconSize": 100,
      "contents": [
        {
          "x": 380,
          "y": 280,
          "type": "link",
          "path": "/Applications"
        },
        {
          "x": 110,
          "y": 280,
          "type": "file"
        }
      ],
      "window": {
        "width": 540,
        "height": 380
      }
    },
    "linux": {
      "icon": "TikFinityLive.png",
      "target": [
        {
          "target": "AppImage",
          "arch": ["x64"]
        },
        {
          "target": "deb",
          "arch": ["x64"]
        }
      ],
      "category": "Network"
    }
  }
}
```

## Step 4: Create Release Process

### Manual Release Process:

1. **Tag your release:**
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. **GitHub Actions will automatically:**
   - Build Windows and macOS installers
   - Create a GitHub Release
   - Upload all installer files

### What Users Get:

**Windows Users:**
- `TikFinityLive-Setup-1.0.0.exe` - NSIS installer
- `TikFinityLive-1.0.0.exe` - Portable version

**macOS Users:**
- `TikFinityLive-1.0.0.dmg` - DMG installer
- `TikFinityLive-1.0.0-mac.zip` - ZIP version

## Step 5: Auto-Update Setup (Optional)

To enable auto-updates, add to your `main.js`:

```javascript
const { autoUpdater } = require('electron-updater');

// Check for updates on app start
app.whenReady().then(() => {
    autoUpdater.checkForUpdatesAndNotify();
});

// Update event handlers
autoUpdater.on('update-available', () => {
    console.log('Update available');
});

autoUpdater.on('update-downloaded', () => {
    autoUpdater.quitAndInstall();
});
```

## Step 6: Repository Setup

1. **Create GitHub repository** for TikFinityLive
2. **Push your code** to the repository
3. **Go to Settings > Actions** and ensure Actions are enabled
4. **Add any secrets** needed (like code signing certificates)

## Step 7: Building Locally (Testing)

Before setting up GitHub Actions, test locally:

```bash
# Install dependencies
npm install

# Build for current platform
npm run build

# Build for specific platforms
npm run build-mac    # macOS
npm run build-win    # Windows
npm run build-linux  # Linux
```

## Download Links for Users

Once set up, users can download installers from:
```
https://github.com/YOUR_USERNAME/YOUR_REPO/releases/latest
```

## File Structure for Repository

```
TikFinityLive/
├── .github/
│   └── workflows/
│       └── build-release.yml
├── main.js
├── index.html
├── connectionWrapper.js
├── limiter.js
├── package.json
├── TikFinityLive.png
├── TikFinityLive.ico
├── TikFinityLive.icns
├── convert-icon.js
└── README.md
```

## Notes

- **Code Signing**: For production apps, consider code signing certificates
- **Notarization**: macOS apps should be notarized for better user experience
- **Auto-updates**: electron-updater can check your GitHub releases for updates
- **Platform-specific**: Builds will only work on their respective platforms in GitHub Actions

This setup provides professional installers that users can easily download and install from your GitHub releases page!