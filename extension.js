import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as MessageTray from "resource:///org/gnome/shell/ui/messageTray.js";
import { ConfigManager } from "./configManager.js";
import { GitHubAPI } from "./githubAPI.js";
import { ReleaseMonitoringAPI } from "./releaseMonitoringAPI.js";
import { RedhatCdnAPI } from "./redhatCdnAPI.js";
import { ReleaseMonitorIndicator } from "./indicator.js";
import * as Logger from "./logger.js";

// ============================================================================
// Extension class
// ============================================================================
export default class ReleaseMonitorExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this.metadata = metadata; // Store metadata for access in indicator
        this.configManager = null;
        this.githubAPI = null;
        this.releaseMonitoringAPI = null;
        this.redhatCdnAPI = null;
        this.indicator = null;
        this.checkInterval = null;
        this.settings = null;
        this._settingsChangedId = null;
        this._wasInStatusArea = false; // Track if indicator was ever added via addToStatusArea
        this._signalMonitor = null; // GFileMonitor for signal directory
        this._settingsWindowProcessId = null; // Track settings window process
        this._prefsProcessId = null; // Track preferences window process (gnome-extensions prefs)
        this._reloadInProgress = false;
    }

    enable() {
        try {
            Logger.info("Enabling ReleaseMonitorExtension");

            this.configManager = new ConfigManager();
            this.githubAPI = new GitHubAPI();
            
            // Get API token from settings
            let apiToken = null;
            try {
                apiToken = this.getSettings().get_string('release-monitoring-api-token') || null;
            } catch (e) {
                Logger.warn(`Could not read release-monitoring-api-token: ${e.message}`);
            }
            this.releaseMonitoringAPI = new ReleaseMonitoringAPI(apiToken);
            this.settings = this.getSettings();
            this.redhatCdnAPI = new RedhatCdnAPI(
                this._getRhelCdnSetting('rhel-cdn-cert-path'),
                this._getRhelCdnSetting('rhel-cdn-key-path'),
                this._getRhelCdnSetting('rhel-cdn-ca-path')
            );
            
            // Defer indicator creation to avoid blocking
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                try {
                    this.indicator = new ReleaseMonitorIndicator();
                    this.indicator._setExtension(this);
                    
                    // Add indicator to panel based on position setting
                    this._addIndicatorToPanel();
                    
                    // Watch for settings changes
                    this._settingsChangedId = this.settings.connect('changed::icon-position', () => {
                        this._moveIndicator();
                    });
                } catch (e) {
                    Logger.error("Error creating indicator", e);
                }
                return false; // Don't repeat
            });
            
            // Watch for signals from other processes (reload, settings, etc.)
            this._startSignalMonitor();
            
            // Start check interval based on settings
            this._restartCheckInterval();
            
            // Initial check after 5 seconds
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                this.checkForUpdates();
                return false; // Don't repeat
            });
        } catch (e) {
            Logger.error("Error in enable()", e);
        }
    }

    _addIndicatorToPanel() {
        let position = 'right'; // Default
        try {
            position = this.settings.get_string('icon-position') || 'right';
        } catch (e) {
            Logger.warn(`Could not read icon-position setting: ${e.message}, using default 'right'`);
        }
        
        // Remove from any existing position first
        const currentParent = this.indicator.get_parent();
        if (currentParent) {
            currentParent.remove_child(this.indicator);
        }
        
        // If moving to/from status area, we need to remove it from status area tracking
        // Check if it's currently registered in status area
        // Note: statusArea._indicators is a private API - check existence before use
        try {
            if (Main.panel.statusArea && Main.panel.statusArea._indicators) {
                // Try to remove from status area's internal tracking if it exists
                try {
                    const indicators = Main.panel.statusArea._indicators;
                    if (indicators.get_children().includes(this.indicator)) {
                        indicators.remove_child(this.indicator);
                    }
                } catch (e) {
                    // Ignore - might not be in status area or API changed
                    Logger.debug(`Could not remove from status area indicators: ${e.message}`);
                }
            }
        } catch (e) {
            // Ignore - statusArea or _indicators might not exist
            Logger.debug(`Status area API not available: ${e.message}`);
        }
        
        // Add to the appropriate panel area
        // Note: _leftBox and _centerBox are private APIs and may not be available in all GNOME versions
        // Check for API availability before using
        try {
            if (position === 'left') {
                if (Main.panel._leftBox) {
                    Main.panel._leftBox.insert_child_at_index(this.indicator, -1);
                    Logger.info('Added indicator to left panel');
                    return;
                } else {
                    Logger.info('Left panel API (_leftBox) not available, falling back to right');
                }
            } else if (position === 'center') {
                if (Main.panel._centerBox) {
                    Main.panel._centerBox.insert_child_at_index(this.indicator, -1);
                    Logger.info('Added indicator to center panel');
                    return;
                } else {
                    Logger.info('Center panel API (_centerBox) not available, falling back to right');
                }
            }
        } catch (e) {
            Logger.warn(`Could not add indicator to ${position} panel: ${e.message}, falling back to right`);
        }
        
        // Default to right (status area)
        // Insert just before system controls (power, settings, etc.) instead of at the end
        try {
            // Try different approaches to add to status area
            if (Main.panel.statusArea) {
                // Check if statusArea has _rightBox (most common structure)
                // Note: _rightBox is a private API - check existence before use
                try {
                    if (Main.panel.statusArea._rightBox) {
                        const container = Main.panel.statusArea._rightBox;
                        const children = container.get_children();
                        // Find system indicators (usually at the end) and insert before them
                        // System indicators are typically the last few items
                        // Insert at position that's before the system controls
                        const insertIndex = Math.max(0, children.length - 3); // Insert before last 3 items (system controls)
                        container.insert_child_at_index(this.indicator, insertIndex);
                        Logger.info(`Added indicator to right panel (status area) via _rightBox at index ${insertIndex}`);
                        return;
                    }
                } catch (e) {
                    Logger.debug(`_rightBox API not available: ${e.message}`);
                }
                
                // Check for _indicators container
                // Note: _indicators is a private API - check existence before use
                try {
                    if (Main.panel.statusArea._indicators) {
                        const container = Main.panel.statusArea._indicators;
                        const children = container.get_children();
                        const insertIndex = Math.max(0, children.length - 3); // Insert before last 3 items
                        container.insert_child_at_index(this.indicator, insertIndex);
                        Logger.info(`Added indicator to right panel (status area) via _indicators at index ${insertIndex}`);
                        return;
                    }
                } catch (e) {
                    Logger.debug(`_indicators API not available: ${e.message}`);
                }
                // Check if statusArea itself is a container
                if (typeof Main.panel.statusArea.insert_child_at_index === 'function') {
                    const container = Main.panel.statusArea;
                    const children = container.get_children();
                    const insertIndex = Math.max(0, children.length - 3); // Insert before last 3 items
                    container.insert_child_at_index(this.indicator, insertIndex);
                    Logger.info(`Added indicator to right panel (status area) at index ${insertIndex}`);
                    return;
                }
                // Check if statusArea has add_child or append methods
                if (typeof Main.panel.statusArea.add_child === 'function') {
                    // For add_child, we need to find where to insert
                    // Try to find system controls and insert before them
                        const container = Main.panel.statusArea;
                    const children = container.get_children();
                    // Find a good insertion point (before system controls)
                    // System controls are usually added last, so insert before the last few
                    if (children.length > 0) {
                        // Remove all children temporarily to find insertion point
                        // Actually, better to just add and then reorder
                        container.add_child(this.indicator);
                        // Move to before system controls
                        const targetIndex = Math.max(0, children.length - 2);
                        container.set_child_at_index(this.indicator, targetIndex);
                        Logger.info(`Added indicator to right panel (status area) via add_child at index ${targetIndex}`);
                    } else {
                        container.add_child(this.indicator);
                        Logger.info('Added indicator to right panel (status area) via add_child');
                    }
                    return;
                }
            }
            
            // If statusArea methods don't work, try panel's _rightBox directly
            // Note: _rightBox is a private API - check existence before use
            try {
                if (Main.panel._rightBox) {
                    const container = Main.panel._rightBox;
                    const children = container.get_children();
                    const insertIndex = Math.max(0, children.length - 3); // Insert before last 3 items
                    container.insert_child_at_index(this.indicator, insertIndex);
                    Logger.info(`Added indicator to right panel via panel._rightBox at index ${insertIndex}`);
                    return;
                }
            } catch (e) {
                Logger.debug(`panel._rightBox API not available: ${e.message}`);
            }
            
            // Last resort: use addToStatusArea (public API - should always work)
            // Only use this if the indicator was never added before
            if (!this._wasInStatusArea) {
                try {
                    Main.panel.addToStatusArea('release-monitor', this.indicator);
                    this._wasInStatusArea = true;
                    // Try to move it to before system controls (using private API if available)
                    try {
                        if (Main.panel.statusArea && Main.panel.statusArea._rightBox) {
                            const container = Main.panel.statusArea._rightBox;
                            const children = container.get_children();
                            const currentIndex = children.indexOf(this.indicator);
                            if (currentIndex >= 0) {
                                const targetIndex = Math.max(0, children.length - 4); // Before system controls
                                if (currentIndex !== targetIndex) {
                                    container.set_child_at_index(this.indicator, targetIndex);
                                    Logger.info(`Moved indicator from index ${currentIndex} to ${targetIndex}`);
                                }
                            }
                        }
                    } catch (e) {
                        // Ignore - reordering is optional, indicator is already added
                        Logger.debug(`Could not reorder indicator: ${e.message}`);
                    }
                    Logger.info('Added indicator to right panel (status area) via addToStatusArea (public API)');
                    return;
                } catch (e) {
                    Logger.error(`Failed to add indicator via addToStatusArea: ${e.message}`);
                }
            } else {
                Logger.error('Cannot use addToStatusArea - indicator already registered. Status area structure not accessible.');
            }
        } catch (e) {
            Logger.error(`Failed to add indicator to status area: ${e.message}`);
            // Final fallback: try addToStatusArea even if _wasInStatusArea is true
            // This might work if the indicator was removed from status area
            try {
                Main.panel.addToStatusArea('release-monitor', this.indicator);
                this._wasInStatusArea = true;
                Logger.info('Added indicator to right panel (status area) via addToStatusArea (fallback)');
            } catch (e2) {
                Logger.error(`Final fallback failed: ${e2.message}`);
            }
        }
    }
    
    _moveIndicator() {
        if (!this.indicator) {
            return;
        }
        
        // Remove from current position
        if (this.indicator.get_parent()) {
            this.indicator.get_parent().remove_child(this.indicator);
        }
        
        // Add to new position
        this._addIndicatorToPanel();
    }

    _startSignalMonitor() {
        // Get signal directory from config manager
        const signalsDir = this.configManager._getSignalDirectory();
        
        // Ensure directory exists
        this.configManager._ensureSignalDir();
        
        // Monitor directory for file creation events
        try {
            const monitor = signalsDir.monitor_directory(
                Gio.FileMonitorFlags.WATCH_MOVES,
                null
            );
            
            monitor.connect('changed', (monitor, file, otherFile, eventType) => {
                try {
                    // Handle create and content-change so `touch reload` works when file already exists
                    if (eventType === Gio.FileMonitorEvent.CREATED ||
                        eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                        eventType === Gio.FileMonitorEvent.CHANGED) {
                        const basename = file.get_basename();
                        
                        if (basename === 'reload') {
                            this._handleReloadSignal(file);
                        } else if (basename === 'open-settings') {
                            this._handleOpenSettingsSignal(file);
                        } else if (basename === 'update-settings') {
                            this._handleUpdateSettingsSignal(file);
                        }
                    }
                } catch (e) {
                    Logger.warn(`Error handling signal event: ${e.message}`);
                }
            });
            
            this._signalMonitor = monitor;
            Logger.debug('Signal monitor started');
        } catch (e) {
            Logger.error('Failed to start signal monitor', e);
        }
    }

    _handleReloadSignal(signalFile) {
        try {
            if (this._reloadInProgress) {
                return;
            }
            this._reloadInProgress = true;
            Logger.debug('Reload signal detected, checking for updates...');
            // Reload config first to get any newly added projects
            this.configManager.load();
            this.checkForUpdates().finally(() => {
                this._reloadInProgress = false;
            });
            // Delete the signal file
            try {
                signalFile.delete(null);
            } catch (e) {
                Logger.warn(`Could not delete reload signal file: ${e.message}`);
            }
        } catch (e) {
            this._reloadInProgress = false;
            Logger.warn(`Error handling reload signal: ${e.message}`);
        }
    }

    _handleOpenSettingsSignal(signalFile) {
        try {
            Logger.info('Settings signal detected, opening settings window...');
            this._openSettingsWindow();
            // Delete the signal file
            try {
                signalFile.delete(null);
            } catch (e) {
                Logger.warn(`Could not delete settings signal file: ${e.message}`);
            }
        } catch (e) {
            Logger.warn(`Error handling open settings signal: ${e.message}`);
        }
    }

    _handleUpdateSettingsSignal(signalFile) {
        try {
            Logger.debug('Settings update signal detected, reading settings...');
            this._applySettingsUpdate();
            // Delete the signal file
            try {
                signalFile.delete(null);
            } catch (e) {
                Logger.warn(`Could not delete settings update signal file: ${e.message}`);
            }
        } catch (e) {
            Logger.warn(`Error handling settings update signal: ${e.message}`);
        }
    }
    
    _getRhelCdnSetting(key) {
        try {
            return this.settings.get_string(key) || '';
        } catch (e) {
            Logger.warn(`Could not read ${key}: ${e.message}`);
            return '';
        }
    }

    _openSettingsWindow() {
        // Check if settings window is already open
        if (this._settingsWindowProcessId) {
            // Check if the process is still running
            // Note: /proc is Linux-specific, but GNOME Shell extensions only run on Linux
            const procPath = `/proc/${this._settingsWindowProcessId}`;
            const procFile = Gio.File.new_for_path(procPath);
            if (procFile.query_exists(null)) {
                Logger.info('_openSettingsWindow: Settings window already open, skipping');
                return;
            } else {
                // Process doesn't exist, clear the ID and continue
                Logger.info('_openSettingsWindow: Previous settings window process no longer exists, clearing ID');
                this._settingsWindowProcessId = null;
            }
        }
        
        // Get the extension directory path
        const extensionDir = this.path;
        const settingsWindowScript = GLib.build_filenamev([extensionDir, 'settings-window.js']);
        
        // Launch the settings window script
        try {
            const scriptFile = Gio.File.new_for_path(settingsWindowScript);
            if (!scriptFile.query_exists(null)) {
                throw new Error(`Settings window script not found: ${settingsWindowScript}`);
            }
            
            // Get current settings to pass to the window
            const currentInterval = this.settings.get_int('refresh-interval');
            let currentPosition = 'right';
            try {
                currentPosition = this.settings.get_string('icon-position') || 'right';
            } catch (e) {
                Logger.warn(`Could not read icon-position: ${e.message}`);
            }
            
            let currentApiToken = '';
            try {
                currentApiToken = this.settings.get_string('release-monitoring-api-token') || '';
            } catch (e) {
                Logger.warn(`Could not read release-monitoring-api-token: ${e.message}`);
            }

            const certPath = this._getRhelCdnSetting('rhel-cdn-cert-path');
            const keyPath = this._getRhelCdnSetting('rhel-cdn-key-path');
            const caPath = this._getRhelCdnSetting('rhel-cdn-ca-path');
            
            Logger.info(`_openSettingsWindow: Launching ${settingsWindowScript} with interval=${currentInterval}, position=${currentPosition}, apiToken=${currentApiToken ? '***' : '(empty)'}`);
            
            const [success, pid] = GLib.spawn_async(
                null,
                [
                    'gjs', '-m', settingsWindowScript, extensionDir,
                    this.metadata.version || '1',
                    currentInterval.toString(),
                    currentPosition,
                    currentApiToken,
                    certPath,
                    keyPath,
                    caPath
                ],
                null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null
            );
            
            if (!success) {
                throw new Error('Failed to launch settings window script');
            }
            
            // Track the process ID to prevent multiple windows
            this._settingsWindowProcessId = pid;
            Logger.info(`_openSettingsWindow: Process launched with PID ${pid}`);
            
            // Monitor process to clear the ID when it exits
            GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (pid, status) => {
                Logger.info(`_openSettingsWindow: Process ${pid} exited with status ${status}`);
                this._settingsWindowProcessId = null;
                GLib.spawn_close_pid(pid);
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            Logger.error("Error launching settings window", e);
            Main.notify('Error', `Failed to open settings window: ${e.message}`);
        }
    }
    
    
    _applySettingsUpdate() {
        // Read settings from JSON file in signals directory
        const settingsFile = this.configManager.getSignalFile('settings-update.json');
        try {
            if (settingsFile.query_exists(null)) {
                const [success, contents] = settingsFile.load_contents(null);
                if (success) {
                    const decoder = new TextDecoder('utf-8');
                    const jsonData = decoder.decode(contents);
                    const settingsData = JSON.parse(jsonData);
                    
                    Logger.debug(`_applySettingsUpdate: Applying settings: ${JSON.stringify(settingsData)}`);
                    
                    // Update icon position
                    if (settingsData.iconPosition) {
                        this.settings.set_string('icon-position', settingsData.iconPosition);
                        Logger.info(`_applySettingsUpdate: Icon position set to ${settingsData.iconPosition}`);
                    }
                    
                    // Update refresh interval
                    if (settingsData.refreshInterval) {
                        this.settings.set_int('refresh-interval', settingsData.refreshInterval);
                        Logger.info(`_applySettingsUpdate: Refresh interval set to ${settingsData.refreshInterval} seconds`);
                        // Restart the check interval with new value
                        this._restartCheckInterval();
                    }
                    
                    // Update API token and recreate ReleaseMonitoringAPI
                    if (settingsData.apiToken !== undefined) {
                        this.settings.set_string('release-monitoring-api-token', settingsData.apiToken || '');
                        Logger.info(`_applySettingsUpdate: API token ${settingsData.apiToken ? 'updated' : 'cleared'}`);
                        // Recreate the API instance with the new token
                        this.releaseMonitoringAPI = new ReleaseMonitoringAPI(settingsData.apiToken || null);
                    }

                    if (settingsData.rhelCdnCertPath !== undefined) {
                        this.settings.set_string('rhel-cdn-cert-path', settingsData.rhelCdnCertPath || '');
                    }
                    if (settingsData.rhelCdnKeyPath !== undefined) {
                        this.settings.set_string('rhel-cdn-key-path', settingsData.rhelCdnKeyPath || '');
                    }
                    if (settingsData.rhelCdnCaPath !== undefined) {
                        this.settings.set_string('rhel-cdn-ca-path', settingsData.rhelCdnCaPath || '');
                    }
                    if (this.redhatCdnAPI && (
                        settingsData.rhelCdnCertPath !== undefined ||
                        settingsData.rhelCdnKeyPath !== undefined ||
                        settingsData.rhelCdnCaPath !== undefined
                    )) {
                        this.redhatCdnAPI.setCertificatePaths(
                            this._getRhelCdnSetting('rhel-cdn-cert-path'),
                            this._getRhelCdnSetting('rhel-cdn-key-path'),
                            this._getRhelCdnSetting('rhel-cdn-ca-path')
                        );
                        Logger.info('_applySettingsUpdate: RHEL CDN certificate paths updated');
                    }
                    
                    // Delete the settings file
                    try {
                        settingsFile.delete(null);
                    } catch (e) {
                        Logger.warn(`Could not delete settings file: ${e.message}`);
                    }
                }
            }
        } catch (e) {
            Logger.error("Error applying settings update", e);
        }
    }
    
    _restartCheckInterval() {
        // Remove old interval
        if (this.checkInterval) {
            GLib.source_remove(this.checkInterval);
            this.checkInterval = null;
        }
        
        // Get new interval from settings
        const interval = this.settings.get_int('refresh-interval');
        Logger.info(`_restartCheckInterval: Starting check interval with ${interval} seconds`);
        
        // Start new interval
        this.checkInterval = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this.checkForUpdates();
                return true; // Continue the timeout
            }
        );
    }

    /**
     * Safely terminate a process by PID
     * Tries SIGTERM first for graceful shutdown, then SIGKILL if needed
     * Uses GLib.spawn_async with argument arrays to avoid shell injection
     * @param {number} pid - Process ID to terminate
     * @param {string} processName - Name for logging purposes
     * @returns {boolean} - True if process was terminated, false otherwise
     */
    _terminateProcess(pid, processName = 'process') {
        if (!pid || pid <= 0) {
            return false;
        }
        
        try {
            // Check if process still exists
            // Note: /proc is Linux-specific, but GNOME Shell extensions only run on Linux
            const procPath = `/proc/${pid}`;
            const procFile = Gio.File.new_for_path(procPath);
            if (!procFile.query_exists(null)) {
                // Process already exited
                Logger.debug(`${processName} ${pid} already exited`);
                return true;
            }
            
            // Try SIGTERM first for graceful termination
            // Use spawn_async with argument array to avoid shell injection
            // PID is validated (must be > 0) and comes from our internal tracking
            Logger.debug(`Sending SIGTERM to ${processName} ${pid}`);
            const pidStr = pid.toString();
            try {
                const [termSuccess, termPid] = GLib.spawn_async(
                    null,
                    ['kill', '-TERM', pidStr],
                    null,
                    GLib.SpawnFlags.SEARCH_PATH,
                    null
                );
                
                if (termSuccess) {
                    // Wait for kill process to complete and check result
                    GLib.spawn_close_pid(termPid);
                    // Wait a bit for graceful shutdown (500ms)
                    GLib.usleep(500_000);
                    
                    // Check if process still exists
                    if (!procFile.query_exists(null)) {
                        Logger.debug(`${processName} ${pid} terminated gracefully with SIGTERM`);
                        return true;
                    }
                }
            } catch (termError) {
                Logger.debug(`SIGTERM failed for ${processName} ${pid}: ${termError.message}`);
            }
            
            // Process still running, use SIGKILL
            Logger.debug(`Sending SIGKILL to ${processName} ${pid}`);
            try {
                const [killSuccess, killPid] = GLib.spawn_async(
                    null,
                    ['kill', '-9', pidStr],
                    null,
                    GLib.SpawnFlags.SEARCH_PATH,
                    null
                );
                
                if (killSuccess) {
                    GLib.spawn_close_pid(killPid);
                    // Brief wait to ensure kill completes
                    GLib.usleep(100_000);
                    
                    // Verify process was actually killed
                    if (!procFile.query_exists(null)) {
                        Logger.debug(`Killed ${processName} ${pid} with SIGKILL`);
                        return true;
                    } else {
                        Logger.warn(`SIGKILL sent to ${processName} ${pid} but process still exists`);
                        return false;
                    }
                } else {
                    Logger.warn(`Failed to spawn kill command for ${processName} ${pid}`);
                    return false;
                }
            } catch (killError) {
                Logger.warn(`SIGKILL failed for ${processName} ${pid}: ${killError.message}`);
                return false;
            }
        } catch (e) {
            Logger.warn(`Error terminating ${processName} ${pid}: ${e.message}`);
            return false;
        }
    }

    disable() {
        // Remove signal monitor
        if (this._signalMonitor) {
            this._signalMonitor.cancel();
            this._signalMonitor = null;
        }
        
        // Disconnect signal handlers
        if (this._settingsChangedId) {
            this.settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        
        // Kill spawned processes
        // Report window process ID is stored in the indicator
        const reportWindowPid = this.indicator ? this.indicator._reportWindowProcessId : null;
        if (reportWindowPid) {
            try {
                this._terminateProcess(reportWindowPid, 'report window');
                // Close the PID handle
                GLib.spawn_close_pid(reportWindowPid);
                // Clear the PID from indicator
                if (this.indicator) {
                    this.indicator._reportWindowProcessId = null;
                }
            } catch (e) {
                Logger.warn(`Error terminating report window process: ${e.message}`);
                // Try to close PID handle even if kill failed
                try {
                    GLib.spawn_close_pid(reportWindowPid);
                } catch (e2) {
                    // Ignore errors closing PID
                }
                // Clear the PID from indicator even if kill failed
                if (this.indicator) {
                    this.indicator._reportWindowProcessId = null;
                }
            }
        }
        
        if (this._settingsWindowProcessId) {
            try {
                this._terminateProcess(this._settingsWindowProcessId, 'settings window');
                // Close the PID handle
                GLib.spawn_close_pid(this._settingsWindowProcessId);
            } catch (e) {
                Logger.warn(`Error terminating settings window process: ${e.message}`);
                // Try to close PID handle even if kill failed
                try {
                    GLib.spawn_close_pid(this._settingsWindowProcessId);
                } catch (e2) {
                    // Ignore errors closing PID
                }
            }
            this._settingsWindowProcessId = null;
        }
        
        // Kill preferences window process (gnome-extensions prefs)
        // Note: The preferences window is managed by the Extensions app, so killing our process
        // might not close the window. We try to kill our tracked process first, then search for
        // any gnome-extensions processes that might be related to our extension.
        if (this._prefsProcessId) {
            try {
                this._terminateProcess(this._prefsProcessId, 'preferences');
                // Close the PID handle
                GLib.spawn_close_pid(this._prefsProcessId);
            } catch (e) {
                Logger.warn(`Error terminating preferences process: ${e.message}`);
                // Try to close PID handle even if kill failed
                try {
                    GLib.spawn_close_pid(this._prefsProcessId);
                } catch (e2) {
                    // Ignore errors closing PID
                }
            }
            this._prefsProcessId = null;
        }
        
        // Try to find and kill any gnome-extensions processes related to our extension
        // This is a best-effort attempt - the preferences window is managed by the Extensions app
        // and may remain open even after we kill related processes.
        try {
            const extensionUuid = this.metadata.uuid;
            // Use pgrep with a more specific pattern to avoid false matches:
            // - Must contain "gnome-extensions"
            // - Must contain "prefs" (for preferences window)
            // - Must contain the extension UUID
            // This ensures we only match the preferences window for our specific extension
            const [success, stdout] = GLib.spawn_command_line_sync(
                `pgrep -f "gnome-extensions.*prefs.*${extensionUuid}" || true`
            );
            if (success && stdout) {
                const decoder = new TextDecoder('utf-8');
                const pidsStr = decoder.decode(stdout).trim();
                if (pidsStr) {
                    const pids = pidsStr.split('\n').filter(pid => pid.trim() !== '');
                    for (const pid of pids) {
                        const pidNum = parseInt(pid.trim(), 10);
                        if (!isNaN(pidNum) && pidNum > 0) {
                            // Additional safety: verify the command line contains our UUID
                            // before terminating (defense in depth)
                            try {
                                const cmdlinePath = `/proc/${pidNum}/cmdline`;
                                const cmdlineFile = Gio.File.new_for_path(cmdlinePath);
                                if (cmdlineFile.query_exists(null)) {
                                    const [readSuccess, cmdlineContents] = cmdlineFile.load_contents(null);
                                    if (readSuccess) {
                                        const cmdlineDecoder = new TextDecoder('utf-8');
                                        const cmdline = cmdlineDecoder.decode(cmdlineContents);
                                        // Verify UUID is actually in the command line
                                        if (cmdline.includes(extensionUuid) && cmdline.includes('prefs')) {
                                            this._terminateProcess(pidNum, `gnome-extensions prefs (${extensionUuid})`);
                                        } else {
                                            Logger.debug(`Skipping process ${pidNum} - UUID not found in command line`);
                                        }
                                    }
                                }
                            } catch (verifyError) {
                                // If verification fails, skip this process to be safe
                                Logger.debug(`Could not verify process ${pidNum}: ${verifyError.message}`);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // pgrep might not be available or might fail - this is not critical
            Logger.warn(`Could not search for gnome-extensions processes: ${e.message}`);
        }
        
        // Remove UI elements
        if (this.indicator) {
            // Remove from panel before destroying
            const parent = this.indicator.get_parent();
            if (parent) {
                parent.remove_child(this.indicator);
            }
            this.indicator.destroy();
            this.indicator = null;
        }
        
        // Cancel intervals
        if (this.checkInterval) {
            GLib.source_remove(this.checkInterval);
            this.checkInterval = null;
        }
        
        // Clear references
        this.configManager = null;
        this.githubAPI = null;
        this.releaseMonitoringAPI = null;
        this.settings = null;
    }

    async checkForUpdates() {
        // Reload config to get latest projects (in case they were added via prefs.js)
        this.configManager.load();
        const projects = this.configManager.getProjects();
        Logger.debug(`checkForUpdates: Checking ${projects.length} projects`);
        let hasNewReleases = false;
        
        // Run sequentially to avoid ConfigManager save/load races wiping updates
        for (const project of projects) {
            await (async () => {
            try {
                const source = project.source || 'github'; // Default to github for backward compatibility
                const versionFilter = project.versionFilter || null;
                
                let release = null;
                let projectIdentifier = '';
                
                if (source === 'release-monitoring') {
                    const projectName = project.projectName || project.owner; // Fallback to owner for compatibility
                    projectIdentifier = projectName;
                    Logger.debug(`checkForUpdates: Checking release-monitoring.org project "${projectName}"${versionFilter ? ` (filter: ${versionFilter})` : ''}`);
                    release = await this.releaseMonitoringAPI.getLatestRelease(projectName, versionFilter);
                } else if (source === 'rhel-cdn') {
                    const major = project.major || project.owner;
                    const arch = project.arch || 'x86_64';
                    projectIdentifier = `rhel-${major}/kernel`;
                    Logger.debug(`checkForUpdates: Checking RHEL ${major} kernel via CDN (${arch})`);
                    // Refresh cert paths from settings each check
                    this.redhatCdnAPI.setCertificatePaths(
                        this._getRhelCdnSetting('rhel-cdn-cert-path'),
                        this._getRhelCdnSetting('rhel-cdn-key-path'),
                        this._getRhelCdnSetting('rhel-cdn-ca-path')
                    );
                    release = await this.redhatCdnAPI.getLatestKernel(major, arch);
                } else {
                    // GitHub
                    projectIdentifier = `${project.owner}/${project.repo}`;
                    Logger.debug(`checkForUpdates: Checking GitHub ${projectIdentifier}${versionFilter ? ` (filter: ${versionFilter})` : ''}`);
                    release = await this.githubAPI.getLatestRelease(project.owner, project.repo, versionFilter);
                }
                
                if (release) {
                    const releaseVersion = release.tag_name || release.version || release.name;
                    Logger.debug(`checkForUpdates: Found release ${releaseVersion} for ${projectIdentifier}`);
                    Logger.debug(`checkForUpdates: Release object: ${JSON.stringify({tag_name: release.tag_name, version: release.version, name: release.name})}`);
                    
                    // Check if this is a new release
                    // We use published date as the primary indicator since version strings can be misleading
                    // (e.g., version filters might match older releases, or version formats might differ)
                    const isNewRelease = (() => {
                        // First successful observation: store baseline without notifying
                        if (!project.lastRelease) {
                            Logger.info(`checkForUpdates: No previous release for ${projectIdentifier}, storing baseline (no notification)`);
                            return false;
                        }
                        
                        // Get published dates for comparison (most reliable indicator)
                        const releaseDate = release.published_at ? new Date(release.published_at) : null;
                        const lastReleaseDate = project.lastRelease.published_at
                            ? new Date(project.lastRelease.published_at)
                            : null;
                        
                        // If both dates are available, compare them
                        if (releaseDate && lastReleaseDate) {
                            if (releaseDate > lastReleaseDate) {
                                Logger.info(`checkForUpdates: Date changed from ${lastReleaseDate.toISOString()} to ${releaseDate.toISOString()} for ${projectIdentifier}`);
                                return true;
                            } else if (releaseDate < lastReleaseDate) {
                                Logger.info(`checkForUpdates: Release date is older (${releaseDate.toISOString()} < ${lastReleaseDate.toISOString()}) for ${projectIdentifier}, not marking as new`);
                                return false;
                            }
                            // Dates are equal, check version string as fallback
                        }
                        
                        // If dates aren't available or are equal, compare version strings
                        // But only mark as new if version is actually different (not just different format)
                        const lastReleaseVersion = project.lastRelease.tag_name || project.lastRelease.version || project.lastRelease.name;
                        if (lastReleaseVersion !== releaseVersion) {
                            // If dates are equal, don't mark as new (might be a re-tag or version filter matching older release)
                            // Exception: RHEL CDN/Security Data versions can change with identical published timestamps
                            if (releaseDate && lastReleaseDate && releaseDate.getTime() === lastReleaseDate.getTime()) {
                                if (source === 'rhel-cdn') {
                                    Logger.info(`checkForUpdates: RHEL kernel version changed from ${lastReleaseVersion} to ${releaseVersion} for ${projectIdentifier} (equal dates)`);
                                    return true;
                                }
                                Logger.info(`checkForUpdates: Version changed from ${lastReleaseVersion} to ${releaseVersion} for ${projectIdentifier}, but dates are equal - not marking as new`);
                                return false;
                            }
                            // For release-monitoring.org, if dates aren't available, we have to rely on version strings
                            // This is less reliable but necessary when dates aren't provided
                            if (source === 'release-monitoring' && !releaseDate) {
                                Logger.info(`checkForUpdates: Version changed from ${lastReleaseVersion} to ${releaseVersion} for ${projectIdentifier} (no date available, using version comparison)`);
                                return true;
                            }
                            if (source === 'rhel-cdn') {
                                Logger.info(`checkForUpdates: RHEL kernel version changed from ${lastReleaseVersion} to ${releaseVersion} for ${projectIdentifier}`);
                                return true;
                            }
                            // If we have a newer date (or dates are unavailable), version change indicates new release
                            if (!releaseDate || !lastReleaseDate || releaseDate > lastReleaseDate) {
                                Logger.info(`checkForUpdates: Version changed from ${lastReleaseVersion} to ${releaseVersion} for ${projectIdentifier}`);
                                return true;
                            }
                            // If date is older, don't mark as new (version filter might have matched older release)
                            Logger.info(`checkForUpdates: Version changed from ${lastReleaseVersion} to ${releaseVersion} for ${projectIdentifier}, but date is older - not marking as new`);
                            return false;
                        }
                        
                        // No change detected
                        return false;
                    })();
                    
                    // Always update the config with the latest release info
                    Logger.debug(`checkForUpdates: Calling updateProjectRelease for ${projectIdentifier} with release version ${releaseVersion}, isNewRelease: ${isNewRelease}`);
                    try {
                        const versionFilter = project.versionFilter || null;
                        if (source === 'release-monitoring') {
                            this.configManager.updateProjectRelease(
                                null, // owner not used for release-monitoring
                                null, // repo not used for release-monitoring
                                release,
                                source,
                                project.projectName || project.owner,
                                versionFilter,
                                isNewRelease
                            );
                        } else if (source === 'rhel-cdn') {
                            this.configManager.updateProjectRelease(
                                project.major,
                                null,
                                release,
                                source,
                                `rhel-${project.major}/kernel`,
                                null,
                                isNewRelease
                            );
                        } else {
                            this.configManager.updateProjectRelease(
                                project.owner,
                                project.repo,
                                release,
                                source,
                                null, // projectName not used for GitHub
                                versionFilter,
                                isNewRelease
                            );
                        }
                        Logger.debug(`checkForUpdates: updateProjectRelease completed for ${projectIdentifier}`);
                        // Verify the update by reloading and checking
                        this.configManager.load();
                        const updatedProject = this.configManager.getProjects().find(
                            p => {
                                if (source === 'release-monitoring') {
                                    return p.source === 'release-monitoring' && p.projectName === (project.projectName || project.owner);
                                }
                                if (source === 'rhel-cdn') {
                                    return p.source === 'rhel-cdn' && String(p.major) === String(project.major);
                                }
                                return (p.source === 'github' || !p.source) && p.owner === project.owner && p.repo === project.repo;
                            }
                        );
                        if (updatedProject && updatedProject.lastRelease) {
                            const savedVersion = updatedProject.lastRelease.tag_name || updatedProject.lastRelease.version || updatedProject.lastRelease.name;
                            Logger.info(`checkForUpdates: Verified saved version is ${savedVersion} for ${projectIdentifier}`);
                            // Keep in-memory project fresh for later iterations in this run
                            project.lastRelease = updatedProject.lastRelease;
                            project.lastChecked = updatedProject.lastChecked;
                        } else {
                            Logger.error(`checkForUpdates: WARNING - Could not verify saved release for ${projectIdentifier}`);
                        }
                    } catch (e) {
                        Logger.error(`checkForUpdates: Error updating project release: ${e.message}`, e);
                    }
                    
                    // Check if this is a new release
                    if (isNewRelease) {
                        hasNewReleases = true;
                        
                        // Show notification
                        const displayName = source === 'release-monitoring' 
                            ? projectIdentifier 
                            : (source === 'rhel-cdn' ? `RHEL ${project.major} kernel` : projectIdentifier);
                        try {
                            this.showNotification(
                                `New release: ${displayName}`,
                                `${release.name || releaseVersion} (${releaseVersion})`,
                                release.html_url || `https://release-monitoring.org/project/?name=${encodeURIComponent(projectIdentifier)}`
                            );
                        } catch (notifyErr) {
                            Logger.warn(`showNotification failed for ${projectIdentifier}: ${notifyErr.message}`);
                        }
                    }
                    
                    // Rebuild menu to show updated release info
                    // Use GLib.idle_add to ensure menu rebuild happens after config save
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        if (this.indicator) {
                            Logger.info(`checkForUpdates: Rebuilding menu after release update`);
                            this.indicator._buildMenu();
                        }
                        return false; // Don't repeat
                    });
                } else {
                    Logger.info(`checkForUpdates: No releases found for ${projectIdentifier}`);
                }
            } catch (e) {
                const projectIdentifier = project.source === 'release-monitoring' 
                    ? (project.projectName || project.owner || 'unknown')
                    : (project.source === 'rhel-cdn'
                        ? `rhel-${project.major}/kernel`
                        : `${project.owner}/${project.repo}`);
                Logger.error(`Error checking ${projectIdentifier}: ${e.message}`, e);
            }
            })();
        }
        
        // Update indicator icon
        if (this.indicator) {
            this.indicator.updateIcon(hasNewReleases);
        }
    }

    showNotification(title, body, url) {
        // GNOME 49+: SystemNotificationSource was removed; Main.notify is stable.
        // Keep url activation best-effort via default handler when possible.
        try {
            Main.notify(title, body);
        } catch (e) {
            Logger.warn(`Main.notify failed: ${e.message}`);
        }
        if (url) {
            try {
                // Also try richer tray notification when available
                if (MessageTray.Source && MessageTray.Notification) {
                    const source = new MessageTray.Source({
                        title: 'Release Monitor',
                        iconName: 'software-update-available-symbolic',
                    });
                    Main.getMessageTray().add(source);
                    const notification = new MessageTray.Notification({
                        source,
                        title,
                        body,
                        isTransient: true,
                    });
                    notification.connect('activated', () => {
                        try {
                            Gio.AppInfo.launch_default_for_uri(url, null);
                        } catch (err) {
                            Logger.warn(`Error opening URL: ${err.message}`);
                        }
                    });
                    source.addNotification(notification);
                }
            } catch (e) {
                Logger.debug(`Rich notification unavailable: ${e.message}`);
            }
        }
    }
}
