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
        
        // Use GLib.spawn to launch a separate process that creates the window
        // This avoids crashes by running GTK in a separate process
        const projectsJson = JSON.stringify(projects);
        const windowHeight = Math.min(700, projects.length * 50 + 200);
        
        // Build script string carefully to avoid parsing issues
        let script = 'imports.gi.versions.Gtk = \'4.0\';\n';
        script += 'imports.gi.versions.Adw = \'1\';\n';
        script += 'import Gtk from \'gi://Gtk\';\n';
        script += 'import Gio from \'gi://Gio\';\n';
        script += 'import GLib from \'gi://GLib\';\n';
        script += 'import Adw from \'gi://Adw\';\n';
        script += '\n';
        script += 'Adw.init();\n';
        script += '\n';
        script += 'const projects = ' + projectsJson + ';\n';
        script += '\n';
        script += '// Create application for theme support\n';
        script += 'const app = new Adw.Application({\n';
        script += '    application_id: \'org.gnome.GitHubReleaseMonitor.Report\',\n';
        script += '    flags: Gio.ApplicationFlags.FLAGS_NONE\n';
        script += '});\n';
        script += '\n';
        script += 'let window = null;\n';
        script += '\n';
        script += '// Handle application activate signal\n';
        script += 'app.connect(\'activate\', () => {\n';
        script += '    if (!window) {\n';
        script += '        // Window should already be created in startup\n';
        script += '        return;\n';
        script += '    }\n';
        script += '    // Present window without forcing focus\n';
        script += '    window.present();\n';
        script += '});\n';
        script += '\n';
        script += '// Wait for application startup before creating window\n';
        script += 'app.connect(\'startup\', () => {\n';
        script += '    console.log(\'Application startup - creating window...\');\n';
        script += '    window = new Adw.ApplicationWindow({\n';
        script += '        application: app\n';
        script += '    });\n';
        script += '    window.set_title(\'Release Monitor - Project Report (v' + version + ')\');\n';
        script += '    window.set_default_size(900, ' + windowHeight + ');\n';
        script += '    window.set_resizable(true);\n';
        script += '    window.set_deletable(true);\n';
        script += '    window.set_modal(false);\n';
        script += '    // Note: set_hide_on_close, set_accept_focus, set_focus_on_map, set_can_focus, set_decorated\n';
        script += '    // are not available on Adw.ApplicationWindow - these are handled automatically\n';
        script += '    \n';
        script += '    // Add a header bar to show title and window controls\n';
        script += '    const headerBar = new Adw.HeaderBar();\n';
        script += '    headerBar.set_title_widget(new Adw.WindowTitle({\n';
        script += '        title: \'Release Monitor - Project Report (v' + version + ')\'\n';
        script += '    }));\n';
        script += '    headerBar.set_show_end_title_buttons(true);\n';
        script += '    headerBar.set_show_start_title_buttons(true);\n';
        script += '    \n';
        script += '    // Ensure window follows system dark/light mode\n';
        script += '    const styleManager = Adw.StyleManager.get_default();\n';
        script += '    // Check system color-scheme preference\n';
        script += '    try {\n';
        script += '        const settings = Gio.Settings.new(\'org.gnome.desktop.interface\');\n';
        script += '        // Try color-scheme first (GNOME 42+)\n';
        script += '        let colorScheme = null;\n';
        script += '        try {\n';
        script += '            colorScheme = settings.get_string(\'color-scheme\');\n';
        script += '        } catch (e) {\n';
        script += '            // Fallback: check gtk-theme for dark variants\n';
        script += '            const gtkTheme = settings.get_string(\'gtk-theme\');\n';
        script += '            if (gtkTheme && gtkTheme.toLowerCase().includes(\'dark\')) {\n';
        script += '                colorScheme = \'prefer-dark\';\n';
        script += '            } else {\n';
        script += '                colorScheme = \'prefer-light\';\n';
        script += '            }\n';
        script += '        }\n';
        script += '        \n';
        script += '        if (colorScheme === \'prefer-dark\') {\n';
        script += '            styleManager.set_color_scheme(Adw.ColorScheme.FORCE_DARK);\n';
        script += '        } else if (colorScheme === \'prefer-light\') {\n';
        script += '            styleManager.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);\n';
        script += '        } else if (colorScheme === \'default\') {\n';
        script += '            // When default, check if system is actually in dark mode\n';
        script += '            if (styleManager.get_dark()) {\n';
        script += '                styleManager.set_color_scheme(Adw.ColorScheme.FORCE_DARK);\n';
        script += '            } else {\n';
        script += '                styleManager.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);\n';
        script += '            }\n';
        script += '        } else {\n';
        script += '            // Fallback: check if dark mode is active\n';
        script += '            if (styleManager.get_dark()) {\n';
        script += '                styleManager.set_color_scheme(Adw.ColorScheme.FORCE_DARK);\n';
        script += '            } else {\n';
        script += '                styleManager.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);\n';
        script += '            }\n';
        script += '        }\n';
        script += '    } catch (e) {\n';
        script += '        // Fallback: use default (follows system)\n';
        script += '        styleManager.set_color_scheme(Adw.ColorScheme.DEFAULT);\n';
        script += '    }\n';
        script += '    \n';
        script += '    console.log(\'Creating mainBox...\');\n';
        script += '    const mainBox = new Gtk.Box({\n';
        script += '        orientation: Gtk.Orientation.VERTICAL,\n';
        script += '        spacing: 10,\n';
        script += '        margin_start: 20,\n';
        script += '        margin_end: 20,\n';
        script += '        margin_top: 20,\n';
        script += '        margin_bottom: 20\n';
        script += '    });\n';
        script += '    \n';
        script += '    const titleLabel = new Gtk.Label({\n';
        script += '        label: \'<b>Release Monitor - Project Report</b>\',\n';
        script += '        use_markup: true,\n';
        script += '        halign: Gtk.Align.START\n';
        script += '    });\n';
        script += '    titleLabel.set_visible(true);\n';
        script += '    mainBox.append(titleLabel);\n';
        script += '    console.log(\'Title label added to mainBox\');\n';
        script += '    \n';
        script += '    if (projects.length === 0) {\n';
        script += '        const emptyLabel = new Gtk.Label({\n';
        script += '            label: \'No projects monitored\',\n';
        script += '            halign: Gtk.Align.START,\n';
        script += '            margin_top: 20\n';
        script += '        });\n';
        script += '        mainBox.append(emptyLabel);\n';
        script += '    } else {\n';
        script += '        const scrolled = new Gtk.ScrolledWindow({\n';
        script += '            vexpand: true,\n';
        script += '            hexpand: true,\n';
        script += '            margin_top: 10\n';
        script += '        });\n';
        script += '        \n';
        script += '        const tableBox = new Gtk.Box({\n';
        script += '            orientation: Gtk.Orientation.VERTICAL,\n';
        script += '            spacing: 0\n';
        script += '        });\n';
        script += '        \n';
        script += '        // Sort state\n';
        script += '        let sortColumn = null;\n';
        script += '        let sortAscending = true;\n';
        script += '        \n';
        script += '        // Function to sort and rebuild table\n';
        script += '        const rebuildTable = (column, ascending) => {\n';
        script += '            // Remove all data rows (keep header and separator)\n';
        script += '            let child = tableBox.get_first_child();\n';
        script += '            const rowsToRemove = [];\n';
        script += '            while (child) {\n';
        script += '                const next = child.get_next_sibling();\n';
        script += '                if (child !== headerRow && child !== headerSeparator) {\n';
        script += '                    rowsToRemove.push(child);\n';
        script += '                }\n';
        script += '                child = next;\n';
        script += '            }\n';
        script += '            rowsToRemove.forEach(row => tableBox.remove(row));\n';
        script += '            \n';
        script += '            // Sort projects (if column is null, use original order)\n';
        script += '            let sortedProjects = projects;\n';
        script += '            if (column !== null) {\n';
        script += '                sortedProjects = [...projects].sort((a, b) => {\n';
        script += '                    let aVal, bVal;\n';
        script += '                    if (column === \'project\') {\n';
        script += '                        aVal = (a.owner + \'/\' + a.repo).toLowerCase();\n';
        script += '                        bVal = (b.owner + \'/\' + b.repo).toLowerCase();\n';
        script += '                    } else if (column === \'release\') {\n';
        script += '                        aVal = a.lastRelease ? (a.lastRelease.name || a.lastRelease.tag_name || \'\').toLowerCase() : \'zzz\';\n';
        script += '                        bVal = b.lastRelease ? (b.lastRelease.name || b.lastRelease.tag_name || \'\').toLowerCase() : \'zzz\';\n';
        script += '                    } else if (column === \'date\') {\n';
        script += '                        aVal = a.lastRelease && a.lastRelease.published_at ? new Date(a.lastRelease.published_at).getTime() : 0;\n';
        script += '                        bVal = b.lastRelease && b.lastRelease.published_at ? new Date(b.lastRelease.published_at).getTime() : 0;\n';
        script += '                    }\n';
        script += '                    if (aVal < bVal) return ascending ? -1 : 1;\n';
        script += '                    if (aVal > bVal) return ascending ? 1 : -1;\n';
        script += '                    return 0;\n';
        script += '                });\n';
        script += '            }\n';
        script += '            \n';
        script += '            // Rebuild rows with sorted data\n';
        script += '            sortedProjects.forEach((project, index) => {\n';
        script += '                const row = new Gtk.Box({\n';
        script += '                    orientation: Gtk.Orientation.HORIZONTAL,\n';
        script += '                    spacing: 10,\n';
        script += '                    margin_bottom: 3\n';
        script += '                });\n';
        script += '                \n';
        script += '                const nameLabel = new Gtk.Label({\n';
        script += '                    label: project.owner + \'/\' + project.repo,\n';
        script += '                    halign: Gtk.Align.START,\n';
        script += '                    xalign: 0,\n';
        script += '                    hexpand: true,\n';
        script += '                    width_chars: 30\n';
        script += '                });\n';
        script += '                \n';
        script += '                if (project.lastRelease && project.lastRelease.html_url) {\n';
        script += '                    const clickableBox = new Gtk.Button();\n';
        script += '                    clickableBox.set_child(nameLabel);\n';
        script += '                    clickableBox.set_has_frame(false);\n';
        script += '                    clickableBox.connect(\'clicked\', () => {\n';
        script += '                        Gio.AppInfo.launch_default_for_uri(project.lastRelease.html_url, null);\n';
        script += '                    });\n';
        script += '                    row.append(clickableBox);\n';
        script += '                } else {\n';
        script += '                    row.append(nameLabel);\n';
        script += '                }\n';
        script += '                \n';
        script += '                let releaseText = \'No releases found\';\n';
        script += '                if (project.lastRelease) {\n';
        script += '                    releaseText = project.lastRelease.name || project.lastRelease.tag_name;\n';
        script += '                }\n';
        script += '                const releaseLabel = new Gtk.Label({\n';
        script += '                    label: releaseText,\n';
        script += '                    halign: Gtk.Align.START,\n';
        script += '                    xalign: 0,\n';
        script += '                    hexpand: true,\n';
        script += '                    width_chars: 25\n';
        script += '                });\n';
        script += '                row.append(releaseLabel);\n';
        script += '                \n';
        script += '                let dateText = \'—\';\n';
        script += '                if (project.lastRelease && project.lastRelease.published_at) {\n';
        script += '                    const date = new Date(project.lastRelease.published_at);\n';
        script += '                    dateText = date.toLocaleDateString(\'en-US\', {\n';
        script += '                        year: \'numeric\',\n';
        script += '                        month: \'short\',\n';
        script += '                        day: \'numeric\'\n';
        script += '                    });\n';
        script += '                }\n';
        script += '                const dateLabel = new Gtk.Label({\n';
        script += '                    label: dateText,\n';
        script += '                    halign: Gtk.Align.START,\n';
        script += '                    xalign: 0,\n';
        script += '                    width_chars: 20\n';
        script += '                });\n';
        script += '                row.append(dateLabel);\n';
        script += '                \n';
        script += '                tableBox.append(row);\n';
        script += '            });\n';
        script += '        };\n';
        script += '        \n';
        script += '        const headerRow = new Gtk.Box({\n';
        script += '            orientation: Gtk.Orientation.HORIZONTAL,\n';
        script += '            spacing: 10,\n';
        script += '            margin_bottom: 5\n';
        script += '        });\n';
        script += '        \n';
        script += '        // Project header (clickable)\n';
        script += '        const nameHeaderButton = new Gtk.Button();\n';
        script += '        const nameHeaderLabel = new Gtk.Label({\n';
        script += '            label: \'<b>Project</b>\',\n';
        script += '            use_markup: true,\n';
        script += '            halign: Gtk.Align.START,\n';
        script += '            xalign: 0\n';
        script += '        });\n';
        script += '        nameHeaderButton.set_child(nameHeaderLabel);\n';
        script += '        nameHeaderButton.set_has_frame(false);\n';
        script += '        nameHeaderButton.connect(\'clicked\', () => {\n';
        script += '            if (sortColumn === \'project\') {\n';
        script += '                sortAscending = !sortAscending;\n';
        script += '            } else {\n';
        script += '                sortColumn = \'project\';\n';
        script += '                sortAscending = true;\n';
        script += '            }\n';
        script += '            rebuildTable(sortColumn, sortAscending);\n';
        script += '        });\n';
        script += '        nameHeaderButton.set_hexpand(true);\n';
        script += '        headerRow.append(nameHeaderButton);\n';
        script += '        \n';
        script += '        // Release header (clickable)\n';
        script += '        const releaseHeaderButton = new Gtk.Button();\n';
        script += '        const releaseHeaderLabel = new Gtk.Label({\n';
        script += '            label: \'<b>Latest Release</b>\',\n';
        script += '            use_markup: true,\n';
        script += '            halign: Gtk.Align.START,\n';
        script += '            xalign: 0\n';
        script += '        });\n';
        script += '        releaseHeaderButton.set_child(releaseHeaderLabel);\n';
        script += '        releaseHeaderButton.set_has_frame(false);\n';
        script += '        releaseHeaderButton.connect(\'clicked\', () => {\n';
        script += '            if (sortColumn === \'release\') {\n';
        script += '                sortAscending = !sortAscending;\n';
        script += '            } else {\n';
        script += '                sortColumn = \'release\';\n';
        script += '                sortAscending = true;\n';
        script += '            }\n';
        script += '            rebuildTable(sortColumn, sortAscending);\n';
        script += '        });\n';
        script += '        releaseHeaderButton.set_hexpand(true);\n';
        script += '        headerRow.append(releaseHeaderButton);\n';
        script += '        \n';
        script += '        // Date header (clickable)\n';
        script += '        const dateHeaderButton = new Gtk.Button();\n';
        script += '        const dateHeaderLabel = new Gtk.Label({\n';
        script += '            label: \'<b>Published Date</b>\',\n';
        script += '            use_markup: true,\n';
        script += '            halign: Gtk.Align.START,\n';
        script += '            xalign: 0\n';
        script += '        });\n';
        script += '        dateHeaderButton.set_child(dateHeaderLabel);\n';
        script += '        dateHeaderButton.set_has_frame(false);\n';
        script += '        dateHeaderButton.connect(\'clicked\', () => {\n';
        script += '            if (sortColumn === \'date\') {\n';
        script += '                sortAscending = !sortAscending;\n';
        script += '            } else {\n';
        script += '                sortColumn = \'date\';\n';
        script += '                sortAscending = true;\n';
        script += '            }\n';
        script += '            rebuildTable(sortColumn, sortAscending);\n';
        script += '        });\n';
        script += '        headerRow.append(dateHeaderButton);\n';
        script += '        \n';
        script += '        tableBox.append(headerRow);\n';
        script += '        \n';
        script += '        const headerSeparator = new Gtk.Separator({\n';
        script += '            orientation: Gtk.Orientation.HORIZONTAL,\n';
        script += '            margin_bottom: 5\n';
        script += '        });\n';
        script += '        tableBox.append(headerSeparator);\n';
        script += '        \n';
        script += '        // Build initial table (unsorted)\n';
        script += '        rebuildTable(null, true);\n';
        script += '        \n';
        script += '        scrolled.set_child(tableBox);\n';
        script += '        scrolled.set_visible(true);\n';
        script += '        mainBox.append(scrolled);\n';
        script += '        console.log(\'Scrolled window with table added to mainBox, projects count: \' + projects.length);\n';
        script += '    }\n';
        script += '    \n';
        script += '    // For Adw.ApplicationWindow, we add header bar to content, not use set_titlebar()\n';
        script += '    // Create a main container that includes both header bar and content\n';
        script += '    const mainContainer = new Gtk.Box({\n';
        script += '        orientation: Gtk.Orientation.VERTICAL\n';
        script += '    });\n';
        script += '    mainContainer.append(headerBar);\n';
        script += '    mainContainer.append(mainBox);\n';
        script += '    \n';
        script += '    // Set the main content (which includes header bar)\n';
        script += '    window.set_content(mainContainer);\n';
        script += '    console.log(\'Content set on window\');\n';
        script += '    \n';
        script += '    // Ensure content is visible and expands\n';
        script += '    mainBox.set_visible(true);\n';
        script += '    mainBox.set_vexpand(true);\n';
        script += '    mainBox.set_hexpand(true);\n';
        script += '    console.log(\'mainBox visibility and expansion set\');\n';
        script += '    \n';
        script += '    // Connect close handler\n';
        script += '    window.connect(\'close-request\', () => {\n';
        script += '        console.log(\'Window close requested\');\n';
        script += '        // Close the window and quit the application\n';
        script += '        app.quit();\n';
        script += '        return true; // Allow window to close\n';
        script += '    });\n';
        script += '    \n';
        script += '    // Ensure window can always receive focus and input\n';
        script += '    window.connect(\'notify::has-focus\', () => {\n';
        script += '        console.log(\'Window focus changed: \' + window.has_focus());\n';
        script += '    });\n';
        script += '    \n';
        script += '    // Show and present the window\n';
        script += '    window.set_visible(true);\n';
        script += '    console.log(\'Window visibility set to true\');\n';
        script += '    // Present window asynchronously with low priority to avoid blocking\n';
        script += '    GLib.idle_add(GLib.PRIORITY_LOW, () => {\n';
        script += '        window.present();\n';
        script += '        console.log(\'Window presented\');\n';
        script += '        return false; // Don\'t repeat\n';
        script += '    });\n';
        script += '    \n';
        script += '    // Debug: log that window is ready\n';
        script += '    console.log(\'Window created and content set - all done\');\n';
        script += '});\n';
        script += '\n';
        script += '// Handle application shutdown\n';
        script += 'app.connect(\'shutdown\', () => {\n';
        script += '    // Cleanup if needed\n';
        script += '});\n';
        script += '\n';
        script += '// Start the application - run() will handle activation\n';
        script += 'try {\n';
        script += '    // For Adw.Application, we pass command line arguments\n';
        script += '    // The activate signal will be emitted automatically\n';
        script += '    const exitCode = app.run([]);\n';
        script += '    console.log(\'Application exited with code: \' + exitCode);\n';
        script += '} catch (e) {\n';
        script += '    console.error(\'Error in application: \' + e.message);\n';
        script += '    console.error(e.stack);\n';
        script += '    // Exit with error code\n';
        script += '    imports.system.exit(1);\n';
        script += '}\n';
        
        // Write script to temp file and execute it
        try {
            console.log('_openReportWindow: Creating temp file...');
            const [fd, filePath] = GLib.file_open_tmp('release-monitor-XXXXXX.gjs');
            console.log(`_openReportWindow: Temp file created: ${filePath}`);
            
            // Close the file descriptor - we'll use Gio.File to write
            GLib.close(fd);
            
            const file = Gio.File.new_for_path(filePath);
            
            // Write the script
            console.log('_openReportWindow: Writing script to file...');
            const encoder = new TextEncoder();
            const data = encoder.encode(script);
            const [success, etag] = file.replace_contents(data, null, false, Gio.FileCreateFlags.NONE, null);
            
            if (!success) {
                throw new Error('Failed to write script to temp file');
            }
            
            console.log(`_openReportWindow: Script written, launching with: gjs -m ${filePath}`);
            
            // Make the file executable
            const fileInfo = file.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
            const currentMode = fileInfo.get_attribute_uint32('unix::mode');
            fileInfo.set_attribute_uint32('unix::mode', currentMode | 0o111); // Add execute permission
            file.set_attributes_from_info(fileInfo, Gio.FileQueryInfoFlags.NONE, null);
            
                   // Launch it with proper error handling (use -m flag for module mode)
                   // Use DO_NOT_REAP_CHILD so we can track the process
                   const [launched, pid] = GLib.spawn_async(
                       null,
                       ['gjs', '-m', filePath],
                       null,
                       GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                       null
                   );
            
            if (!launched) {
                throw new Error('Failed to launch gjs process');
            }
            
            // Track the process ID to prevent multiple windows
            this._reportWindowProcessId = pid;
            console.log(`_openReportWindow: Process launched with PID ${pid}`);
            
            // Monitor process to clear the ID when it exits
            GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (pid, status) => {
                console.log(`_openReportWindow: Process ${pid} exited with status ${status}`);
                this._reportWindowProcessId = null;
                GLib.spawn_close_pid(pid); // Clean up the child process
                return GLib.SOURCE_REMOVE; // Remove the watch
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
                console.log(`checkForUpdates: Checking ${project.owner}/${project.repo}`);
                const release = await this.githubAPI.getLatestRelease(project.owner, project.repo);
                
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

