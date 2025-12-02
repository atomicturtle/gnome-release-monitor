#!/usr/bin/env gjs

imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';

Adw.init();

// Simple debug flag for this helper window; set to true only when debugging
const DEBUG = false;

function debugLog(message) {
    if (DEBUG) {
        console.log(message);
    }
}

// Read projects and version from command line arguments
// Expected: report-window.js <projects-json-file> <version>
// If projects-json-file is "config", read from the actual config file location
const args = ARGV;
if (args.length < 2) {
    console.error('Usage: report-window.js <projects-json-file> <version>');
    imports.system.exit(1);
}

const version = args[1] || '1';

// Determine the projects file - if "config" is passed, use the actual config file
let projectsFile;
if (args[0] === 'config') {
    // Read from the actual config file location
    const configDir = GLib.get_user_config_dir();
    const configPath = GLib.build_filenamev([configDir, 'release-monitor', 'projects.json']);
    projectsFile = Gio.File.new_for_path(configPath);
    debugLog(`Using config file: ${configPath}`);
} else {
    // Use the temporary file passed as argument (for backward compatibility)
    projectsFile = Gio.File.new_for_path(args[0]);
    debugLog(`Using temporary file: ${args[0]}`);
}

// Read projects from JSON file
let projects = [];

const loadProjects = () => {
    try {
        const [success, contents] = projectsFile.load_contents(null);
        if (success) {
            const decoder = new TextDecoder('utf-8');
            const jsonData = decoder.decode(contents);
            projects = JSON.parse(jsonData);
            debugLog(`Loaded ${projects.length} projects from file`);
            return true;
        }
    } catch (e) {
        console.error(`Error reading projects file: ${e.message}`);
        return false;
    }
    return false;
};

const saveProjects = () => {
    try {
        const encoder = new TextEncoder('utf-8');
        const jsonData = JSON.stringify(projects, null, 2);
        const data = encoder.encode(jsonData);
        projectsFile.replace_contents(data, null, false, Gio.FileCreateFlags.NONE, null);
        debugLog(`Saved ${projects.length} projects to file`);
        return true;
    } catch (e) {
        console.error(`Error saving projects file: ${e.message}`);
        return false;
    }
};

// Initial load
if (!loadProjects()) {
    imports.system.exit(1);
}

const windowHeight = Math.min(700, projects.length * 50 + 200);

// Create application for theme support
const app = new Adw.Application({
    application_id: 'org.gnome.GitHubReleaseMonitor.Report',
    flags: Gio.ApplicationFlags.FLAGS_NONE
});

let window = null;

// Handle application activate signal
app.connect('activate', () => {
    if (!window) {
        // Window should already be created in startup
        return;
    }
    // Present window without forcing focus
    window.present();
});

// Wait for application startup before creating window
app.connect('startup', () => {
    debugLog('Application startup - creating window...');
    window = new Adw.ApplicationWindow({
        application: app
    });
    window.set_title(`Release Monitor - Project Report (v${version})`);
    window.set_default_size(900, windowHeight);
    window.set_resizable(true);
    window.set_deletable(true);
    window.set_modal(false);
    
    // Add a header bar to show title and window controls
    const headerBar = new Adw.HeaderBar();
    headerBar.set_show_end_title_buttons(true);
    headerBar.set_show_start_title_buttons(true);
    
    // Ensure window follows system dark/light mode
    const styleManager = Adw.StyleManager.get_default();
    // Check system color-scheme preference
    try {
        const settings = Gio.Settings.new('org.gnome.desktop.interface');
        // Try color-scheme first (GNOME 42+)
        let colorScheme = null;
        try {
            colorScheme = settings.get_string('color-scheme');
        } catch (e) {
            // Fallback: check gtk-theme for dark variants
            const gtkTheme = settings.get_string('gtk-theme');
            if (gtkTheme && gtkTheme.toLowerCase().includes('dark')) {
                colorScheme = 'prefer-dark';
            } else {
                colorScheme = 'prefer-light';
            }
        }
        
        if (colorScheme === 'prefer-dark') {
            styleManager.set_color_scheme(Adw.ColorScheme.FORCE_DARK);
        } else if (colorScheme === 'prefer-light') {
            styleManager.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);
        } else if (colorScheme === 'default') {
            // When default, check if system is actually in dark mode
            if (styleManager.get_dark()) {
                styleManager.set_color_scheme(Adw.ColorScheme.FORCE_DARK);
            } else {
                styleManager.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);
            }
        } else {
            // Fallback: check if dark mode is active
            if (styleManager.get_dark()) {
                styleManager.set_color_scheme(Adw.ColorScheme.FORCE_DARK);
            } else {
                styleManager.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);
            }
        }
    } catch (e) {
        // Fallback: use default (follows system)
        styleManager.set_color_scheme(Adw.ColorScheme.DEFAULT);
    }
    
    debugLog('Creating mainBox...');
    const mainBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
        margin_start: 20,
        margin_end: 20,
        margin_top: 20,
        margin_bottom: 20
    });
    
    // Title label in the main content area
    const reportTitleLabel = new Gtk.Label({
        label: '<b>Release Monitor - Project Report</b>',
        use_markup: true,
        halign: Gtk.Align.START
    });
    reportTitleLabel.set_visible(true);
    mainBox.append(reportTitleLabel);
    debugLog('Title label added to mainBox');
    
    if (projects.length === 0) {
        const emptyLabel = new Gtk.Label({
            label: 'No projects monitored',
            halign: Gtk.Align.START,
            margin_top: 20
        });
        mainBox.append(emptyLabel);
    } else {
        const scrolled = new Gtk.ScrolledWindow({
            vexpand: true,
            hexpand: true,
            margin_top: 10
        });
        
        const tableBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0
        });
        
        // Sort state
        let sortColumn = null;
        let sortAscending = true;
        
        // Store reference to tableBox for refresh
        let tableBoxRef = tableBox;
        
        // Function to sort and rebuild table
        const rebuildTable = (column, ascending) => {
            // Remove all data rows (keep header and separator)
            let child = tableBox.get_first_child();
            const rowsToRemove = [];
            while (child) {
                const next = child.get_next_sibling();
                if (child !== headerRow && child !== headerSeparator) {
                    rowsToRemove.push(child);
                }
                child = next;
            }
            rowsToRemove.forEach(row => tableBox.remove(row));
            
            // Sort projects (if column is null, use original order)
            let sortedProjects = projects;
            if (column !== null) {
                sortedProjects = [...projects].sort((a, b) => {
                    let aVal, bVal;
                    if (column === 'project') {
                        const aSource = a.source || 'github';
                        const aName = aSource === 'release-monitoring'
                            ? (a.projectName || a.owner || 'unknown')
                            : (a.owner + '/' + a.repo);
                        const bSource = b.source || 'github';
                        const bName = bSource === 'release-monitoring'
                            ? (b.projectName || b.owner || 'unknown')
                            : (b.owner + '/' + b.repo);
                        aVal = aName.toLowerCase();
                        bVal = bName.toLowerCase();
                    } else if (column === 'release') {
                        aVal = a.lastRelease ? (a.lastRelease.name || a.lastRelease.tag_name || a.lastRelease.version || '').toLowerCase() : 'zzz';
                        bVal = b.lastRelease ? (b.lastRelease.name || b.lastRelease.tag_name || b.lastRelease.version || '').toLowerCase() : 'zzz';
                    } else if (column === 'date') {
                        aVal = a.lastRelease && a.lastRelease.published_at ? new Date(a.lastRelease.published_at).getTime() : 0;
                        bVal = b.lastRelease && b.lastRelease.published_at ? new Date(b.lastRelease.published_at).getTime() : 0;
                    }
                    if (aVal < bVal) return ascending ? -1 : 1;
                    if (aVal > bVal) return ascending ? 1 : -1;
                    return 0;
                });
            }
            
            // Rebuild rows with sorted data
            sortedProjects.forEach((project, index) => {
                const row = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 10,
                    margin_bottom: 3
                });
                
                // Apply highlighting if this is a new release
                if (project.hasNewRelease === true) {
                    row.add_css_class('new-release-row');
                }
                
                const source = project.source || 'github';
                const displayName = source === 'release-monitoring'
                    ? (project.projectName || project.owner || 'unknown') + ' (release-monitoring.org)'
                    : (project.owner + '/' + project.repo);
                
                const nameLabel = new Gtk.Label({
                    label: displayName,
                    halign: Gtk.Align.START,
                    xalign: 0,
                    hexpand: true,
                    width_chars: 30
                });
                
                if (project.lastRelease && project.lastRelease.html_url) {
                    const clickableBox = new Gtk.Button();
                    clickableBox.set_child(nameLabel);
                    clickableBox.set_has_frame(false);
                    clickableBox.connect('clicked', () => {
                        // Open the URL
                        Gio.AppInfo.launch_default_for_uri(project.lastRelease.html_url, null);
                        
                        // Clear hasNewRelease flag if it's set
                        if (project.hasNewRelease === true) {
                            // Find the project in the projects array and clear the flag
                            const projectIndex = projects.findIndex(p => {
                                const pSource = p.source || 'github';
                                const pFilter = (p.versionFilter === null || p.versionFilter === undefined || p.versionFilter === '') ? null : p.versionFilter;
                                const projectFilter = (project.versionFilter === null || project.versionFilter === undefined || project.versionFilter === '') ? null : project.versionFilter;
                                
                                if (pSource === 'release-monitoring' && source === 'release-monitoring') {
                                    return p.projectName === project.projectName && pFilter === projectFilter;
                                } else if (pSource === 'github' || !pSource || pSource === null) {
                                    const isGitHub = (source === 'github' || !source || source === null);
                                    return isGitHub && p.owner === project.owner && p.repo === project.repo && pFilter === projectFilter;
                                }
                                return false;
                            });
                            
                            if (projectIndex !== -1) {
                                projects[projectIndex].hasNewRelease = false;
                                saveProjects();
                                // Reload to get updated data
                                loadProjects();
                                // Rebuild table to remove highlighting
                                rebuildTable(sortColumn, sortAscending);
                            }
                        }
                    });
                    row.append(clickableBox);
                } else {
                    row.append(nameLabel);
                }
                
                let releaseText = 'No releases found';
                if (project.lastRelease) {
                    releaseText = project.lastRelease.name || project.lastRelease.tag_name || project.lastRelease.version || 'unknown';
                }
                const releaseLabel = new Gtk.Label({
                    label: releaseText,
                    halign: Gtk.Align.START,
                    xalign: 0,
                    hexpand: true,
                    width_chars: 25
                });
                row.append(releaseLabel);
                
                let dateText = '—';
                if (project.lastRelease && project.lastRelease.published_at) {
                    const date = new Date(project.lastRelease.published_at);
                    dateText = date.toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric'
                    });
                }
                const dateLabel = new Gtk.Label({
                    label: dateText,
                    halign: Gtk.Align.START,
                    xalign: 0,
                    width_chars: 20
                });
                row.append(dateLabel);
                
                tableBox.append(row);
            });
        };
        
        const headerRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            margin_bottom: 5
        });
        
        // Project header (clickable)
        const nameHeaderButton = new Gtk.Button();
        const nameHeaderLabel = new Gtk.Label({
            label: '<b>Project</b>',
            use_markup: true,
            halign: Gtk.Align.START,
            xalign: 0
        });
        nameHeaderButton.set_child(nameHeaderLabel);
        nameHeaderButton.set_has_frame(false);
        nameHeaderButton.connect('clicked', () => {
            if (sortColumn === 'project') {
                sortAscending = !sortAscending;
            } else {
                sortColumn = 'project';
                sortAscending = true;
            }
            rebuildTable(sortColumn, sortAscending);
        });
        nameHeaderButton.set_hexpand(true);
        headerRow.append(nameHeaderButton);
        
        // Release header (clickable)
        const releaseHeaderButton = new Gtk.Button();
        const releaseHeaderLabel = new Gtk.Label({
            label: '<b>Latest Release</b>',
            use_markup: true,
            halign: Gtk.Align.START,
            xalign: 0
        });
        releaseHeaderButton.set_child(releaseHeaderLabel);
        releaseHeaderButton.set_has_frame(false);
        releaseHeaderButton.connect('clicked', () => {
            if (sortColumn === 'release') {
                sortAscending = !sortAscending;
            } else {
                sortColumn = 'release';
                sortAscending = true;
            }
            rebuildTable(sortColumn, sortAscending);
        });
        releaseHeaderButton.set_hexpand(true);
        headerRow.append(releaseHeaderButton);
        
        // Date header (clickable)
        const dateHeaderButton = new Gtk.Button();
        const dateHeaderLabel = new Gtk.Label({
            label: '<b>Published Date</b>',
            use_markup: true,
            halign: Gtk.Align.START,
            xalign: 0
        });
        dateHeaderButton.set_child(dateHeaderLabel);
        dateHeaderButton.set_has_frame(false);
        dateHeaderButton.connect('clicked', () => {
            if (sortColumn === 'date') {
                sortAscending = !sortAscending;
            } else {
                sortColumn = 'date';
                sortAscending = true;
            }
            rebuildTable(sortColumn, sortAscending);
        });
        headerRow.append(dateHeaderButton);
        
        tableBox.append(headerRow);
        
        const headerSeparator = new Gtk.Separator({
            orientation: Gtk.Orientation.HORIZONTAL,
            margin_bottom: 5
        });
        tableBox.append(headerSeparator);
        
        // Build initial table (unsorted)
        rebuildTable(null, true);
        
        scrolled.set_child(tableBox);
        scrolled.set_visible(true);
        mainBox.append(scrolled);
        debugLog(`Scrolled window with table added to mainBox, projects count: ${projects.length}`);
        
        // Add reload button to header bar (left side) - must be inside this block to access rebuildTable
        const reloadButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Reload projects'
        });
        
        reloadButton.connect('clicked', () => {
            // First, trigger the extension to check for updates
            const configDir = GLib.get_user_config_dir();
            const signalDir = GLib.build_filenamev([configDir, 'release-monitor', 'signals']);
            const signalDirFile = Gio.File.new_for_path(signalDir);
            if (!signalDirFile.query_exists(null)) {
                signalDirFile.make_directory_with_parents(null);
            }
            const signalFile = Gio.File.new_for_path(GLib.build_filenamev([signalDir, 'reload']));
            try {
                signalFile.replace_contents('', null, false, Gio.FileCreateFlags.NONE, null);
                debugLog('Reload signal file created');
                
                // Store initial project count and identifiers to detect changes
                const initialProjectCount = projects.length;
                const initialProjectIds = projects.map(p => {
                    const source = p.source || 'github';
                    return source === 'release-monitoring' 
                        ? (p.projectName || p.owner || 'unknown')
                        : `${p.owner}/${p.repo}`;
                }).sort();
                
                // Wait a moment for the extension to process, then refresh the window
                // Try multiple times in case the update takes a bit longer
                let attempts = 0;
                const maxAttempts = 10; // Increased to allow more time for new projects
                const checkAndRefresh = () => {
                    attempts++;
                    if (loadProjects()) {
                        // Check if projects changed (new project added, count changed, or releases updated)
                        const currentProjectCount = projects.length;
                        const currentProjectIds = projects.map(p => {
                            const source = p.source || 'github';
                            return source === 'release-monitoring' 
                                ? (p.projectName || p.owner || 'unknown')
                                : `${p.owner}/${p.repo}`;
                        }).sort();
                        
                        const projectCountChanged = currentProjectCount !== initialProjectCount;
                        const projectIdsChanged = JSON.stringify(currentProjectIds) !== JSON.stringify(initialProjectIds);
                        const hasReleases = projects.some(p => p.lastRelease);
                        
                        // Refresh if: count changed, IDs changed, releases found, or max attempts reached
                        if (projectCountChanged || projectIdsChanged || hasReleases || attempts >= maxAttempts) {
                            debugLog(`Reload: Refreshing - count changed: ${projectCountChanged}, IDs changed: ${projectIdsChanged}, has releases: ${hasReleases}, attempts: ${attempts}`);
                            rebuildTable(sortColumn, sortAscending);
                            return false; // Stop checking
                        }
                    }
                    if (attempts < maxAttempts) {
                        return true; // Continue checking
                    }
                    // Final refresh even if no changes detected
                    debugLog(`Reload: Final refresh after ${attempts} attempts`);
                    rebuildTable(sortColumn, sortAscending);
                    return false;
                };
                
                // Check every 500ms for up to 5 seconds (increased from 2.5)
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, checkAndRefresh);
            } catch (e) {
                console.error(`Could not create reload signal file: ${e.message}`);
            }
        });
        headerBar.pack_start(reloadButton);
    }
    
    // Add reload button for empty projects case (if projects.length === 0)
    if (projects.length === 0) {
        const reloadButtonEmpty = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Reload projects'
        });
        
        reloadButtonEmpty.connect('clicked', () => {
            const configDir = GLib.get_user_config_dir();
            const signalDir = GLib.build_filenamev([configDir, 'release-monitor', 'signals']);
            const signalDirFile = Gio.File.new_for_path(signalDir);
            if (!signalDirFile.query_exists(null)) {
                signalDirFile.make_directory_with_parents(null);
            }
            const signalFile = Gio.File.new_for_path(GLib.build_filenamev([signalDir, 'reload']));
            try {
                signalFile.replace_contents('', null, false, Gio.FileCreateFlags.NONE, null);
                debugLog('Reload signal file created (empty projects case)');
            } catch (e) {
                console.error(`Could not create reload signal file: ${e.message}`);
            }
        });
        headerBar.pack_start(reloadButtonEmpty);
    }
    
    // Add settings button to header bar (left side)
    const settingsButton = new Gtk.Button({
        icon_name: 'emblem-system-symbolic',
        tooltip_text: 'Settings'
    });
    settingsButton.connect('clicked', () => {
        // Trigger settings via signal file
        const configDir = GLib.get_user_config_dir();
        const signalDir = GLib.build_filenamev([configDir, 'release-monitor', 'signals']);
        const signalDirFile = Gio.File.new_for_path(signalDir);
        if (!signalDirFile.query_exists(null)) {
            signalDirFile.make_directory_with_parents(null);
        }
        const signalFile = Gio.File.new_for_path(GLib.build_filenamev([signalDir, 'open-settings']));
        try {
            signalFile.replace_contents('', null, false, Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            console.log(`Could not create signal file: ${e.message}`);
        }
    });
    headerBar.pack_start(settingsButton);
    
    // Add Project button to header bar (right side, before window controls)
    const addProjectButton = new Gtk.Button({
        label: 'Add Project',
        tooltip_text: 'Add a new project to monitor'
    });
    addProjectButton.connect('clicked', () => {
        console.log('Add Project button clicked from report window');
        try {
            GLib.spawn_command_line_async('gnome-extensions prefs release-monitor@atomicrocketturtle.com');
        } catch (e) {
            console.log(`Could not open Extensions app: ${e.message}`);
            try {
                GLib.spawn_command_line_async('gnome-extensions');
            } catch (e2) {
                console.log(`Could not open Extensions app (fallback): ${e2.message}`);
            }
        }
    });
    headerBar.pack_end(addProjectButton);
    
    // For Adw.ApplicationWindow, we add header bar to content, not use set_titlebar()
    // Create a main container that includes both header bar and content
    const mainContainer = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL
    });
    mainContainer.append(headerBar);
    mainContainer.append(mainBox);
    
    // Set the main content (which includes header bar)
    window.set_content(mainContainer);
    console.log('Content set on window');
    
    // Ensure content is visible and expands
    mainBox.set_visible(true);
    mainBox.set_vexpand(true);
    mainBox.set_hexpand(true);
    console.log('mainBox visibility and expansion set');
    
    // Connect close handler
    window.connect('close-request', () => {
        console.log('Window close requested');
        // Close the window and quit the application
        app.quit();
        return true; // Allow window to close
    });
    
    // Ensure window can always receive focus and input
    window.connect('notify::has-focus', () => {
        console.log(`Window focus changed: ${window.has_focus()}`);
    });
    
    // Create CSS provider for highlighting new releases
    const cssProvider = new Gtk.CssProvider();
    const css = `
        .new-release-row {
            background-color: rgba(99, 179, 237, 0.2);
        }
    `;
    cssProvider.load_from_data(css, css.length);
    const display = Gdk.Display.get_default();
    if (display) {
        Gtk.StyleContext.add_provider_for_display(
            display,
            cssProvider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
    }
    
    // Show and present the window
    window.set_visible(true);
    console.log('Window visibility set to true');
    // Present window asynchronously with low priority to avoid blocking
    GLib.idle_add(GLib.PRIORITY_LOW, () => {
        window.present();
        console.log('Window presented');
        return false; // Don't repeat
    });
    
    // Debug: log that window is ready
    console.log('Window created and content set - all done');
});

// Handle application shutdown
app.connect('shutdown', () => {
    // Cleanup if needed
});

// Start the application - run() will handle activation
try {
    // For Adw.Application, we pass command line arguments
    // The activate signal will be emitted automatically
    const exitCode = app.run([]);
    console.log(`Application exited with code: ${exitCode}`);
} catch (e) {
    console.error(`Error in application: ${e.message}`);
    console.error(e.stack);
    // Exit with error code
    imports.system.exit(1);
}

