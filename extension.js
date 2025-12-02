import St from "gi://St";
import GObject from "gi://GObject";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";
import Soup from "gi://Soup";
imports.gi.versions.Soup = '3.0';
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as MessageTray from "resource:///org/gnome/shell/ui/messageTray.js";
import { ConfigManager } from "./configManager.js";
import { GitHubAPI } from "./githubAPI.js";
import { ReleaseMonitoringAPI } from "./releaseMonitoringAPI.js";
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
        this.indicator = null;
        this.checkInterval = null;
        this.settings = null;
        this._settingsChangedId = null;
        this._wasInStatusArea = false; // Track if indicator was ever added via addToStatusArea
        this._settingsWatchId = null; // File watcher for settings signal
        this._settingsUpdateWatchId = null; // File watcher for settings updates
        this._reloadWatchId = null; // File watcher for reload signal
        this._settingsWindowProcessId = null; // Track settings window process
        this._prefsProcessId = null; // Track preferences window process (gnome-extensions prefs)
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
            
            // Watch for settings signal file from report window
            this._startSettingsWatcher();
            
            // Watch for settings updates from settings window
            this._startSettingsUpdateWatcher();
            
            // Watch for reload signal from report window
            this._startReloadWatcher();
            
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

    _startSettingsWatcher() {
        const signalFile = Gio.File.new_for_path('/tmp/release-monitor-open-settings');
        
        // Check for signal file periodically
        this._settingsWatchId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1, // Check every second
            () => {
                try {
                    if (signalFile.query_exists(null)) {
                        // Signal file exists - open settings window
                        Logger.info('Settings signal file detected, opening settings window...');
                        this._openSettingsWindow();
                        // Delete the signal file
                        try {
                            signalFile.delete(null);
                        } catch (e) {
                            Logger.warn(`Could not delete signal file: ${e.message}`);
                        }
                    }
                } catch (e) {
                    Logger.warn(`Error checking settings signal file: ${e.message}`);
                }
                return true; // Continue watching
            }
        );
    }
    
    _openSettingsWindow() {
        // Check if settings window is already open
        if (this._settingsWindowProcessId) {
            // Check if the process is still running
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
            
            Logger.info(`_openSettingsWindow: Launching ${settingsWindowScript} with interval=${currentInterval}, position=${currentPosition}, apiToken=${currentApiToken ? '***' : '(empty)'}`);
            
            const [success, pid] = GLib.spawn_async(
                null,
                ['gjs', '-m', settingsWindowScript, extensionDir, this.metadata.version || '1', currentInterval.toString(), currentPosition, currentApiToken],
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
    
    _startSettingsUpdateWatcher() {
        const signalFile = Gio.File.new_for_path('/tmp/release-monitor-update-settings');
        
        // Check for settings update signal file periodically
        this._settingsUpdateWatchId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1, // Check every second
            () => {
                try {
                    if (signalFile.query_exists(null)) {
                        // Signal file exists - read and apply settings
                        Logger.debug('Settings update signal file detected, reading settings...');
                        this._applySettingsUpdate();
                        // Delete the signal file
                        try {
                            signalFile.delete(null);
                        } catch (e) {
                            Logger.warn(`Could not delete signal file: ${e.message}`);
                        }
                    }
                } catch (e) {
                    Logger.warn(`Error checking settings update signal file: ${e.message}`);
                }
                return true; // Continue watching
            }
        );
    }
    
    _startReloadWatcher() {
        const signalFile = Gio.File.new_for_path('/tmp/release-monitor-reload');
        
        // Check for reload signal file periodically
        this._reloadWatchId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1, // Check every second
            () => {
                try {
                    if (signalFile.query_exists(null)) {
                        // Signal file exists - trigger reload
                        Logger.debug('Reload signal file detected, checking for updates...');
                        // Reload config first to get any newly added projects
                        this.configManager.load();
                        this.checkForUpdates();
                        // Delete the signal file
                        try {
                            signalFile.delete(null);
                        } catch (e) {
                            Logger.warn(`Could not delete reload signal file: ${e.message}`);
                        }
                    }
                } catch (e) {
                    Logger.warn(`Error checking reload signal file: ${e.message}`);
                }
                return true; // Continue watching
            }
        );
    }
    
    _applySettingsUpdate() {
        // Read settings from JSON file
        const settingsFile = Gio.File.new_for_path('/tmp/release-monitor-settings-update.json');
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

    disable() {
        // Remove file watchers
        if (this._reloadWatchId) {
            GLib.source_remove(this._reloadWatchId);
            this._reloadWatchId = null;
        }
        if (this._settingsUpdateWatchId) {
            GLib.source_remove(this._settingsUpdateWatchId);
            this._settingsUpdateWatchId = null;
        }
        if (this._settingsWatchId) {
            GLib.source_remove(this._settingsWatchId);
            this._settingsWatchId = null;
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
                const procPath = `/proc/${reportWindowPid}`;
                const procFile = Gio.File.new_for_path(procPath);
                if (procFile.query_exists(null)) {
                    // Process still exists, kill it synchronously to ensure it completes
                    // Use kill -9 (SIGKILL) for forceful termination
                    const [success, stdout, stderr, exitStatus] = GLib.spawn_command_line_sync(
                        `kill -9 ${reportWindowPid}`
                    );
                    if (success && exitStatus === 0) {
                        console.log(`Killed report window process ${reportWindowPid}`);
                    } else {
                        console.log(`Failed to kill report window process ${reportWindowPid}, exit status: ${exitStatus}`);
                    }
                    // Close the PID handle
                    GLib.spawn_close_pid(reportWindowPid);
                } else {
                    // Process already exited, just close the PID handle
                    GLib.spawn_close_pid(reportWindowPid);
                }
                // Clear the PID from indicator
                if (this.indicator) {
                    this.indicator._reportWindowProcessId = null;
                }
            } catch (e) {
                console.log(`Error killing report window process: ${e.message}`);
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
                const procPath = `/proc/${this._settingsWindowProcessId}`;
                const procFile = Gio.File.new_for_path(procPath);
                if (procFile.query_exists(null)) {
                    // Process still exists, kill it synchronously to ensure it completes
                    // Use kill -9 (SIGKILL) for forceful termination
                    const [success, stdout, stderr, exitStatus] = GLib.spawn_command_line_sync(
                        `kill -9 ${this._settingsWindowProcessId}`
                    );
                    if (success && exitStatus === 0) {
                        console.log(`Killed settings window process ${this._settingsWindowProcessId}`);
                    } else {
                        console.log(`Failed to kill settings window process ${this._settingsWindowProcessId}, exit status: ${exitStatus}`);
                    }
                    // Close the PID handle
                    GLib.spawn_close_pid(this._settingsWindowProcessId);
                } else {
                    // Process already exited, just close the PID handle
                    GLib.spawn_close_pid(this._settingsWindowProcessId);
                }
            } catch (e) {
                console.log(`Error killing settings window process: ${e.message}`);
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
                const procPath = `/proc/${this._prefsProcessId}`;
                const procFile = Gio.File.new_for_path(procPath);
                if (procFile.query_exists(null)) {
                    // Process still exists, kill it synchronously to ensure it completes
                    // Use kill -9 (SIGKILL) for forceful termination
                    const [success, stdout, stderr, exitStatus] = GLib.spawn_command_line_sync(
                        `kill -9 ${this._prefsProcessId}`
                    );
                    if (success && exitStatus === 0) {
                        console.log(`Killed preferences process ${this._prefsProcessId}`);
                    } else {
                        console.log(`Failed to kill preferences process ${this._prefsProcessId}, exit status: ${exitStatus}`);
                    }
                    // Close the PID handle
                    GLib.spawn_close_pid(this._prefsProcessId);
                } else {
                    // Process already exited, just close the PID handle
                    GLib.spawn_close_pid(this._prefsProcessId);
                }
            } catch (e) {
                console.log(`Error killing preferences process: ${e.message}`);
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
            // Use pgrep to find processes with our extension UUID in the command line
            const [success, stdout, stderr, exitStatus] = GLib.spawn_command_line_sync(
                `pgrep -f "gnome-extensions.*${extensionUuid}" || true`
            );
            if (success && stdout) {
                const decoder = new TextDecoder('utf-8');
                const pidsStr = decoder.decode(stdout).trim();
                if (pidsStr) {
                    const pids = pidsStr.split('\n').filter(pid => pid.trim() !== '');
                    for (const pid of pids) {
                        const pidNum = parseInt(pid.trim(), 10);
                        if (!isNaN(pidNum) && pidNum > 0) {
                            try {
                                const [killSuccess, killStdout, killStderr, killExitStatus] = GLib.spawn_command_line_sync(
                                    `kill -9 ${pidNum}`
                                );
                                if (killSuccess && killExitStatus === 0) {
                                    console.log(`Killed gnome-extensions process ${pidNum} related to ${extensionUuid}`);
                                }
                            } catch (killError) {
                                console.log(`Error killing process ${pidNum}: ${killError.message}`);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // pgrep might not be available or might fail - this is not critical
            console.log(`Could not search for gnome-extensions processes: ${e.message}`);
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
        
        const checkPromises = projects.map(async (project) => {
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
                    // For release-monitoring.org, published_at may be null, so we compare versions
                    // For GitHub, we compare both version and date to be more reliable
                    const isNewRelease = source === 'release-monitoring' 
                        ? (!project.lastRelease || (project.lastRelease.version || project.lastRelease.tag_name) !== releaseVersion)
                        : (() => {
                            // First check if version changed (more reliable than date)
                            const lastReleaseVersion = project.lastRelease 
                                ? (project.lastRelease.tag_name || project.lastRelease.version || project.lastRelease.name)
                                : null;
                            if (lastReleaseVersion !== releaseVersion) {
                                Logger.info(`checkForUpdates: Version changed from ${lastReleaseVersion} to ${releaseVersion}`);
                                return true;
                            }
                            // If version is the same, check date
                            const releaseDate = release.published_at ? new Date(release.published_at) : null;
                            const lastReleaseDate = project.lastRelease && project.lastRelease.published_at
                                ? new Date(project.lastRelease.published_at)
                                : null;
                            if (releaseDate && lastReleaseDate && releaseDate > lastReleaseDate) {
                                Logger.info(`checkForUpdates: Date changed from ${lastReleaseDate} to ${releaseDate}`);
                                return true;
                            }
                            // If no lastRelease, it's new
                            if (!project.lastRelease) {
                                return true;
                            }
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
                            p => source === 'release-monitoring' 
                                ? (p.source === 'release-monitoring' && p.projectName === (project.projectName || project.owner))
                                : (p.source === 'github' && p.owner === project.owner && p.repo === project.repo)
                        );
                        if (updatedProject && updatedProject.lastRelease) {
                            const savedVersion = updatedProject.lastRelease.tag_name || updatedProject.lastRelease.version || updatedProject.lastRelease.name;
                            Logger.info(`checkForUpdates: Verified saved version is ${savedVersion} for ${projectIdentifier}`);
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
                            : projectIdentifier;
                        this.showNotification(
                            `New release: ${displayName}`,
                            `${release.name || releaseVersion} (${releaseVersion})`,
                            release.html_url || `https://release-monitoring.org/project/?name=${encodeURIComponent(projectIdentifier)}`
                        );
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
                    : `${project.owner}/${project.repo}`;
                Logger.error(`Error checking ${projectIdentifier}: ${e.message}`, e);
            }
        });
        
        await Promise.all(checkPromises);
        
        // Update indicator icon
        if (this.indicator) {
            this.indicator.updateIcon(hasNewReleases);
        }
    }

    showNotification(title, body, url) {
        const source = new MessageTray.SystemNotificationSource();
        Main.messageTray.add(source);
        
        const notification = new MessageTray.Notification(source, title, body);
        notification.setUrgency(MessageTray.Urgency.NORMAL);
        
        notification.connect('activated', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(url, null);
            } catch (e) {
                log(`Error opening URL: ${e}`);
            }
        });
        
        source.notify(notification);
    }
}
