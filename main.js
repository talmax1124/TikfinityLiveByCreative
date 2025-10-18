const { app, BrowserWindow, ipcMain, Tray, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const AutoLaunch = require('auto-launch');
const { TikTokConnectionWrapper } = require('./connectionWrapper');
const axios = require('axios');

// Data storage paths
const userData = app.getPath('userData');
const dataDir = path.join(userData, 'stream-data');
const sessionFile = path.join(dataDir, 'current-session.json');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Current session data
let currentSession = {
    username: null,
    startTime: null,
    events: [],
    stats: {
        totalMessages: 0,
        totalGifts: 0,
        totalLikes: 0,
        totalMembers: 0,
        totalDiamonds: 0
    }
};

let mainWindow;
let tray;
let tiktokConnection;
let appLauncher;
let isLiveNotified = false;
let liveEndNotified = false;
let lastActivityTime = null;
let inactivityTimer = null;

// Data storage functions
const saveCurrentSession = () => {
    try {
        fs.writeFileSync(sessionFile, JSON.stringify(currentSession, null, 2));
    } catch (error) {
        console.error('Failed to save session data:', error);
    }
};

const loadCurrentSession = () => {
    try {
        if (fs.existsSync(sessionFile)) {
            const data = fs.readFileSync(sessionFile, 'utf8');
            currentSession = JSON.parse(data);
        }
    } catch (error) {
        console.error('Failed to load session data:', error);
    }
};

const saveStreamEvent = (type, data) => {
    const event = {
        type,
        timestamp: new Date().toISOString(),
        data: { ...data }
    };
    
    currentSession.events.push(event);
    
    // Update stats
    switch (type) {
        case 'chat':
            currentSession.stats.totalMessages++;
            break;
        case 'gift':
            currentSession.stats.totalGifts++;
            currentSession.stats.totalDiamonds += (data.diamondCount || 0) * (data.repeatCount || 1);
            break;
        case 'like':
            currentSession.stats.totalLikes++;
            break;
        case 'member':
            currentSession.stats.totalMembers++;
            break;
    }
    
    // Save to file every 10 events or immediately for gifts
    if (currentSession.events.length % 10 === 0 || type === 'gift') {
        saveCurrentSession();
    }
};

const finalizeSession = () => {
    if (currentSession.username && currentSession.events.length > 0) {
        const endTime = new Date().toISOString();
        const duration = new Date(endTime) - new Date(currentSession.startTime);
        
        // Create final session file
        const sessionData = {
            ...currentSession,
            endTime,
            duration: Math.floor(duration / 1000) // duration in seconds
        };
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const finalFile = path.join(dataDir, `session-${currentSession.username}-${timestamp}.json`);
        
        try {
            fs.writeFileSync(finalFile, JSON.stringify(sessionData, null, 2));
            console.log(`Session saved to: ${finalFile}`);
        } catch (error) {
            console.error('Failed to save final session:', error);
        }
    }
    
    // Reset current session
    currentSession = {
        username: null,
        startTime: null,
        events: [],
        stats: {
            totalMessages: 0,
            totalGifts: 0,
            totalLikes: 0,
            totalMembers: 0,
            totalDiamonds: 0
        }
    };
    
    saveCurrentSession();
};

// Initialize auto-launch
const initAutoLaunch = () => {
    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
    
    appLauncher = new AutoLaunch({
        name: 'TikFinityLive',
        path: isDev ? process.execPath : app.getPath('exe'),
        isHidden: false
    });
};

// Create the main window
const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 400,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'TikFinityLive.png'),
        title: 'TikFinityLive - TikTok Live Notifier',
        show: false
    });

    mainWindow.loadFile('index.html');

    // Handle window close behavior based on settings
    mainWindow.on('close', (event) => {
        if (!app.isQuiting) {
            event.preventDefault();
            
            // Check if minimize to tray is enabled
            const minimizeToTray = global.settings?.minimizeToTray !== false; // Default true
            
            if (minimizeToTray) {
                mainWindow.hide();
                console.log('App minimized to system tray - monitoring continues...');
                
                // Show notification on first minimize (optional)
                if (!global.hasShownTrayNotification) {
                    global.hasShownTrayNotification = true;
                    // You can add a notification here if desired
                }
            } else {
                // If minimize to tray is disabled, show confirmation
                const { dialog } = require('electron');
                const choice = dialog.showMessageBoxSync(mainWindow, {
                    type: 'question',
                    buttons: ['Minimize', 'Quit', 'Cancel'],
                    defaultId: 0,
                    title: 'TikFinityLive',
                    message: 'What would you like to do?',
                    detail: 'Minimize will hide the window but keep monitoring active.\nQuit will stop monitoring and close the app completely.'
                });
                
                if (choice === 0) {
                    // Minimize
                    mainWindow.minimize();
                } else if (choice === 1) {
                    // Quit
                    app.isQuiting = true;
                    app.quit();
                }
                // choice === 2 means Cancel, do nothing
            }
        }
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });
};

// Create system tray
const createTray = () => {
    // Use the TikFinityLive icon from root
    const trayIconPath = path.join(__dirname, 'TikFinityLive.png');
    
    tray = new Tray(trayIconPath);
    
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show TikFinityLive',
            click: () => {
                showMainWindow();
            }
        },
        {
            type: 'separator'
        },
        {
            label: 'Start Monitoring',
            click: () => {
                showMainWindow();
                // Send event to renderer to start monitoring
                mainWindow.webContents.send('tray-start-monitoring');
            }
        },
        {
            label: 'Stop Monitoring',
            click: () => {
                if (tiktokConnection) {
                    tiktokConnection.disconnect();
                    tiktokConnection = null;
                    mainWindow.webContents.send('connection-status', 'stopped');
                }
            }
        },
        {
            type: 'separator'
        },
        {
            label: 'Quit TikFinityLive',
            click: () => {
                app.isQuiting = true;
                app.quit();
            }
        }
    ]);

    tray.setToolTip('TikFinityLive - TikTok Live Notifier');
    tray.setContextMenu(contextMenu);

    // Handle tray icon clicks
    tray.on('click', () => {
        showMainWindow();
    });

    tray.on('double-click', () => {
        showMainWindow();
    });
};

// Show main window function
const showMainWindow = () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();
        
        // On macOS, ensure the app is brought to front
        if (process.platform === 'darwin') {
            app.dock.show();
        }
    }
};

// Check if user is actually live based on connection state
const checkIfUserIsLive = (state) => {
    // Check various indicators that the user is live
    const hasRoomInfo = state.roomInfo && typeof state.roomInfo === 'object';
    const hasRoomId = state.roomId && state.roomId !== '';
    
    // Log the full state for debugging
    console.log('Live Detection Debug - Full State:', {
        hasRoomInfo,
        hasRoomId,
        isConnected: state.isConnected,
        upgradedToWebsocket: state.upgradedToWebsocket,
        roomInfo: state.roomInfo
    });
    
    // If we have a room ID and are connected, we're likely live
    // This is the most reliable indicator
    if (hasRoomId && state.isConnected) {
        console.log('✅ User detected as LIVE - has room ID and is connected');
        return true;
    }
    
    // Secondary check with room info if available
    if (hasRoomInfo) {
        const roomInfo = state.roomInfo;
        const streamStatus = roomInfo.stream_status;
        const isReplay = roomInfo.is_replay;
        
        console.log('Room Info Secondary Check:', {
            stream_status: streamStatus,
            is_replay: isReplay
        });
        
        // More lenient check for live status
        const isLiveFromRoomInfo = (
            streamStatus !== undefined &&
            streamStatus !== 0 && // Not explicitly offline
            !isReplay
        );
        
        if (isLiveFromRoomInfo) {
            console.log('✅ User detected as LIVE from room info');
            return true;
        }
    }
    
    console.log('❌ User not detected as live');
    return false;
};

// Send "Live Ended" Discord notification
const sendLiveEndedNotification = async (username, webhookUrl) => {
    try {
        const embed = {
            title: "⚫ TikTok Live Ended",
            description: `**${username}** has ended their live stream or went inactive.`,
            color: 6842472, // Gray color
            timestamp: new Date().toISOString(),
            footer: {
                text: "TikFinityLive"
            },
            thumbnail: {
                url: "https://logo-marque.com/wp-content/uploads/2020/10/TikTok-Logo.png"
            }
        };

        await axios.post(webhookUrl, {
            embeds: [embed]
        });

        console.log('Discord "Live Ended" notification sent successfully');
    } catch (error) {
        console.error('Failed to send Discord "Live Ended" notification:', error.message);
    }
};

// Start inactivity monitoring with configurable timeout
const startInactivityTimer = (username, timeoutMinutes = 30) => {
    if (inactivityTimer) {
        clearTimeout(inactivityTimer);
    }
    
    const timeoutMs = timeoutMinutes * 60 * 1000;
    
    inactivityTimer = setTimeout(() => {
        if (!liveEndNotified && global.settings?.webhookUrl) {
            sendLiveEndedNotification(username, global.settings.webhookUrl);
            liveEndNotified = true;
            console.log(`Sent live ended notification due to ${timeoutMinutes}min inactivity`);
        }
    }, timeoutMs);
};

// Reset activity timer
const resetActivityTimer = (username) => {
    lastActivityTime = Date.now();
    liveEndNotified = false;
    const timeoutMinutes = global.settings?.inactivityTimeout || 30;
    startInactivityTimer(username, timeoutMinutes);
};

// Send Discord webhook notification
const sendDiscordNotification = async (username, webhookUrl) => {
    try {
        const embed = {
            title: "🔴 TikTok Live Notification",
            description: `**${username}** is now live on TikTok!`,
            color: 16711680, // Red color
            timestamp: new Date().toISOString(),
            footer: {
                text: "TikFinityLive"
            },
            thumbnail: {
                url: "https://logo-marque.com/wp-content/uploads/2020/10/TikTok-Logo.png"
            }
        };

        await axios.post(webhookUrl, {
            embeds: [embed]
        });

        console.log('Discord notification sent successfully');
    } catch (error) {
        console.error('Failed to send Discord notification:', error.message);
    }
};

// IPC handlers
ipcMain.handle('get-settings', () => {
    return {
        username: global.settings?.username || '',
        webhookUrl: global.settings?.webhookUrl || '',
        autoStart: global.settings?.autoStart || false
    };
});

ipcMain.handle('save-settings', async (event, settings) => {
    try {
        global.settings = settings;
        
        // Handle auto-start only if appLauncher is initialized
        if (appLauncher) {
            try {
                const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
                
                if (isDev) {
                    // In development mode, just log the setting but don't actually set auto-start
                    console.log(`Auto-start ${settings.autoStart ? 'enabled' : 'disabled'} (dev mode - not actually set)`);
                } else {
                    // In production mode, actually set auto-start
                    if (settings.autoStart) {
                        await appLauncher.enable();
                    } else {
                        await appLauncher.disable();
                    }
                }
            } catch (autoLaunchError) {
                console.warn('Auto-launch error (non-critical):', autoLaunchError.message);
                // Don't throw the error, just log it as auto-launch is not critical
            }
        } else {
            console.log('Auto-launch not available yet - will be applied when app is ready');
        }

        // Update inactivity timeout if currently monitoring
        if (inactivityTimer && settings.inactivityTimeout) {
            clearTimeout(inactivityTimer);
            if (isLiveNotified) {
                startInactivityTimer(settings.username, settings.inactivityTimeout);
            }
        }

        return true;
    } catch (error) {
        console.error('Error saving settings:', error);
        throw error;
    }
});

ipcMain.handle('start-monitoring', (event, username) => {
    if (tiktokConnection) {
        tiktokConnection.disconnect();
        finalizeSession(); // Save previous session
    }

    // Initialize new session
    currentSession = {
        username,
        startTime: new Date().toISOString(),
        events: [],
        stats: {
            totalMessages: 0,
            totalGifts: 0,
            totalLikes: 0,
            totalMembers: 0,
            totalDiamonds: 0
        }
    };
    saveCurrentSession();

    tiktokConnection = new TikTokConnectionWrapper(username, {}, true);

    tiktokConnection.on('connected', (state) => {
        console.log(`Connected to ${username}'s stream`, state);
        
        // Check if the user is actually live and connection is properly established
        const isLive = checkIfUserIsLive(state);
        const isProperlyConnected = state.isConnected && state.upgradedToWebsocket;
        
        if (isLive && isProperlyConnected) {
            console.log(`${username} is confirmed LIVE with proper connection!`);
            mainWindow.webContents.send('connection-status', 'live');
            
            // Send Discord notification only when user is actually live and not already notified
            if (global.settings?.webhookUrl && !isLiveNotified) {
                sendDiscordNotification(username, global.settings.webhookUrl);
                isLiveNotified = true;
            }
            
            // Start activity monitoring
            resetActivityTimer(username);
        } else {
            console.log(`Connected to ${username} but not live or not properly connected`);
            mainWindow.webContents.send('connection-status', 'connected-waiting');
        }
    });

    tiktokConnection.on('disconnected', () => {
        console.log(`Disconnected from ${username}'s stream`);
        mainWindow.webContents.send('connection-status', 'disconnected');
        
        // Send live ended notification if user was live and not already notified
        if (isLiveNotified && !liveEndNotified && global.settings?.webhookUrl) {
            sendLiveEndedNotification(username, global.settings.webhookUrl);
            liveEndNotified = true;
        }
        
        // Clear timers and reset flags
        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
        }
        isLiveNotified = false;
        liveEndNotified = false;
    });

    // Listen for state changes that might indicate going live
    tiktokConnection.connection.on('streamEnd', () => {
        console.log(`Stream ended for ${username}`);
        mainWindow.webContents.send('connection-status', 'disconnected');
        
        // Send live ended notification if user was live
        if (isLiveNotified && !liveEndNotified && global.settings?.webhookUrl) {
            sendLiveEndedNotification(username, global.settings.webhookUrl);
            liveEndNotified = true;
        }
        
        isLiveNotified = false;
        liveEndNotified = false;
    });

    // Listen for any activity that indicates the stream is live
    tiktokConnection.connection.on('member', (data) => {
        // If we get member events, the stream is definitely live
        if (!isLiveNotified) {
            console.log(`${username} confirmed LIVE via member activity!`);
            mainWindow.webContents.send('connection-status', 'live');
            
            if (global.settings?.webhookUrl) {
                sendDiscordNotification(username, global.settings.webhookUrl);
                isLiveNotified = true;
                liveEndNotified = false;
            }
        }
        
        resetActivityTimer(username);
        saveStreamEvent('member', data);
        mainWindow.webContents.send('tiktok-event', { type: 'member', data });
    });

    // Forward TikTok events to renderer and track activity
    ['chat', 'gift', 'like', 'social', 'emote'].forEach(event => {
        tiktokConnection.connection.on(event, (data) => {
            // If we get any live activity, confirm the stream is live
            if (!isLiveNotified) {
                console.log(`${username} confirmed LIVE via ${event} activity!`);
                mainWindow.webContents.send('connection-status', 'live');
                
                if (global.settings?.webhookUrl) {
                    sendDiscordNotification(username, global.settings.webhookUrl);
                    isLiveNotified = true;
                    liveEndNotified = false;
                }
            }
            
            // Reset activity timer on any live stream activity
            if (isLiveNotified) {
                resetActivityTimer(username);
            }
            
            // Save event data locally
            saveStreamEvent(event, data);
            mainWindow.webContents.send('tiktok-event', { type: event, data });
        });
    });

    tiktokConnection.connect();
    return true;
});

ipcMain.handle('stop-monitoring', () => {
    if (tiktokConnection) {
        tiktokConnection.disconnect();
        tiktokConnection = null;
    }
    
    // Finalize and save session data
    finalizeSession();
    
    // Clear timers and reset flags
    if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
    }
    isLiveNotified = false;
    liveEndNotified = false;
    lastActivityTime = null;
    
    mainWindow.webContents.send('connection-status', 'stopped');
    return true;
});

// Data access handlers
ipcMain.handle('get-current-session', () => {
    return currentSession;
});

ipcMain.handle('get-saved-sessions', () => {
    try {
        const files = fs.readdirSync(dataDir)
            .filter(file => file.startsWith('session-') && file.endsWith('.json'))
            .map(file => {
                const filePath = path.join(dataDir, file);
                const stats = fs.statSync(filePath);
                return {
                    filename: file,
                    path: filePath,
                    size: stats.size,
                    modified: stats.mtime
                };
            })
            .sort((a, b) => b.modified - a.modified);
        
        return { success: true, sessions: files };
    } catch (error) {
        console.error('Failed to list saved sessions:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('export-session-data', async (event, sessionPath) => {
    try {
        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Session Data',
            filters: [{ name: 'JSON Files', extensions: ['json'] }],
            defaultPath: path.basename(sessionPath)
        });
        
        if (!result.canceled) {
            fs.copyFileSync(sessionPath, result.filePath);
            return { success: true, path: result.filePath };
        }
        return { success: false, cancelled: true };
    } catch (error) {
        console.error('Export session error:', error);
        return { success: false, error: error.message };
    }
});

// Advanced app functions
ipcMain.handle('get-app-info', () => {
    return {
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        platform: process.platform,
        version: '1.0.0'
    };
});

ipcMain.handle('reset-settings', async () => {
    global.settings = {};
    return true;
});

ipcMain.handle('export-settings', async () => {
    try {
        const { dialog } = require('electron');
        const fs = require('fs');
        
        const result = await dialog.showSaveDialog(mainWindow, {
            filters: [{ name: 'JSON Files', extensions: ['json'] }],
            defaultPath: 'tikfinity-settings.json'
        });
        
        if (!result.canceled) {
            fs.writeFileSync(result.filePath, JSON.stringify(global.settings, null, 2));
            return { success: true, path: result.filePath };
        }
        
        return { success: false };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('import-settings', async () => {
    try {
        const { dialog } = require('electron');
        const fs = require('fs');
        
        const result = await dialog.showOpenDialog(mainWindow, {
            filters: [{ name: 'JSON Files', extensions: ['json'] }],
            properties: ['openFile']
        });
        
        if (!result.canceled && result.filePaths.length > 0) {
            const data = fs.readFileSync(result.filePaths[0], 'utf8');
            global.settings = JSON.parse(data);
            return { success: true };
        }
        
        return { success: false };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Integrated uninstaller
ipcMain.handle('uninstall-app', async () => {
    try {
        // Stop monitoring first
        if (tiktokConnection) {
            tiktokConnection.disconnect();
            tiktokConnection = null;
        }
        
        // Clear timers
        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
        }
        
        // Remove auto-launch
        let autoLaunchRemoved = false;
        try {
            if (appLauncher) {
                const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
                
                if (isDev) {
                    console.log('Auto-launch removal skipped in development mode');
                    autoLaunchRemoved = true; // Consider it "removed" in dev mode
                } else {
                    const isEnabled = await appLauncher.isEnabled();
                    if (isEnabled) {
                        await appLauncher.disable();
                        autoLaunchRemoved = true;
                    }
                }
            }
        } catch (error) {
            console.warn('Error removing auto-launch (non-critical):', error.message);
        }
        
        // Clear app data and settings
        global.settings = {};
        
        // Get app path for manual removal instructions
        const appPath = process.execPath;
        const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
        
        return {
            success: true,
            autoLaunchRemoved,
            dataCleanedUp: true,
            isDevelopment: isDev,
            appPath: isDev ? process.cwd() : appPath,
            instructions: isDev 
                ? 'Development mode: Delete the project folder manually after closing this app.'
                : 'Drag TikFinityLive.app from Applications folder to Trash after this app closes.'
        };
    } catch (error) {
        console.error('Uninstall error:', error);
        return {
            success: false,
            error: error.message
        };
    }
});

ipcMain.handle('quit-app', () => {
    app.isQuiting = true;
    app.quit();
});

// App event handlers
app.whenReady().then(async () => {
    initAutoLaunch();
    createWindow();
    createTray();
    
    // Initialize global settings
    global.settings = {};
    global.hasShownTrayNotification = false;
    
    // Load existing session data
    loadCurrentSession();
    
    // Apply auto-start setting if it was saved before app was ready
    if (global.settings?.autoStart && appLauncher) {
        try {
            await appLauncher.enable();
            console.log('Applied delayed auto-start setting');
        } catch (error) {
            console.error('Error applying delayed auto-start:', error);
        }
    }

    app.on('activate', () => {
        // On macOS, re-create window when dock icon is clicked and no windows are open
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
            createTray();
        } else {
            // Show existing window
            showMainWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // On macOS, keep app running even when all windows are closed
    // On other platforms, quit when all windows are closed unless we have a tray
    if (process.platform !== 'darwin' && !tray) {
        app.quit();
    }
});

app.on('before-quit', () => {
    app.isQuiting = true;
    
    // Stop monitoring when quitting
    if (tiktokConnection) {
        tiktokConnection.disconnect();
        tiktokConnection = null;
    }
    
    // Finalize and save any active session
    finalizeSession();
    
    // Clear timers
    if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
    }
});

