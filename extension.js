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

    addProject(owner, repo, versionFilter = null, source = 'github', projectName = null) {
        const project = {
            source: source || 'github',
            owner: owner || null,
            repo: repo || null,
            projectName: projectName || null, // For release-monitoring.org
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
            p => (p.source === 'github' && p.owner === owner && p.repo === repo) ||
                 (p.source === 'release-monitoring' && p.projectName === owner)
        );
        if (project) {
            project.versionFilter = versionFilter || null;
            this.save();
        }
    }

    removeProject(owner, repo, source = 'github') {
        if (source === 'release-monitoring') {
            this.projects = this.projects.filter(
                p => !(p.source === 'release-monitoring' && p.projectName === owner)
            );
        } else {
            this.projects = this.projects.filter(
                p => !(p.source === 'github' && p.owner === owner && p.repo === repo)
            );
        }
        this.save();
    }

    updateProjectRelease(owner, repo, release, source = 'github', projectName = null) {
        let project;
        if (source === 'release-monitoring') {
            project = this.projects.find(
                p => p.source === 'release-monitoring' && p.projectName === projectName
            );
        } else {
            project = this.projects.find(
                p => p.source === 'github' && p.owner === owner && p.repo === repo
            );
        }
        if (project) {
            project.lastRelease = release;
            project.lastChecked = new Date().toISOString();
            const identifier = source === 'release-monitoring' ? projectName : `${owner}/${repo}`;
            console.log(`updateProjectRelease: Saving release ${release.tag_name || release.version} for ${identifier}`);
            this.save();
            console.log(`updateProjectRelease: Config saved, reloading...`);
            this.load(); // Reload to ensure consistency
        } else {
            const identifier = source === 'release-monitoring' ? projectName : `${owner}/${repo}`;
            console.error(`updateProjectRelease: Project ${identifier} not found in config`);
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
// ReleaseMonitoringAPI - Handles release-monitoring.org API interactions
// ============================================================================
const ReleaseMonitoringAPI = class {
    constructor(apiToken = null) {
        this.session = new Soup.Session();
        this.baseUrl = 'https://release-monitoring.org/api/v2';
        this.apiToken = apiToken;
    }

    // Helper function to match version pattern (similar to GitHubAPI)
    _matchesVersionPattern(version, pattern) {
        if (!pattern || !pattern.trim()) {
            return true; // No filter means match all
        }
        
        // Normalize the version: remove common prefixes and convert to lowercase
        let normalizedVersion = version.toLowerCase();
        normalizedVersion = normalizedVersion.replace(/^(v|clamav-|clamav|release-|version-)/i, '');
        normalizedVersion = normalizedVersion.replace(/^[^0-9]+/, '');
        
        // Normalize pattern
        let normalizedPattern = pattern.trim().toLowerCase().replace(/[x*]/g, '');
        normalizedPattern = normalizedPattern.replace(/^(v|clamav-|clamav|release-|version-)/i, '');
        normalizedPattern = normalizedPattern.replace(/^[^0-9]+/, '');
        
        // Build regex pattern
        let escapedPattern = normalizedPattern.replace(/\./g, '\\.');
        if (escapedPattern && !escapedPattern.endsWith('\\.')) {
            escapedPattern += '\\.';
        }
        const regex = new RegExp('^' + escapedPattern + '\\d');
        
        const matches = regex.test(normalizedVersion);
        console.log(`_matchesVersionPattern: version="${version}" (normalized: "${normalizedVersion}") pattern="${pattern}" (normalized: "${normalizedPattern}") regex="${regex}" -> ${matches}`);
        
        return matches;
    }

    async searchProject(projectName) {
        const url = `${this.baseUrl}/projects/?name=${encodeURIComponent(projectName)}`;
        const message = Soup.Message.new('GET', url);
        
        message.request_headers.append('User-Agent', 'GNOME-Release-Monitor');
        message.request_headers.append('Accept', 'application/json');
        
        // Add API token if available (release-monitoring.org uses Authorization header)
        if (this.apiToken && this.apiToken.trim()) {
            const token = this.apiToken.trim();
            // Use replace to ensure only one Authorization header is set
            message.request_headers.replace('Authorization', `token ${token}`);
            console.log(`ReleaseMonitoringAPI: Using API token (${token.substring(0, 4)}...${token.substring(token.length - 4)}) for request to ${url}`);
        } else {
            console.log(`ReleaseMonitoringAPI: No API token available for request to ${url} - may be blocked by bot protection`);
        }

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
                                
                                // Check if response is HTML (bot protection)
                                if (response.trim().startsWith('<') || response.includes('<!DOCTYPE')) {
                                    reject(new Error(`Received HTML instead of JSON. The API may be blocking requests. Response preview: ${response.substring(0, 200)}`));
                                    return;
                                }
                                
                                const json = JSON.parse(response);
                                
                                if (json.items && json.items.length > 0) {
                                    resolve(json.items[0]); // Return first match
                                } else {
                                    resolve(null); // No project found
                                }
                            } catch (e) {
                                // Log the actual response for debugging
                                const decoder = new TextDecoder('utf-8');
                                const data = bytes.get_data();
                                const response = data ? decoder.decode(data).substring(0, 500) : 'No data';
                                console.error(`Failed to parse response. Status: ${status}, Response preview: ${response}`);
                                reject(new Error(`Failed to parse response: ${e.message}. Response may be HTML or invalid JSON.`));
                            }
                        } else {
                            reject(new Error(`Release-monitoring.org API error: ${status}`));
                        }
                    } catch (e) {
                        reject(new Error(`Request failed: ${e.message}`));
                    }
                }
            );
        });
    }

    async getLatestRelease(projectName, versionFilter = null) {
        // First, search for the project
        const project = await this.searchProject(projectName);
        if (!project) {
            console.log(`No project found for: ${projectName}`);
            return null;
        }

        // The API returns 'version' field, not 'latest_version'
        const latestVersion = project.version || project.latest_version;
        console.log(`Found project: ${project.name} (ID: ${project.id}, version: ${latestVersion}, backend: ${project.backend})`);

        // Get the latest version from the project object
        if (!latestVersion) {
            console.log(`No latest version found for: ${projectName}`);
            return null;
        }
        
        // Try to get the actual release date from GitHub if backend is GitHub
        let publishedAt = null;
        if (project.backend === 'GitHub' && project.version_url) {
            // version_url format is typically "owner/repo"
            const [owner, repo] = project.version_url.split('/');
            if (owner && repo) {
                try {
                    console.log(`Fetching release date from GitHub for ${owner}/${repo}, version ${latestVersion}`);
                    const githubAPI = new GitHubAPI();
                    // Try to get the release by tag name
                    const release = await githubAPI.getLatestRelease(owner, repo, null);
                    if (release && release.published_at) {
                        publishedAt = release.published_at;
                        console.log(`Got release date from GitHub: ${publishedAt}`);
                    }
                } catch (e) {
                    console.log(`Could not fetch release date from GitHub: ${e.message}`);
                }
            }
        }
        
        // Fallback to updated_on if we don't have a GitHub release date
        if (!publishedAt) {
            if (project.updated_on) {
                publishedAt = new Date(project.updated_on * 1000).toISOString();
                console.log(`Using updated_on as fallback date: ${publishedAt}`);
            } else {
                // Last resort: use current date or null
                publishedAt = null;
                console.log(`No date available for project ${projectName} - updated_on is not set`);
            }
        }

        // If version filter is specified, check if latest version matches
        if (versionFilter && versionFilter.trim()) {
            if (!this._matchesVersionPattern(latestVersion, versionFilter)) {
                // Latest version doesn't match, check stable_versions
                if (project.stable_versions && project.stable_versions.length > 0) {
                    const matchingVersions = project.stable_versions.filter(v => 
                        this._matchesVersionPattern(v, versionFilter)
                    );
                    if (matchingVersions.length === 0) {
                        console.log(`No matching versions found for pattern "${versionFilter}"`);
                        return null;
                    }
                    // Use the first (latest) matching version
                    const matchingVersion = matchingVersions[0];
                    // For filtered versions, we may not have the exact GitHub release, so use updated_on
                    const filteredPublishedAt = project.updated_on ? new Date(project.updated_on * 1000).toISOString() : null;
                    return {
                        version: matchingVersion,
                        tag_name: matchingVersion, // For compatibility
                        name: matchingVersion,
                        published_at: filteredPublishedAt, // Use updated_on as "Retrieved on (UTC)"
                        html_url: project.homepage || `https://release-monitoring.org/project/${project.id}/`,
                        body: null
                    };
                } else {
                    console.log(`No stable versions available for filtering`);
                    return null;
                }
            }
        }

        // Return the latest version with the date we fetched (or fallback to updated_on)
        return {
            version: latestVersion,
            tag_name: latestVersion, // For compatibility
            name: latestVersion,
            published_at: publishedAt, // GitHub release date or updated_on as fallback
            html_url: project.homepage || `https://release-monitoring.org/project/${project.id}/`,
            body: null
        };
    }

    async checkProject(projectName) {
        const project = await this.searchProject(projectName);
        return project !== null;
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
        
        // Remove button
        const removeButton = new St.Button({
            style_class: 'popup-menu-item',
            child: new St.Icon({ icon_name: 'edit-delete-symbolic', icon_size: 16 })
        });
        removeButton.connect('clicked', () => {
            if (source === 'release-monitoring') {
                this._extension.configManager.removeProject(
                    project.projectName || project.owner,
                    null,
                    source
                );
            } else {
                this._extension.configManager.removeProject(project.owner, project.repo, source);
            }
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
        this.releaseMonitoringAPI = null;
        this.indicator = null;
        this.checkInterval = null;
        this.settings = null;
        this._settingsChangedId = null;
        this._wasInStatusArea = false; // Track if indicator was ever added via addToStatusArea
        this._settingsWatchId = null; // File watcher for settings signal
        this._settingsUpdateWatchId = null; // File watcher for settings updates
        this._settingsWindowProcessId = null; // Track settings window process
    }

    enable() {
        this.configManager = new ConfigManager();
        this.githubAPI = new GitHubAPI();
        
        // Get API token from settings
        let apiToken = null;
        try {
            apiToken = this.getSettings().get_string('release-monitoring-api-token') || null;
        } catch (e) {
            console.log(`Could not read release-monitoring-api-token: ${e.message}`);
        }
        this.releaseMonitoringAPI = new ReleaseMonitoringAPI(apiToken);
        this.settings = this.getSettings();
        
        this.indicator = new ReleaseMonitorIndicator();
        this.indicator._setExtension(this);
        
        // Add indicator to panel based on position setting
        this._addIndicatorToPanel();
        
        // Watch for settings changes
        this._settingsChangedId = this.settings.connect('changed::icon-position', () => {
            this._moveIndicator();
        });
        
        // Watch for settings signal file from report window
        this._startSettingsWatcher();
        
        // Watch for settings updates from settings window
        this._startSettingsUpdateWatcher();
        
        // Start check interval based on settings
        this._restartCheckInterval();
        
        // Initial check after 5 seconds
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this.checkForUpdates();
            return false; // Don't repeat
        });
    }

    _addIndicatorToPanel() {
        let position = 'right'; // Default
        try {
            position = this.settings.get_string('icon-position') || 'right';
        } catch (e) {
            console.log(`Could not read icon-position setting: ${e.message}, using default 'right'`);
        }
        
        // Remove from any existing position first
        const currentParent = this.indicator.get_parent();
        if (currentParent) {
            currentParent.remove_child(this.indicator);
        }
        
        // If moving to/from status area, we need to remove it from status area tracking
        // Check if it's currently registered in status area
        if (Main.panel.statusArea && Main.panel.statusArea._indicators) {
            // Try to remove from status area's internal tracking if it exists
            try {
                const indicators = Main.panel.statusArea._indicators;
                if (indicators.get_children().includes(this.indicator)) {
                    indicators.remove_child(this.indicator);
                }
            } catch (e) {
                // Ignore - might not be in status area
            }
        }
        
        // Add to the appropriate panel area
        // Note: _leftBox and _centerBox are private APIs and may not be available in all GNOME versions
        try {
            if (position === 'left' && Main.panel._leftBox) {
                Main.panel._leftBox.insert_child_at_index(this.indicator, -1);
                console.log('Added indicator to left panel');
                return;
            } else if (position === 'center' && Main.panel._centerBox) {
                Main.panel._centerBox.insert_child_at_index(this.indicator, -1);
                console.log('Added indicator to center panel');
                return;
            }
        } catch (e) {
            console.log(`Could not add indicator to ${position} panel: ${e.message}, falling back to right`);
        }
        
        // Default to right (status area)
        // Insert just before system controls (power, settings, etc.) instead of at the end
        try {
            // Try different approaches to add to status area
            if (Main.panel.statusArea) {
                // Check if statusArea has _rightBox (most common structure)
                if (Main.panel.statusArea._rightBox) {
                    const container = Main.panel.statusArea._rightBox;
                    const children = container.get_children();
                    // Find system indicators (usually at the end) and insert before them
                    // System indicators are typically the last few items
                    // Insert at position that's before the system controls
                    const insertIndex = Math.max(0, children.length - 3); // Insert before last 3 items (system controls)
                    container.insert_child_at_index(this.indicator, insertIndex);
                    console.log(`Added indicator to right panel (status area) via _rightBox at index ${insertIndex}`);
                    return;
                }
                // Check for _indicators container
                if (Main.panel.statusArea._indicators) {
                    const container = Main.panel.statusArea._indicators;
                    const children = container.get_children();
                    const insertIndex = Math.max(0, children.length - 3); // Insert before last 3 items
                    container.insert_child_at_index(this.indicator, insertIndex);
                    console.log(`Added indicator to right panel (status area) via _indicators at index ${insertIndex}`);
                    return;
                }
                // Check if statusArea itself is a container
                if (typeof Main.panel.statusArea.insert_child_at_index === 'function') {
                    const container = Main.panel.statusArea;
                    const children = container.get_children();
                    const insertIndex = Math.max(0, children.length - 3); // Insert before last 3 items
                    container.insert_child_at_index(this.indicator, insertIndex);
                    console.log(`Added indicator to right panel (status area) at index ${insertIndex}`);
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
                        console.log(`Added indicator to right panel (status area) via add_child at index ${targetIndex}`);
                    } else {
                        container.add_child(this.indicator);
                        console.log('Added indicator to right panel (status area) via add_child');
                    }
                    return;
                }
            }
            
            // If statusArea methods don't work, try panel's _rightBox directly
            if (Main.panel._rightBox) {
                const container = Main.panel._rightBox;
                const children = container.get_children();
                const insertIndex = Math.max(0, children.length - 3); // Insert before last 3 items
                container.insert_child_at_index(this.indicator, insertIndex);
                console.log(`Added indicator to right panel via panel._rightBox at index ${insertIndex}`);
                return;
            }
            
            // Last resort: use addToStatusArea (but this might fail if already registered)
            // Only use this if the indicator was never added before
            if (!this._wasInStatusArea) {
                Main.panel.addToStatusArea('release-monitor', this.indicator);
                this._wasInStatusArea = true;
                // Try to move it to before system controls
                try {
                    if (Main.panel.statusArea && Main.panel.statusArea._rightBox) {
                        const container = Main.panel.statusArea._rightBox;
                        const children = container.get_children();
                        const currentIndex = children.indexOf(this.indicator);
                        if (currentIndex >= 0) {
                            const targetIndex = Math.max(0, children.length - 4); // Before system controls
                            if (currentIndex !== targetIndex) {
                                container.set_child_at_index(this.indicator, targetIndex);
                                console.log(`Moved indicator from index ${currentIndex} to ${targetIndex}`);
                            }
                        }
                    }
                } catch (e) {
                    console.log(`Could not reorder indicator: ${e.message}`);
                }
                console.log('Added indicator to right panel (status area) via addToStatusArea');
            } else {
                console.error('Cannot use addToStatusArea - indicator already registered. Status area structure not accessible.');
            }
        } catch (e) {
            console.error(`Failed to add indicator to status area: ${e.message}`);
            console.error(`StatusArea structure: ${JSON.stringify(Object.keys(Main.panel.statusArea || {}))}`);
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
                        console.log('Settings signal file detected, opening settings window...');
                        this._openSettingsWindow();
                        // Delete the signal file
                        try {
                            signalFile.delete(null);
                        } catch (e) {
                            console.log(`Could not delete signal file: ${e.message}`);
                        }
                    }
                } catch (e) {
                    console.log(`Error checking settings signal file: ${e.message}`);
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
                console.log('_openSettingsWindow: Settings window already open, skipping');
                return;
            } else {
                // Process doesn't exist, clear the ID and continue
                console.log('_openSettingsWindow: Previous settings window process no longer exists, clearing ID');
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
                console.log(`Could not read icon-position: ${e.message}`);
            }
            
            let currentApiToken = '';
            try {
                currentApiToken = this.settings.get_string('release-monitoring-api-token') || '';
            } catch (e) {
                console.log(`Could not read release-monitoring-api-token: ${e.message}`);
            }
            
            console.log(`_openSettingsWindow: Launching ${settingsWindowScript} with interval=${currentInterval}, position=${currentPosition}, apiToken=${currentApiToken ? '***' : '(empty)'}`);
            
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
            console.log(`_openSettingsWindow: Process launched with PID ${pid}`);
            
            // Monitor process to clear the ID when it exits
            GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (pid, status) => {
                console.log(`_openSettingsWindow: Process ${pid} exited with status ${status}`);
                this._settingsWindowProcessId = null;
                GLib.spawn_close_pid(pid);
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.error(`Error launching settings window: ${e.message}`);
            console.error(`Stack trace: ${e.stack}`);
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
                        console.log('Settings update signal file detected, reading settings...');
                        this._applySettingsUpdate();
                        // Delete the signal file
                        try {
                            signalFile.delete(null);
                        } catch (e) {
                            console.log(`Could not delete signal file: ${e.message}`);
                        }
                    }
                } catch (e) {
                    console.log(`Error checking settings update signal file: ${e.message}`);
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
                    
                    console.log(`_applySettingsUpdate: Applying settings: ${JSON.stringify(settingsData)}`);
                    
                    // Update icon position
                    if (settingsData.iconPosition) {
                        this.settings.set_string('icon-position', settingsData.iconPosition);
                        console.log(`_applySettingsUpdate: Icon position set to ${settingsData.iconPosition}`);
                    }
                    
                    // Update refresh interval
                    if (settingsData.refreshInterval) {
                        this.settings.set_int('refresh-interval', settingsData.refreshInterval);
                        console.log(`_applySettingsUpdate: Refresh interval set to ${settingsData.refreshInterval} seconds`);
                        // Restart the check interval with new value
                        this._restartCheckInterval();
                    }
                    
                    // Update API token and recreate ReleaseMonitoringAPI
                    if (settingsData.apiToken !== undefined) {
                        this.settings.set_string('release-monitoring-api-token', settingsData.apiToken || '');
                        console.log(`_applySettingsUpdate: API token ${settingsData.apiToken ? 'updated' : 'cleared'}`);
                        // Recreate the API instance with the new token
                        this.releaseMonitoringAPI = new ReleaseMonitoringAPI(settingsData.apiToken || null);
                    }
                    
                    // Delete the settings file
                    try {
                        settingsFile.delete(null);
                    } catch (e) {
                        console.log(`Could not delete settings file: ${e.message}`);
                    }
                }
            }
        } catch (e) {
            console.error(`Error applying settings update: ${e.message}`);
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
        console.log(`_restartCheckInterval: Starting check interval with ${interval} seconds`);
        
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
        if (this._settingsUpdateWatchId) {
            GLib.source_remove(this._settingsUpdateWatchId);
            this._settingsUpdateWatchId = null;
        }
        if (this._settingsWatchId) {
            GLib.source_remove(this._settingsWatchId);
            this._settingsWatchId = null;
        }
        if (this._settingsChangedId) {
            this.settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
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
                const source = project.source || 'github'; // Default to github for backward compatibility
                const versionFilter = project.versionFilter || null;
                
                let release = null;
                let projectIdentifier = '';
                
                if (source === 'release-monitoring') {
                    const projectName = project.projectName || project.owner; // Fallback to owner for compatibility
                    projectIdentifier = projectName;
                    console.log(`checkForUpdates: Checking release-monitoring.org project "${projectName}"${versionFilter ? ` (filter: ${versionFilter})` : ''}`);
                    release = await this.releaseMonitoringAPI.getLatestRelease(projectName, versionFilter);
                } else {
                    // GitHub
                    projectIdentifier = `${project.owner}/${project.repo}`;
                    console.log(`checkForUpdates: Checking GitHub ${projectIdentifier}${versionFilter ? ` (filter: ${versionFilter})` : ''}`);
                    release = await this.githubAPI.getLatestRelease(project.owner, project.repo, versionFilter);
                }
                
                if (release) {
                    const releaseVersion = release.tag_name || release.version || release.name;
                    console.log(`checkForUpdates: Found release ${releaseVersion} for ${projectIdentifier}`);
                    
                    // For release-monitoring.org, published_at may be null, so we compare versions instead
                    const isNewRelease = source === 'release-monitoring' 
                        ? (!project.lastRelease || (project.lastRelease.version || project.lastRelease.tag_name) !== releaseVersion)
                        : (() => {
                            const releaseDate = release.published_at ? new Date(release.published_at) : null;
                            const lastReleaseDate = project.lastRelease && project.lastRelease.published_at
                                ? new Date(project.lastRelease.published_at)
                                : null;
                            return !lastReleaseDate || (releaseDate && releaseDate > lastReleaseDate);
                        })();
                    
                    // Always update the config with the latest release info
                    console.log(`checkForUpdates: Calling updateProjectRelease for ${projectIdentifier}`);
                    if (source === 'release-monitoring') {
                        this.configManager.updateProjectRelease(
                            null, // owner not used for release-monitoring
                            null, // repo not used for release-monitoring
                            release,
                            source,
                            project.projectName || project.owner
                        );
                    } else {
                        this.configManager.updateProjectRelease(
                            project.owner,
                            project.repo,
                            release,
                            source
                        );
                    }
                    console.log(`checkForUpdates: updateProjectRelease completed for ${projectIdentifier}`);
                    
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
                            console.log(`checkForUpdates: Rebuilding menu after release update`);
                            this.indicator._buildMenu();
                        }
                        return false; // Don't repeat
                    });
                } else {
                    console.log(`checkForUpdates: No releases found for ${projectIdentifier}`);
                }
            } catch (e) {
                const projectIdentifier = project.source === 'release-monitoring' 
                    ? (project.projectName || project.owner || 'unknown')
                    : `${project.owner}/${project.repo}`;
                console.error(`Error checking ${projectIdentifier}: ${e.message}`);
                log(`Error checking ${projectIdentifier}: ${e}`);
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
