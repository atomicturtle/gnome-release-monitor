import GObject from "gi://GObject";
import Gtk from "gi://Gtk";
import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup";
imports.gi.versions.Soup = '3.0';
import {
    ExtensionPreferences,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import { ConfigManager } from "./configManager.js";

// Simple debug flag for the preferences window
const DEBUG = false;

function debugLog(message) {
    if (DEBUG) {
        console.log(message);
    }
}

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
                            
                            console.log(`getLatestRelease: ${url} -> status ${status}`);
                            
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
                        
                        console.log(`checkRepository: ${url} -> status ${status}`);
                        
                        if (status === 200) {
                            resolve(true);
                        } else if (status === 404) {
                            resolve(false);
                        } else {
                            reject(new Error(`GitHub API error: HTTP ${status}`));
                        }
                    } catch (e) {
                        console.error(`checkRepository error: ${e.message}`);
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

    async getVersionInfo(projectId, version) {
        // Try to get version-specific information including "retrieved on" date
        const url = `${this.baseUrl}/versions/?project_id=${projectId}&version=${encodeURIComponent(version)}`;
        const message = Soup.Message.new('GET', url);
        
        message.request_headers.append('User-Agent', 'GNOME-Release-Monitor');
        message.request_headers.append('Accept', 'application/json');
        
        if (this.apiToken && this.apiToken.trim()) {
            message.request_headers.replace('Authorization', `token ${this.apiToken.trim()}`);
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
                                    resolve(null);
                                    return;
                                }
                                const response = decoder.decode(data);
                                
                                if (response.trim().startsWith('<') || response.includes('<!DOCTYPE')) {
                                    resolve(null);
                                    return;
                                }
                                
                                const json = JSON.parse(response);
                                // The API might return version info in items array or directly
                                if (json.items && json.items.length > 0) {
                                    resolve(json.items[0]);
                                } else if (json.created_on || json.retrieved_on || json.first_seen) {
                                    resolve(json);
                                } else {
                                    resolve(null);
                                }
                            } catch (e) {
                                resolve(null);
                            }
                        } else {
                            resolve(null);
                        }
                    } catch (e) {
                        resolve(null);
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
        if (project.backend === 'GitHub' && project.version_url && githubAPI) {
            // version_url format is typically "owner/repo"
            const [owner, repo] = project.version_url.split('/');
            if (owner && repo) {
                try {
                    console.log(`Fetching release date from GitHub for ${owner}/${repo}, version ${latestVersion}`);
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
        
        // For non-GitHub projects, try to get the "Retrieved on" date from version info
        if (!publishedAt && project.id && latestVersion) {
            try {
                console.log(`Fetching version info for project ${project.id}, version ${latestVersion}`);
                const versionInfo = await this.getVersionInfo(project.id, latestVersion);
                if (versionInfo) {
                    // Check for various possible date fields
                    if (versionInfo.retrieved_on) {
                        publishedAt = new Date(versionInfo.retrieved_on * 1000).toISOString();
                        console.log(`Got retrieved_on date from version info: ${publishedAt}`);
                    } else if (versionInfo.created_on) {
                        publishedAt = new Date(versionInfo.created_on * 1000).toISOString();
                        console.log(`Got created_on date from version info: ${publishedAt}`);
                    } else if (versionInfo.first_seen) {
                        publishedAt = new Date(versionInfo.first_seen * 1000).toISOString();
                        console.log(`Got first_seen date from version info: ${publishedAt}`);
                    }
                }
            } catch (e) {
                console.log(`Could not fetch version info: ${e.message}`);
            }
        }
        
        // Fallback to updated_on if we don't have a better date
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
            // Helper function to match version pattern
            const _matchesVersionPattern = (version, pattern) => {
                if (!pattern || !pattern.trim()) {
                    return true;
                }
                let normalizedVersion = version.toLowerCase();
                normalizedVersion = normalizedVersion.replace(/^(v|clamav-|clamav|release-|version-)/i, '');
                normalizedVersion = normalizedVersion.replace(/^[^0-9]+/, '');
                let normalizedPattern = pattern.trim().toLowerCase().replace(/[x*]/g, '');
                normalizedPattern = normalizedPattern.replace(/^(v|clamav-|clamav|release-|version-)/i, '');
                normalizedPattern = normalizedPattern.replace(/^[^0-9]+/, '');
                let escapedPattern = normalizedPattern.replace(/\./g, '\\.');
                if (escapedPattern && !escapedPattern.endsWith('\\.')) {
                    escapedPattern += '\\.';
                }
                const regex = new RegExp('^' + escapedPattern + '\\d');
                return regex.test(normalizedVersion);
            };

            if (!_matchesVersionPattern(latestVersion, versionFilter)) {
                // Latest version doesn't match, check stable_versions
                if (project.stable_versions && project.stable_versions.length > 0) {
                    const matchingVersions = project.stable_versions.filter(v => 
                        _matchesVersionPattern(v, versionFilter)
                    );
                    if (matchingVersions.length === 0) {
                        console.log(`No matching versions found for pattern "${versionFilter}"`);
                        return null;
                    }
                    const matchingVersion = matchingVersions[0];
                    // For filtered versions, we may not have the exact GitHub release, so use updated_on
                    const filteredPublishedAt = project.updated_on ? new Date(project.updated_on * 1000).toISOString() : null;
                    // Construct the proper release URL (version check URL)
                    let filteredReleaseUrl = project.homepage || `https://release-monitoring.org/project/${project.id}/`;
                    if (project.backend === 'GitHub' && project.version_url) {
                        const [owner, repo] = project.version_url.split('/');
                        if (owner && repo) {
                            const tagName = matchingVersion.startsWith('v') ? matchingVersion : `v${matchingVersion}`;
                            filteredReleaseUrl = `https://github.com/${owner}/${repo}/releases/tag/${tagName}`;
                        }
                    } else if (project.backend === 'GNU project' || project.backend === 'GNU') {
                        filteredReleaseUrl = `https://ftp.gnu.org/gnu/${project.name}/`;
                    } else {
                        filteredReleaseUrl = project.ecosystem || project.homepage || `https://release-monitoring.org/project/${project.id}/`;
                    }
                    return {
                        version: matchingVersion,
                        tag_name: matchingVersion,
                        name: matchingVersion,
                        published_at: filteredPublishedAt, // Use updated_on as "Retrieved on (UTC)"
                        html_url: filteredReleaseUrl, // Proper release URL
                        body: null,
                        backend: project.backend,
                        version_url: project.version_url
                    };
                } else {
                    console.log(`No stable versions available for filtering`);
                    return null;
                }
            }
        }

        // Construct the proper release URL (version check URL, not homepage)
        let releaseUrl = project.homepage || `https://release-monitoring.org/project/${project.id}/`;
        
        // For GitHub-backed projects, construct GitHub releases URL
        if (project.backend === 'GitHub' && project.version_url) {
            const [owner, repo] = project.version_url.split('/');
            if (owner && repo) {
                // Try to construct URL to specific release tag, fallback to releases page
                const tagName = latestVersion.startsWith('v') ? latestVersion : `v${latestVersion}`;
                releaseUrl = `https://github.com/${owner}/${repo}/releases/tag/${tagName}`;
            }
        } else if (project.backend === 'GNU project' || project.backend === 'GNU') {
            // For GNU projects, construct FTP URL: https://ftp.gnu.org/gnu/{project-name}/
            releaseUrl = `https://ftp.gnu.org/gnu/${project.name}/`;
        } else {
            // For other backends, try to use ecosystem if available, otherwise homepage
            releaseUrl = project.ecosystem || project.homepage || `https://release-monitoring.org/project/${project.id}/`;
        }
        
        // Return the latest version with the date we fetched (or fallback to updated_on)
        return {
            version: latestVersion,
            tag_name: latestVersion,
            name: latestVersion,
            published_at: publishedAt, // GitHub release date or updated_on as fallback
            html_url: releaseUrl, // Proper release URL (GitHub releases or homepage)
            body: null,
            backend: project.backend, // Store backend for report window
            version_url: project.version_url // Store version_url for report window
        };
    }

    async checkProject(projectName) {
        const project = await this.searchProject(projectName);
        return project !== null;
    }
};

// ============================================================================
// Preferences Window
// ============================================================================
export default class ReleaseMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const configManager = new ConfigManager();
        const githubAPI = new GitHubAPI();
        
        // Get API token from settings
        const settings = this.getSettings();
        let apiToken = null;
        try {
            apiToken = settings.get_string('release-monitoring-api-token') || null;
        } catch (e) {
            debugLog(`Could not read release-monitoring-api-token from GSettings: ${e.message}`);
            // Fallback: check temporary settings file if GSettings doesn't have it yet
            try {
                const settingsFile = Gio.File.new_for_path('/tmp/release-monitor-settings-update.json');
                if (settingsFile.query_exists(null)) {
                    const [success, contents] = settingsFile.load_contents(null);
                    if (success) {
                        const decoder = new TextDecoder('utf-8');
                        const jsonStr = decoder.decode(contents);
                        const settingsData = JSON.parse(jsonStr);
                        if (settingsData.apiToken) {
                            apiToken = settingsData.apiToken;
                            debugLog(`Using API token from temporary settings file`);
                        }
                    }
                }
            } catch (e2) {
                debugLog(`Could not read API token from temporary file: ${e2.message}`);
            }
        }
        if (!apiToken || !apiToken.trim()) {
            debugLog(`No API token found - release-monitoring.org requests may be blocked`);
        } else {
            debugLog(`Using API token: ${apiToken.substring(0, 4)}...${apiToken.substring(apiToken.length - 4)}`);
        }
        const releaseMonitoringAPI = new ReleaseMonitoringAPI(apiToken);
        
        // Create AdwPreferencesPage
        const page = new Adw.PreferencesPage({
            title: 'Monitored Projects',
            icon_name: 'software-update-available-symbolic'
        });
        
        // Create a preferences group
        const group = new Adw.PreferencesGroup({
            title: 'Monitored Projects',
            description: 'Manage projects to monitor for new releases'
        });
        
        // Header box with add button
        const headerBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            margin_start: 12,
            margin_end: 12,
            margin_top: 6,
            margin_bottom: 6
        });
        
        headerBox.append(new Gtk.Label()); // Spacer
        
        const addButton = new Gtk.Button({
            label: 'Add Project',
            halign: Gtk.Align.END
        });
        addButton.connect('clicked', () => {
            this._showAddDialog(window, configManager, githubAPI, releaseMonitoringAPI, group);
        });
        headerBox.append(addButton);
        group.add(headerBox);
        
        // Store references for updates
        group._configManager = configManager;
        group._githubAPI = githubAPI;
        group._window = window;
        
        // Load projects
        this._loadProjects(group);
        
        page.add(group);
        
        window.add(page);
    }
    
    _loadProjects(group) {
        // Clear existing project rows (keep the header box)
        if (group._projectRows) {
            group._projectRows.forEach(row => {
                group.remove(row);
            });
        }
        group._projectRows = [];
        
        const configManager = group._configManager;
        const projects = configManager.getProjects();
        
        if (projects.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: 'No projects monitored',
                subtitle: 'Click "Add Project" to add a repository to monitor'
            });
            group.add(emptyRow);
            group._projectRows.push(emptyRow);
        } else {
            projects.forEach(project => {
                this._addProjectRow(group, project);
            });
        }
    }
    
    _addProjectRow(group, project) {
        const source = project.source || 'github';
        const displayName = source === 'release-monitoring'
            ? (project.projectName || project.owner || 'unknown') + ' (release-monitoring.org)'
            : `${project.owner}/${project.repo}`;
        const row = new Adw.ActionRow({
            title: displayName
        });
        
        let subtitle = 'No releases found';
        if (project.lastRelease) {
            const releaseVersion = project.lastRelease.tag_name || project.lastRelease.version || project.lastRelease.name || 'unknown';
            subtitle = `Latest: ${project.lastRelease.name || releaseVersion} (${releaseVersion})`;
        }
        if (project.versionFilter) {
            subtitle += ` [Filter: ${project.versionFilter}]`;
        }
        row.set_subtitle(subtitle);
        
        // Version filter button
        const filterButton = new Gtk.Button({
            label: project.versionFilter || 'Set Filter',
            tooltip_text: 'Set version filter (e.g., "1.0.x")',
            valign: Gtk.Align.CENTER
        });
        filterButton.connect('clicked', () => {
            this._showVersionFilterDialog(group._window, group._configManager, project, group);
        });
        
        // Remove button
        const removeButton = new Gtk.Button({
            label: 'Remove',
            valign: Gtk.Align.CENTER
        });
        removeButton.add_css_class('destructive-action');
        removeButton.connect('clicked', () => {
            // Determine the actual source (handle null/undefined for backward compatibility)
            const actualSource = source || project.source || 'github';
            const versionFilter = project.versionFilter || null;
            console.log(`Remove button clicked for project: ${displayName}, source: ${actualSource}, versionFilter: ${versionFilter}`);
            
            if (actualSource === 'release-monitoring') {
                const projectName = project.projectName || project.owner;
                console.log(`Removing release-monitoring project: ${projectName} (filter: ${versionFilter})`);
                group._configManager.removeProject(
                    projectName,
                    null,
                    actualSource,
                    versionFilter
                );
            } else {
                console.log(`Removing GitHub project: ${project.owner}/${project.repo} (filter: ${versionFilter})`);
                group._configManager.removeProject(project.owner, project.repo, actualSource, versionFilter);
            }
            // Reload the config to ensure we have the latest data
            group._configManager.load();
            this._loadProjects(group);
        });
        
        // Create a box for buttons
        const buttonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 5
        });
        buttonBox.append(filterButton);
        buttonBox.append(removeButton);
        
        row.add_suffix(buttonBox);
        row.set_activatable_widget(buttonBox);
        
        group.add(row);
        if (!group._projectRows) {
            group._projectRows = [];
        }
        group._projectRows.push(row);
    }
    
    _showVersionFilterDialog(window, configManager, project, group) {
        const dialog = new Gtk.Dialog({
            title: 'Set Version Filter',
            modal: true,
            transient_for: window
        });
        
        const contentArea = dialog.get_content_area();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_start: 10,
            margin_end: 10,
            margin_top: 10,
            margin_bottom: 10
        });
        
        const source = project.source || 'github';
        const projectIdentifier = source === 'release-monitoring'
            ? (project.projectName || project.owner || 'unknown')
            : `${project.owner}/${project.repo}`;
        const infoLabel = new Gtk.Label({
            label: `Filter releases for ${projectIdentifier}\n\nExamples:\n• "1.0.x" or "1.0.*" - matches 1.0.1, 1.0.2, etc.\n• "1.5.x" - matches 1.5.1, 1.5.2, etc.\n• Leave empty to monitor all releases`,
            halign: Gtk.Align.START,
            wrap: true
        });
        box.append(infoLabel);
        
        const versionFilterEntry = new Gtk.Entry({
            placeholder_text: 'e.g., 1.0.x',
            text: project.versionFilter || ''
        });
        box.append(versionFilterEntry);
        
        contentArea.append(box);
        
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        dialog.add_button('Save', Gtk.ResponseType.OK);
        
        dialog.connect('response', (dialog, response) => {
            if (response === Gtk.ResponseType.OK) {
                const newVersionFilter = versionFilterEntry.get_text().trim() || null;
                const currentVersionFilter = project.versionFilter || null;
                if (source === 'release-monitoring') {
                    configManager.updateProjectVersionFilter(
                        project.projectName || project.owner,
                        null,
                        newVersionFilter,
                        source,
                        currentVersionFilter
                    );
                } else {
                    configManager.updateProjectVersionFilter(
                        project.owner,
                        project.repo,
                        newVersionFilter,
                        source,
                        currentVersionFilter
                    );
                }
                this._loadProjects(group);
            }
            dialog.destroy();
        });
        
        dialog.present();
    }
    
    _showAddDialog(window, configManager, githubAPI, releaseMonitoringAPI, group) {
        const dialog = new Gtk.Dialog({
            title: 'Add Project',
            modal: true,
            transient_for: window
        });
        
        const contentArea = dialog.get_content_area();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_start: 10,
            margin_end: 10,
            margin_top: 10,
            margin_bottom: 10
        });
        
        // Source selection
        const sourceLabel = new Gtk.Label({
            label: 'Source:',
            halign: Gtk.Align.START
        });
        box.append(sourceLabel);
        
        const sourceCombo = new Gtk.ComboBoxText();
        sourceCombo.append('github', 'GitHub');
        sourceCombo.append('release-monitoring', 'release-monitoring.org');
        sourceCombo.set_active_id('github');
        box.append(sourceCombo);
        
        // GitHub fields (owner/repo)
        const ownerLabel = new Gtk.Label({
            label: 'Owner/Organization:',
            halign: Gtk.Align.START
        });
        box.append(ownerLabel);
        
        const ownerEntry = new Gtk.Entry();
        box.append(ownerEntry);
        
        const repoLabel = new Gtk.Label({
            label: 'Repository:',
            halign: Gtk.Align.START
        });
        box.append(repoLabel);
        
        const repoEntry = new Gtk.Entry();
        box.append(repoEntry);
        
        // Release-monitoring.org field (project name)
        const projectNameLabel = new Gtk.Label({
            label: 'Project Name:',
            halign: Gtk.Align.START,
            visible: false
        });
        box.append(projectNameLabel);
        
        const projectNameEntry = new Gtk.Entry({
            placeholder_text: 'e.g., clamav',
            visible: false
        });
        box.append(projectNameEntry);
        
        // Version filter (common to both)
        const versionFilterLabel = new Gtk.Label({
            label: 'Version Filter (optional, e.g., "1.0.x" or "1.5.*"):',
            halign: Gtk.Align.START
        });
        box.append(versionFilterLabel);
        
        const versionFilterEntry = new Gtk.Entry({
            placeholder_text: 'Leave empty for all releases'
        });
        box.append(versionFilterEntry);
        
        // Show/hide fields based on source
        const updateFields = () => {
            const source = sourceCombo.get_active_id();
            if (source === 'release-monitoring') {
                ownerLabel.set_visible(false);
                ownerEntry.set_visible(false);
                repoLabel.set_visible(false);
                repoEntry.set_visible(false);
                projectNameLabel.set_visible(true);
                projectNameEntry.set_visible(true);
            } else {
                ownerLabel.set_visible(true);
                ownerEntry.set_visible(true);
                repoLabel.set_visible(true);
                repoEntry.set_visible(true);
                projectNameLabel.set_visible(false);
                projectNameEntry.set_visible(false);
            }
        };
        sourceCombo.connect('changed', updateFields);
        updateFields(); // Initial state
        
        contentArea.append(box);
        
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        const addButton = dialog.add_button('Add', Gtk.ResponseType.OK);
        
        dialog.connect('response', async (dialog, response) => {
            if (response === Gtk.ResponseType.OK) {
                const source = sourceCombo.get_active_id() || 'github';
                let owner = ownerEntry.get_text().trim();
                let repo = repoEntry.get_text().trim();
                let projectName = projectNameEntry.get_text().trim();
                let versionFilter = versionFilterEntry.get_text().trim() || null;
                
                if (source === 'release-monitoring') {
                    // Validate release-monitoring.org project
                    if (!projectName) {
                        this._showError(window, 
                            'Invalid input', 
                            'Please enter a project name.'
                        );
                        return;
                    }
                    
                    try {
                        console.log(`Checking release-monitoring.org project: ${projectName}`);
                        const exists = await releaseMonitoringAPI.checkProject(projectName);
                        console.log(`Project check result: ${exists}`);
                        if (exists) {
                            configManager.addProject(null, null, versionFilter, source, projectName);
                            this._loadProjects(group);
                            
                            // Check for release immediately
                            try {
                                console.log(`Fetching latest release for: ${projectName}${versionFilter ? ` (filter: ${versionFilter})` : ''}`);
                                const release = await releaseMonitoringAPI.getLatestRelease(projectName, versionFilter, githubAPI);
                                if (release) {
                                    console.log(`Found release: ${release.version || release.tag_name}`);
                                    configManager.updateProjectRelease(null, null, release, source, projectName, versionFilter, false);
                                    this._loadProjects(group);
                                } else {
                                    console.log(`No releases found for: ${projectName}`);
                                }
                            } catch (e) {
                                console.log(`Error fetching release: ${e.message}`);
                                console.error(`Error fetching release: ${e}`);
                            }
                        } else {
                            this._showError(window, 
                                'Project not found', 
                                `The project "${projectName}" was not found on release-monitoring.org.\n\nPlease verify the project name is correct.`
                            );
                        }
                    } catch (e) {
                        console.log(`Error checking project: ${e.message}`);
                        this._showError(window, 
                            'Error checking project', 
                            `Failed to check project "${projectName}":\n\n${e.message}\n\nPlease check your internet connection and try again.`
                        );
                    }
                } else {
                    // GitHub source
                    // Helper function to parse GitHub URL
                    const parseGitHubUrl = (urlString) => {
                        try {
                            urlString = urlString.trim().replace(/\/$/, '');
                            const githubPattern = /^https?:\/\/(?:www\.)?github\.com\/([^\/]+)\/([^\/\?#]+)/;
                            const match = urlString.match(githubPattern);
                            if (match) {
                                return {
                                    owner: match[1],
                                    repo: match[2]
                                };
                            }
                            return null;
                        } catch (e) {
                            console.error(`Error parsing URL: ${e.message}`);
                            return null;
                        }
                    };
                    
                    // If user entered a full URL in either field, parse it
                    if (repo.startsWith('http://') || repo.startsWith('https://')) {
                        const parsed = parseGitHubUrl(repo);
                        if (parsed) {
                            owner = parsed.owner;
                            repo = parsed.repo;
                            console.log(`Parsed URL: owner=${owner}, repo=${repo}`);
                        } else {
                            this._showError(window, 
                                'Invalid URL', 
                                'Please enter a valid GitHub repository URL.\n\nExample: https://github.com/owner/repo'
                            );
                            return;
                        }
                    } else if (owner.startsWith('http://') || owner.startsWith('https://')) {
                        const parsed = parseGitHubUrl(owner);
                        if (parsed) {
                            owner = parsed.owner;
                            repo = parsed.repo;
                            console.log(`Parsed URL from owner field: owner=${owner}, repo=${repo}`);
                        } else {
                            this._showError(window, 
                                'Invalid URL', 
                                'Please enter a valid GitHub repository URL.\n\nExample: https://github.com/owner/repo'
                            );
                            return;
                        }
                    }
                    
                    if (owner && repo) {
                        // Validate repository exists
                        try {
                            console.log(`Checking repository: ${owner}/${repo}`);
                            const exists = await githubAPI.checkRepository(owner, repo);
                            console.log(`Repository check result: ${exists}`);
                            if (exists) {
                                configManager.addProject(owner, repo, versionFilter, source);
                                this._loadProjects(group);
                                
                                // Check for release immediately
                                try {
                                    console.log(`Fetching latest release for: ${owner}/${repo}${versionFilter ? ` (filter: ${versionFilter})` : ''}`);
                                    const release = await githubAPI.getLatestRelease(owner, repo, versionFilter);
                                    if (release) {
                                        console.log(`Found release: ${release.tag_name}`);
                                        configManager.updateProjectRelease(owner, repo, release, source, null, versionFilter, false);
                                        this._loadProjects(group);
                                    } else {
                                        console.log(`No releases found for: ${owner}/${repo}`);
                                    }
                                } catch (e) {
                                    console.log(`Error fetching release: ${e.message}`);
                                    console.error(`Error fetching release: ${e}`);
                                }
                            } else {
                                this._showError(window, 
                                    'Repository not found', 
                                    `The repository "${owner}/${repo}" does not exist or is private.\n\nPlease verify:\n• The owner/organization name is correct\n• The repository name is correct\n• The repository is public`
                                );
                            }
                        } catch (e) {
                            console.log(`Error checking repository: ${e.message}`);
                            this._showError(window, 
                                'Error checking repository', 
                                `Failed to check repository "${owner}/${repo}":\n\n${e.message}\n\nPlease check your internet connection and try again.`
                            );
                        }
                    } else {
                        this._showError(window, 
                            'Invalid input', 
                            'Please enter both owner/organization and repository name.'
                        );
                    }
                }
            }
            dialog.destroy();
        });
        
        dialog.present();
    }
    
    _showError(window, heading, body) {
        const dialog = new Adw.MessageDialog({
            heading: heading || 'Error',
            body: body || 'An error occurred',
            transient_for: window
        });
        dialog.add_response('ok', 'OK');
        dialog.set_response_appearance('ok', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', () => dialog.destroy());
        dialog.present();
    }
}
