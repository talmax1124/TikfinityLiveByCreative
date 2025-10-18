const { app, BrowserWindow, ipcMain, Tray, Menu, shell } = require('electron');
const path = require('path');
const AutoLaunch = require('auto-launch');
const { TikTokConnectionWrapper } = require('./connectionWrapper');
const axios = require('axios');

let mainWindow;
let tray;
let tiktokConnection;
let appLauncher;
let isLiveNotified = false;
let liveEndNotified = false;
let lastActivityTime = null;
let inactivityTimer = null;

// Initialize auto-launch
const initAutoLaunch = () => {
    appLauncher = new AutoLaunch({
        name: 'TikFinityLive',
        path: app.getPath('exe'),
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
    
    if (!hasRoomInfo) {
        console.log('No room info available - user likely not live');
        return false;
    }
    
    const roomInfo = state.roomInfo;
    
    // Check multiple live status indicators
    const streamStatus = roomInfo.stream_status;
    const isReplay = roomInfo.is_replay;
    const liveTypeNormal = roomInfo.live_type_normal;
    const hasRoomId = state.roomId && state.roomId !== '';
    
    // Log the room info for debugging
    console.log('Room Info Debug:', {
        stream_status: streamStatus,
        is_replay: isReplay,
        live_type_normal: liveTypeNormal,
        room_id: state.roomId,
        has_room_info: hasRoomInfo
    });
    
    // User is considered live if:
    // 1. Stream status indicates live (usually 2 or 4)
    // 2. Not a replay
    // 3. Has a valid room ID
    // 4. Live type is normal (if available)
    const isLive = (
        hasRoomId &&
        streamStatus && 
        streamStatus !== 0 && 
        streamStatus !== 1 && // Not offline
        !isReplay &&
        (liveTypeNormal === undefined || liveTypeNormal === true)
    );
    
    console.log(`Live status check result: ${isLive}`);
    return isLive;
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
    global.settings = settings;
    
    // Handle auto-start
    if (settings.autoStart) {
        await appLauncher.enable();
    } else {
        await appLauncher.disable();
    }

    // Update inactivity timeout if currently monitoring
    if (inactivityTimer && settings.inactivityTimeout) {
        clearTimeout(inactivityTimer);
        if (isLiveNotified) {
            startInactivityTimer(settings.username, settings.inactivityTimeout);
        }
    }

    return true;
});

ipcMain.handle('start-monitoring', (event, username) => {
    if (tiktokConnection) {
        tiktokConnection.disconnect();
    }

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

    // Forward TikTok events to renderer and track activity
    ['chat', 'gift', 'member', 'like', 'social', 'emote'].forEach(event => {
        tiktokConnection.connection.on(event, (data) => {
            // Reset activity timer on any live stream activity
            if (isLiveNotified) {
                resetActivityTimer(username);
            }
            
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
        
        // Remove auto-launch
        let autoLaunchRemoved = false;
        try {
            const isEnabled = await appLauncher.isEnabled();
            if (isEnabled) {
                await appLauncher.disable();
                autoLaunchRemoved = true;
            }
        } catch (error) {
            console.error('Error removing auto-launch:', error);
        }
        
        // Clear app data
        global.settings = {};
        
        return {
            success: true,
            autoLaunchRemoved,
            dataCleanedUp: true
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
app.whenReady().then(() => {
    initAutoLaunch();
    createWindow();
    createTray();
    
    // Initialize global settings
    global.settings = {};
    global.hasShownTrayNotification = false;

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
    
    // Clear timers
    if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
    }
});

