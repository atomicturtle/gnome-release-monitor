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

// ============================================================================
// ConfigManager - Manages project configuration storage
// ============================================================================
const ConfigManager = class {
    constructor() {
        this.configDir = GLib.get_user_config_dir();
        this.configFile = Gio.File.new_for_path(
            GLib.build_filenamev([this.configDir, 'release-monitor', 'projects.json'])
        );
        this.projects = [];
        this._ensureConfigDir();
        this.load();
    }

    _ensureConfigDir() {
        const configDirFile = this.configFile.get_parent();
        if (!configDirFile.query_exists(null)) {
            configDirFile.make_directory_with_parents(null);
        }
    }

    load() {
        try {
            if (this.configFile.query_exists(null)) {
                const [success, contents] = this.configFile.load_contents(null);
                if (success) {
                    const decoder = new TextDecoder('utf-8');
                    const jsonStr = decoder.decode(contents);
                    this.projects = JSON.parse(jsonStr);
                }
            }
        } catch (e) {
            log(`Error loading config: ${e}`);
            this.projects = [];
        }
    }

    save() {
        try {
            const encoder = new TextEncoder();
            const jsonStr = JSON.stringify(this.projects, null, 2);
            const data = encoder.encode(jsonStr);
            const [success, etag] = this.configFile.replace_contents(data, null, false, Gio.FileCreateFlags.NONE, null);
            if (success) {
                console.log(`Config saved successfully`);
            } else {
                console.error(`Config save failed`);
            }
        } catch (e) {
            console.error(`Error saving config: ${e.message}`);
            log(`Error saving config: ${e}`);
        }
    }

    addProject(owner, repo, versionFilter = null) {
        const project = {
            owner: owner,
            repo: repo,
            versionFilter: versionFilter || null,
            lastRelease: null,
            lastChecked: null
        };
        this.projects.push(project);
        this.save();
        return project;
    }
    
    updateProjectVersionFilter(owner, repo, versionFilter) {
        const project = this.projects.find(
            p => p.owner === owner && p.repo === repo
        );
        if (project) {
            project.versionFilter = versionFilter || null;
            this.save();
        }
    }

    removeProject(owner, repo) {
        this.projects = this.projects.filter(
            p => !(p.owner === owner && p.repo === repo)
        );
        this.save();
    }

    updateProjectRelease(owner, repo, release) {
        const project = this.projects.find(
            p => p.owner === owner && p.repo === repo
        );
        if (project) {
            project.lastRelease = release;
            project.lastChecked = new Date().toISOString();
            console.log(`updateProjectRelease: Saving release ${release.tag_name} for ${owner}/${repo}`);
            this.save();
            console.log(`updateProjectRelease: Config saved, reloading...`);
            this.load(); // Reload to ensure consistency
        } else {
            console.error(`updateProjectRelease: Project ${owner}/${repo} not found in config`);
        }
    }

    getProjects() {
        return this.projects;
    }
};

// ============================================================================
// GitHubAPI - Handles GitHub API interactions
// ============================================================================
const GitHubAPI = class {
    constructor() {
        this.session = new Soup.Session();
        this.baseUrl = 'https://api.github.com';
    }

    // Helper function to match version pattern (e.g., "1.0.x" or "1.0.*" matches "1.0.1", "1.0.2", etc.)
    _matchesVersionPattern(tagName, pattern) {
        if (!pattern || !pattern.trim()) {
            return true; // No filter means match all
        }
        
        // Normalize the tag name: remove common prefixes and convert to lowercase
        // Handles: "v1.5.3", "clamav-1.5.3", "ClamAV-1.5.3", "1.5.3", etc.
        let normalizedTag = tagName.toLowerCase();
        // Remove common prefixes
        normalizedTag = normalizedTag.replace(/^(v|clamav-|clamav|release-|version-)/i, '');
        // Remove any leading non-numeric characters
        normalizedTag = normalizedTag.replace(/^[^0-9]+/, '');
        
        // Normalize pattern: replace 'x' or '*' with empty, trim whitespace
        let normalizedPattern = pattern.trim().toLowerCase().replace(/[x*]/g, '');
        // Remove common prefixes from pattern too
        normalizedPattern = normalizedPattern.replace(/^(v|clamav-|clamav|release-|version-)/i, '');
        normalizedPattern = normalizedPattern.replace(/^[^0-9]+/, '');
        
        // Build a regex pattern: "1.4.*" -> "1\.4\." to match "1.4.3", "1.4.10", etc.
        // Escape dots in the pattern
        let escapedPattern = normalizedPattern.replace(/\./g, '\\.');
        // If pattern doesn't end with a dot, add one (to match "1.4" -> "1.4.")
        if (escapedPattern && !escapedPattern.endsWith('\\.')) {
            escapedPattern += '\\.';
        }
        // Create regex that matches the pattern followed by at least one digit
        const regex = new RegExp('^' + escapedPattern + '\\d');
        
        // Test if the normalized tag matches
        const matches = regex.test(normalizedTag);
        
        console.log(`_matchesVersionPattern: tag="${tagName}" (normalized: "${normalizedTag}") pattern="${pattern}" (normalized: "${normalizedPattern}") regex="${regex}" -> ${matches}`);
        
        return matches;
    }

    async getLatestRelease(owner, repo, versionFilter = null) {
        // If no version filter, use the simple /latest endpoint
        if (!versionFilter || !versionFilter.trim()) {
            const url = `${this.baseUrl}/repos/${owner}/${repo}/releases/latest`;
            const message = Soup.Message.new('GET', url);
            
            message.request_headers.append('Accept', 'application/vnd.github.v3+json');
            message.request_headers.append('User-Agent', 'GNOME-Release-Monitor');

            return new Promise((resolve, reject) => {
                this.session.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (session, result) => {
                        try {
                            const bytes = session.send_and_read_finish(result);
                            const status = message.get_status();
                            
                            if (status === 200) {
                                try {
                                    const decoder = new TextDecoder('utf-8');
                                    const data = bytes.get_data();
                                    if (!data) {
                                        reject(new Error('Empty response body'));
                                        return;
                                    }
                                    const response = decoder.decode(data);
                                    const release = JSON.parse(response);
                                    resolve({
                                        tag_name: release.tag_name,
                                        name: release.name || release.tag_name,
                                        published_at: release.published_at,
                                        html_url: release.html_url,
                                        body: release.body
                                    });
                                } catch (e) {
                                    reject(new Error(`Failed to parse response: ${e.message}`));
                                }
                            } else if (status === 404) {
                                resolve(null); // No releases found
                            } else {
                                reject(new Error(`GitHub API error: ${status}`));
                            }
                        } catch (e) {
                            reject(new Error(`Request failed: ${e.message}`));
                        }
                    }
                );
            });
        }
        
        // With version filter, fetch all releases and filter
        return this.getLatestReleaseWithFilter(owner, repo, versionFilter);
    }
    
    async getLatestReleaseWithFilter(owner, repo, versionFilter) {
        // Fetch releases (paginated, but we'll limit to first page for performance)
        const url = `${this.baseUrl}/repos/${owner}/${repo}/releases?per_page=100`;
        const message = Soup.Message.new('GET', url);
        
        message.request_headers.append('Accept', 'application/vnd.github.v3+json');
        message.request_headers.append('User-Agent', 'GNOME-Release-Monitor');

        return new Promise((resolve, reject) => {
            this.session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const status = message.get_status();
                        
                        if (status === 200) {
                            try {
                                const decoder = new TextDecoder('utf-8');
                                const data = bytes.get_data();
                                if (!data) {
                                    reject(new Error('Empty response body'));
                                    return;
                                }
                                const response = decoder.decode(data);
                                const releases = JSON.parse(response);
                                
                                console.log(`getLatestReleaseWithFilter: Found ${releases.length} total releases for ${owner}/${repo}`);
                                if (releases.length > 0) {
                                    console.log(`getLatestReleaseWithFilter: First few tag names: ${releases.slice(0, 5).map(r => r.tag_name).join(', ')}`);
                                }
                                
                                // Filter releases by version pattern
                                const matchingReleases = releases.filter(release => {
                                    return this._matchesVersionPattern(release.tag_name, versionFilter);
                                });
                                
                                console.log(`getLatestReleaseWithFilter: Found ${matchingReleases.length} matching releases for pattern "${versionFilter}"`);
                                
                                if (matchingReleases.length === 0) {
                                    resolve(null); // No matching releases found
                                    return;
                                }
                                
                                // Return the first (latest) matching release
                                const release = matchingReleases[0];
                                resolve({
                                    tag_name: release.tag_name,
                                    name: release.name || release.tag_name,
                                    published_at: release.published_at,
                                    html_url: release.html_url,
                                    body: release.body
                                });
                            } catch (e) {
                                reject(new Error(`Failed to parse response: ${e.message}`));
                            }
                        } else if (status === 404) {
                            resolve(null); // No releases found
                        } else {
                            reject(new Error(`GitHub API error: ${status}`));
                        }
                    } catch (e) {
                        reject(new Error(`Request failed: ${e.message}`));
                    }
                }
            );
        });
    }

    async checkRepository(owner, repo) {
        const url = `${this.baseUrl}/repos/${owner}/${repo}`;
        const message = Soup.Message.new('GET', url);
        
        message.request_headers.append('Accept', 'application/vnd.github.v3+json');
        message.request_headers.append('User-Agent', 'GNOME-Release-Monitor');

        return new Promise((resolve, reject) => {
            this.session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    try {
                        session.send_and_read_finish(result);
                        const status = message.get_status();
                        
                        if (status === 200) {
                            resolve(true);
                        } else if (status === 404) {
                            resolve(false);
                        } else {
                            reject(new Error(`GitHub API error: ${status}`));
                        }
                    } catch (e) {
                        reject(new Error(`Request failed: ${e.message}`));
                    }
                }
            );
        });
    }
};


// ============================================================================
// ReleaseMonitorIndicator - Status bar indicator
// ============================================================================
const ReleaseMonitorIndicator = GObject.registerClass(
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
                // Also prevent the menu from even trying to open
                event.stop_propagation();
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
        
        // Add button
        const addItem = new PopupMenu.PopupMenuItem('➕ Add Project');
        addItem.connect('activate', () => {
            this._showAddDialog();
        });
        this.menu.addMenuItem(addItem);
        
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
                console.log(`_buildMenu: Project ${project.owner}/${project.repo}, lastRelease: ${project.lastRelease ? project.lastRelease.tag_name : 'null'}`);
                this._addProjectItem(project);
            });
        }
    }
    
    _addProjectItem(project) {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const box = new St.BoxLayout({ vertical: false, style: 'spacing: 10px;' });
        
        const textBox = new St.BoxLayout({ vertical: true });
        const nameLabel = new St.Label({
            text: `${project.owner}/${project.repo}`,
            style_class: 'popup-menu-item-label'
        });
        textBox.add_child(nameLabel);
        
        let releaseText = 'No releases found';
        if (project.lastRelease) {
            releaseText = `Latest: ${project.lastRelease.name} (${project.lastRelease.tag_name})`;
        }
        const releaseLabel = new St.Label({
            text: releaseText,
            style_class: 'popup-sub-menu-item'
        });
        textBox.add_child(releaseLabel);
        
        box.add_child(textBox);
        
        // Remove button
        const removeButton = new St.Button({
            style_class: 'popup-menu-item',
            child: new St.Icon({ icon_name: 'edit-delete-symbolic', icon_size: 16 })
        });
        removeButton.connect('clicked', () => {
            this._extension.configManager.removeProject(project.owner, project.repo);
            this._buildMenu(); // Refresh menu
        });
        box.add_child(removeButton);
        
        item.actor.add_child(box);
        this.menu.addMenuItem(item);
    }
    
    _openReportWindow() {
        if (!this._extension) {
            return;
        }
        
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
        
        const projects = this._extension.configManager.getProjects();
        const version = this._extension.metadata.version || '1';
        
        // Use a separate script file to create the window
        // This avoids crashes by running GTK in a separate process
        const projectsJson = JSON.stringify(projects);
        
        // Get the extension directory path
        const extensionDir = this._extension.path;
        const reportWindowScript = GLib.build_filenamev([extensionDir, 'report-window.js']);
        
        // Write projects to a temporary JSON file
        let projectsFile = null;
        try {
            const [fd, projectsFilePath] = GLib.file_open_tmp('release-monitor-projects-XXXXXX.json');
            GLib.close(fd);
            projectsFile = Gio.File.new_for_path(projectsFilePath);
            
            const encoder = new TextEncoder();
            const data = encoder.encode(projectsJson);
            projectsFile.replace_contents(data, null, false, Gio.FileCreateFlags.NONE, null);
            
            console.log(`_openReportWindow: Projects written to ${projectsFilePath}`);
        } catch (e) {
            console.error(`_openReportWindow: Failed to write projects file: ${e.message}`);
            Main.notify('Error', `Failed to prepare report window: ${e.message}`);
            return;
        }
        
        // Launch the report window script
        try {
            const scriptFile = Gio.File.new_for_path(reportWindowScript);
            if (!scriptFile.query_exists(null)) {
                throw new Error(`Report window script not found: ${reportWindowScript}`);
            }
            
            console.log(`_openReportWindow: Launching ${reportWindowScript} with projects file ${projectsFile.get_path()}`);
            
            const [success, pid] = GLib.spawn_async(
                null,
                ['gjs', '-m', reportWindowScript, projectsFile.get_path(), version],
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
                // Clean up the temporary projects file
                try {
                    if (projectsFile) {
                        projectsFile.delete(null);
                    }
                } catch (e) {
                    // Ignore cleanup errors
                }
                GLib.spawn_close_pid(pid);
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.error(`Error launching report window: ${e.message}`);
            console.error(`Stack trace: ${e.stack}`);
            Main.notify('Error', `Failed to open report window: ${e.message}`);
            // Clean up the temporary projects file on error
            try {
                if (projectsFile) {
                    projectsFile.delete(null);
                }
            } catch (cleanupError) {
                // Ignore cleanup errors
            }
        }
    }
    
    _showAddDialog() {
        // Open the Extensions app to the preferences for this extension
        try {
            const extensionUuid = this._extension.metadata.uuid;
            console.log(`_showAddDialog: Opening preferences for ${extensionUuid}`);
            
            // Use GLib.spawn_command_line_async to launch the command
            const command = `gnome-extensions prefs ${extensionUuid}`;
            console.log(`_showAddDialog: Executing: ${command}`);
            
            try {
                GLib.spawn_command_line_async(command);
                console.log(`_showAddDialog: Command executed successfully`);
                return;
            } catch (spawnError) {
                console.error(`_showAddDialog: spawn_command_line_async failed: ${spawnError.message}`);
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

// ============================================================================
// Extension class
// ============================================================================
export default class ReleaseMonitorExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this.metadata = metadata; // Store metadata for access in indicator
        this.configManager = null;
        this.githubAPI = null;
        this.indicator = null;
        this.checkInterval = null;
    }

    enable() {
        this.configManager = new ConfigManager();
        this.githubAPI = new GitHubAPI();
        
        this.indicator = new ReleaseMonitorIndicator();
        this.indicator._setExtension(this);
        Main.panel.addToStatusArea('release-monitor', this.indicator);
        
        // Check for updates every 30 minutes
        this.checkInterval = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1800, // 30 minutes
            () => {
                this.checkForUpdates();
                return true; // Continue the timeout
            }
        );
        
        // Initial check after 5 seconds
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this.checkForUpdates();
            return false; // Don't repeat
        });
    }

    disable() {
        if (this.indicator) {
            this.indicator.destroy();
            this.indicator = null;
        }
        if (this.checkInterval) {
            GLib.source_remove(this.checkInterval);
            this.checkInterval = null;
        }
    }

    async checkForUpdates() {
        const projects = this.configManager.getProjects();
        console.log(`checkForUpdates: Checking ${projects.length} projects`);
        let hasNewReleases = false;
        
        const checkPromises = projects.map(async (project) => {
            try {
                const versionFilter = project.versionFilter || null;
                console.log(`checkForUpdates: Checking ${project.owner}/${project.repo}${versionFilter ? ` (filter: ${versionFilter})` : ''}`);
                const release = await this.githubAPI.getLatestRelease(project.owner, project.repo, versionFilter);
                
                if (release) {
                    console.log(`checkForUpdates: Found release ${release.tag_name} for ${project.owner}/${project.repo}`);
                    const releaseDate = new Date(release.published_at);
                    const lastReleaseDate = project.lastRelease 
                        ? new Date(project.lastRelease.published_at) 
                        : null;
                    
                    // Always update the config with the latest release info
                    console.log(`checkForUpdates: Calling updateProjectRelease for ${project.owner}/${project.repo}`);
                    this.configManager.updateProjectRelease(
                        project.owner,
                        project.repo,
                        release
                    );
                    console.log(`checkForUpdates: updateProjectRelease completed for ${project.owner}/${project.repo}`);
                    
                    // Check if this is a new release
                    if (!lastReleaseDate || releaseDate > lastReleaseDate) {
                        hasNewReleases = true;
                        
                        // Show notification
                        this.showNotification(
                            `New release: ${project.owner}/${project.repo}`,
                            `${release.name} (${release.tag_name})`,
                            release.html_url
                        );
                    }
                    
                    // Rebuild menu to show updated release info
                    // Use GLib.idle_add to ensure menu rebuild happens after config save
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        if (this.indicator) {
                            console.log(`checkForUpdates: Rebuilding menu after release update`);
                            this.indicator._buildMenu();
                        }
                        return false; // Don't repeat
                    });
                } else {
                    console.log(`checkForUpdates: No releases found for ${project.owner}/${project.repo}`);
                }
            } catch (e) {
                console.error(`Error checking ${project.owner}/${project.repo}: ${e.message}`);
                log(`Error checking ${project.owner}/${project.repo}: ${e}`);
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
