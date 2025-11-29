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

// ============================================================================
// ConfigManager - Manages project configuration storage
// ============================================================================
const ConfigManager = class {
    constructor() {
        this.configDir = GLib.get_user_config_dir();
        this.configFile = Gio.File.new_for_path(
            GLib.build_filenamev([this.configDir, 'gnome-release-monitor', 'projects.json'])
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
            console.error(`Error loading config: ${e}`);
            this.projects = [];
        }
    }

    save() {
        try {
            const encoder = new TextEncoder();
            const jsonStr = JSON.stringify(this.projects, null, 2);
            const data = encoder.encode(jsonStr);
            this.configFile.replace_contents(data, null, false, Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            console.error(`Error saving config: ${e}`);
        }
    }

    addProject(owner, repo) {
        const project = {
            owner: owner,
            repo: repo,
            lastRelease: null,
            lastChecked: null
        };
        this.projects.push(project);
        this.save();
        return project;
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
            this.save();
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

    async getLatestRelease(owner, repo) {
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
// Preferences Window
// ============================================================================
export default class ReleaseMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const configManager = new ConfigManager();
        const githubAPI = new GitHubAPI();
        
        // Create AdwPreferencesPage
        const page = new Adw.PreferencesPage({
            title: 'Monitored Projects',
            icon_name: 'software-update-available-symbolic'
        });
        
        // Create a preferences group
        const group = new Adw.PreferencesGroup({
            title: 'GitHub Projects',
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
            this._showAddDialog(window, configManager, githubAPI, group);
        });
        headerBox.append(addButton);
        group.add(headerBox);
        
        // Store references for updates
        group._configManager = configManager;
        group._githubAPI = githubAPI;
        
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
        const row = new Adw.ActionRow({
            title: `${project.owner}/${project.repo}`
        });
        
        let subtitle = 'No releases found';
        if (project.lastRelease) {
            subtitle = `Latest: ${project.lastRelease.name} (${project.lastRelease.tag_name})`;
        }
        row.set_subtitle(subtitle);
        
        // Remove button
        const removeButton = new Gtk.Button({
            label: 'Remove',
            valign: Gtk.Align.CENTER
        });
        removeButton.add_css_class('destructive-action');
        removeButton.connect('clicked', () => {
            group._configManager.removeProject(project.owner, project.repo);
            this._loadProjects(group);
        });
        row.add_suffix(removeButton);
        row.set_activatable_widget(removeButton);
        
        group.add(row);
        if (!group._projectRows) {
            group._projectRows = [];
        }
        group._projectRows.push(row);
    }
    
    _showAddDialog(window, configManager, githubAPI, group) {
        const dialog = new Gtk.Dialog({
            title: 'Add GitHub Project',
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
        
        contentArea.append(box);
        
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        const addButton = dialog.add_button('Add', Gtk.ResponseType.OK);
        
        dialog.connect('response', async (dialog, response) => {
            if (response === Gtk.ResponseType.OK) {
                let owner = ownerEntry.get_text().trim();
                let repo = repoEntry.get_text().trim();
                
                // Helper function to parse GitHub URL
                const parseGitHubUrl = (urlString) => {
                    try {
                        // Remove trailing slash if present
                        urlString = urlString.trim().replace(/\/$/, '');
                        
                        // Match GitHub URL pattern: https://github.com/owner/repo
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
                // Check repo field first (it takes precedence if it's a URL)
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
                    // If owner field has a URL, parse it
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
                            configManager.addProject(owner, repo);
                            this._loadProjects(group);
                            
                            // Check for release immediately
                            try {
                                console.log(`Fetching latest release for: ${owner}/${repo}`);
                                const release = await githubAPI.getLatestRelease(owner, repo);
                                if (release) {
                                    console.log(`Found release: ${release.tag_name}`);
                                    configManager.updateProjectRelease(owner, repo, release);
                                    this._loadProjects(group); // Refresh to show the release
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
