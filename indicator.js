import GObject from "gi://GObject";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

// ============================================================================
// ReleaseMonitorIndicator - Status bar indicator
// ============================================================================
export const ReleaseMonitorIndicator = GObject.registerClass(
class ReleaseMonitorIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Release Monitor');
        
        this.icon = new St.Icon({
            icon_name: 'software-update-available-symbolic',
            style_class: 'system-status-icon'
        });
        this.add_child(this.icon);
        
        // Build initial menu
        this._buildMenu();
        
        // Track last button press to detect left vs right click
        this._lastButtonPress = null;
        
        // Connect to menu open to rebuild menu dynamically
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open && this._extension) {
                // If window is already open, close the menu immediately and forcefully
                if (this._reportWindowProcessId) {
                    // Use GLib.idle_add to close menu asynchronously to avoid blocking
                    GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                        if (menu.isOpen) {
                            menu.close();
                        }
                        return false;
                    });
                    return;
                }
                this._buildMenu();
                // If menu opened after a left click, close it and open report window instead
                if (this._lastButtonPress === 1) {
                    this.menu.close();
                    this._openReportWindow();
                    this._lastButtonPress = null;
                }
            }
        });
        
        // Handle button press events - left click opens report, right click opens menu
        this.connect('button-press-event', (actor, event) => {
            const button = event.get_button();
            this._lastButtonPress = button;
            
            // If window is already open, completely block all clicks to prevent conflicts
            if (this._reportWindowProcessId) {
                // Window is open - prevent any menu interaction
                // Returning true stops event propagation in Clutter
                return true; // Stop event propagation completely
            }
            
            if (button === 1) {
                // Left click - open report window (prevent menu from opening)
                this._openReportWindow();
                return true; // Stop event propagation to prevent menu
            }
            // Right click (button 3) or middle click - let default menu behavior work
            return false;
        });
        
        this._reportWindow = null;
        this._reportWindowProcessId = null;
    }
    
    _buildMenu() {
        // Clear existing menu items
        this.menu.removeAll();
        
        if (!this._extension) {
            // Add a placeholder item if extension not set yet
            const placeholder = new PopupMenu.PopupMenuItem('Loading...', { reactive: false });
            this.menu.addMenuItem(placeholder);
            return;
        }
        
        // Title
        const titleItem = new PopupMenu.PopupMenuItem('Monitored Projects', {
            reactive: false
        });
        this.menu.addMenuItem(titleItem);
        
        // Separator
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        // Project list - reload config to get latest data
        this._extension.configManager.load();
        const projects = this._extension.configManager.getProjects();
        console.log(`_buildMenu: Found ${projects.length} projects`);
        if (projects.length === 0) {
            const emptyItem = new PopupMenu.PopupMenuItem('No projects monitored', {
                reactive: false
            });
            this.menu.addMenuItem(emptyItem);
        } else {
            projects.forEach(project => {
                const source = project.source || 'github';
                const identifier = source === 'release-monitoring' 
                    ? (project.projectName || project.owner || 'unknown')
                    : `${project.owner}/${project.repo}`;
                const releaseVersion = project.lastRelease 
                    ? (project.lastRelease.tag_name || project.lastRelease.version || project.lastRelease.name || 'unknown')
                    : 'null';
                console.log(`_buildMenu: Project ${identifier} (${source}), lastRelease: ${releaseVersion}`);
                this._addProjectItem(project);
            });
        }
        
        // Separator before action items
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        // Settings menu item
        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this.menu.close();
            if (this._extension) {
                this._extension._openSettingsWindow();
            }
        });
        this.menu.addMenuItem(settingsItem);
    }
    
    _addProjectItem(project) {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const box = new St.BoxLayout({ vertical: false, style: 'spacing: 10px;' });
        
        const textBox = new St.BoxLayout({ vertical: true });
        const source = project.source || 'github';
        const displayName = source === 'release-monitoring'
            ? (project.projectName || project.owner || 'unknown')
            : `${project.owner}/${project.repo}`;
        const nameLabel = new St.Label({
            text: displayName + (source === 'release-monitoring' ? ' (release-monitoring.org)' : ''),
            style_class: 'popup-menu-item-label'
        });
        textBox.add_child(nameLabel);
        
        let releaseText = 'No releases found';
        if (project.lastRelease) {
            const releaseVersion = project.lastRelease.tag_name || project.lastRelease.version || project.lastRelease.name || 'unknown';
            releaseText = `Latest: ${project.lastRelease.name || releaseVersion} (${releaseVersion})`;
        }
        const releaseLabel = new St.Label({
            text: releaseText,
            style_class: 'popup-sub-menu-item'
        });
        textBox.add_child(releaseLabel);
        
        box.add_child(textBox);
        
        // Remove button removed - users should use the preferences window to remove projects
        
        item.actor.add_child(box);
        this.menu.addMenuItem(item);
    }
    
    _openReportWindow() {
        if (!this._extension) {
            return;
        }
        
        // Clear the notification icon when window is opened (user has seen the updates)
        this.updateIcon(false);
        console.log('_openReportWindow: Cleared notification icon');
        
        // Check if window is already open - if so, just skip (can't bring to front from separate process)
        if (this._reportWindowProcessId) {
            // Check if the process is still running by checking /proc
            const procPath = `/proc/${this._reportWindowProcessId}`;
            const procFile = Gio.File.new_for_path(procPath);
            if (procFile.query_exists(null)) {
                // Process exists, don't create another window
                console.log('_openReportWindow: Window already open, skipping');
                return;
            } else {
                // Process doesn't exist, clear the ID and continue
                console.log('_openReportWindow: Previous window process no longer exists, clearing ID');
                this._reportWindowProcessId = null;
            }
        }
        
        const version = this._extension.metadata.version || '1';
        
        // Get the extension directory path
        const extensionDir = this._extension.path;
        const reportWindowScript = GLib.build_filenamev([extensionDir, 'report-window.js']);
        
        // Use "config" as the argument to tell report-window.js to read from the actual config file
        // This ensures the window always shows the latest projects, even if they're added after the window is opened
        const configArg = 'config';
        
        // Launch the report window script
        try {
            const scriptFile = Gio.File.new_for_path(reportWindowScript);
            if (!scriptFile.query_exists(null)) {
                throw new Error(`Report window script not found: ${reportWindowScript}`);
            }
            
            console.log(`_openReportWindow: Launching ${reportWindowScript} with config file argument`);
            
            const [success, pid] = GLib.spawn_async(
                null,
                ['gjs', '-m', reportWindowScript, configArg, version],
                null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null
            );
            
            if (!success) {
                throw new Error('Failed to launch report window script');
            }
            
            // Track the process ID to prevent multiple windows
            this._reportWindowProcessId = pid;
            console.log(`_openReportWindow: Process launched with PID ${pid}`);
            
            // Monitor process to clear the ID when it exits
            GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (pid, status) => {
                console.log(`_openReportWindow: Process ${pid} exited with status ${status}`);
                this._reportWindowProcessId = null;
                // No need to clean up - we're using the config file directly now
                GLib.spawn_close_pid(pid);
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.error(`Error launching report window: ${e.message}`);
            console.error(`Stack trace: ${e.stack}`);
            Main.notify('Error', `Failed to open report window: ${e.message}`);
        }
    }
    
    _showAddDialog() {
        // Open the Extensions app to the preferences for this extension
        try {
            const extensionUuid = this._extension.metadata.uuid;
            console.log(`_showAddDialog: Opening preferences for ${extensionUuid}`);
            
            // Use GLib.spawn_async to get PID for tracking
            const command = `gnome-extensions prefs ${extensionUuid}`;
            console.log(`_showAddDialog: Executing: ${command}`);
            
            try {
                const [success, pid] = GLib.spawn_async(
                    null,
                    ['gnome-extensions', 'prefs', extensionUuid],
                    null,
                    GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                    null
                );
                
                if (success) {
                    // Track the process ID
                    this._extension._prefsProcessId = pid;
                    console.log(`_showAddDialog: Preferences process launched with PID ${pid}`);
                    
                    // Monitor process to clear the ID when it exits
                    GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (pid, status) => {
                        console.log(`_showAddDialog: Preferences process ${pid} exited with status ${status}`);
                        if (this._extension) {
                            this._extension._prefsProcessId = null;
                        }
                        GLib.spawn_close_pid(pid);
                        return GLib.SOURCE_REMOVE;
                    });
                    return;
                } else {
                    console.error(`_showAddDialog: Failed to launch preferences`);
                }
            } catch (spawnError) {
                console.error(`_showAddDialog: spawn_async failed: ${spawnError.message}`);
            }
        } catch (e) {
            console.error(`_showAddDialog: Error: ${e.message}`);
        }
        
        // Fallback: try to open Extensions app directly
        try {
            console.log(`_showAddDialog: Trying fallback - opening Extensions app`);
            GLib.spawn_command_line_async('gnome-extensions');
        } catch (e) {
            console.error(`_showAddDialog: Fallback failed: ${e.message}`);
            // Last resort: show notification
            Main.notify(
                'Add GitHub Project',
                'Please open Extensions app and click the settings icon for Release Monitor'
            );
        }
    }
    
    _setExtension(extension) {
        this._extension = extension;
        // Rebuild menu now that extension is set
        this._buildMenu();
    }
    
    updateIcon(hasNewReleases) {
        if (hasNewReleases) {
            this.icon.icon_name = 'software-update-urgent-symbolic';
            this.icon.style_class = 'system-status-icon attention';
        } else {
            this.icon.icon_name = 'software-update-available-symbolic';
            this.icon.style_class = 'system-status-icon';
        }
    }
});

