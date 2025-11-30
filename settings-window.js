#!/usr/bin/env gjs

imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';

Adw.init();

// Read settings from command line arguments
// Expected: settings-window.js <extension-path> <version> <current-interval> <current-position> [api-token]
const args = ARGV;
if (args.length < 2) {
    console.error('Usage: settings-window.js <extension-path> <version> [current-interval] [current-position] [api-token]');
    imports.system.exit(1);
}

const extensionPath = args[0];
const version = args[1] || '1';
const currentInterval = args.length > 2 ? parseInt(args[2], 10) : 1800;
const currentPosition = args.length > 3 ? args[3] : 'right';
const currentApiToken = args.length > 4 ? args[4] : '';

// Create application for theme support
const app = new Adw.Application({
    application_id: 'org.gnome.ReleaseMonitor.Settings',
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
    console.log('Settings application startup - creating window...');
    window = new Adw.ApplicationWindow({
        application: app
    });
    window.set_title(`Release Monitor - Settings (v${version})`);
    window.set_default_size(500, 400);
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
    
    console.log('Creating mainBox...');
    const mainBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 20,
        margin_start: 20,
        margin_end: 20,
        margin_top: 20,
        margin_bottom: 20
    });
    
    const titleLabel = new Gtk.Label({
        label: '<b>Release Monitor - Settings</b>',
        use_markup: true,
        halign: Gtk.Align.START
    });
    titleLabel.set_visible(true);
    mainBox.append(titleLabel);
    
    // Use settings passed as arguments (already loaded above)
    console.log(`Settings window: Current interval is ${currentInterval} seconds, position is ${currentPosition}`);
    
    // Icon Position setting
    const iconPositionBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10
    });
    
    const iconPositionLabel = new Gtk.Label({
        label: '<b>Icon Position</b>',
        use_markup: true,
        halign: Gtk.Align.START
    });
    iconPositionBox.append(iconPositionLabel);
    
    const iconPositionDesc = new Gtk.Label({
        label: 'Choose where to display the icon on the panel',
        halign: Gtk.Align.START,
        wrap: true
    });
    iconPositionBox.append(iconPositionDesc);
    
    const iconPositionCombo = new Gtk.ComboBoxText();
    iconPositionCombo.append('left', 'Left');
    iconPositionCombo.append('center', 'Center');
    iconPositionCombo.append('right', 'Right');
    iconPositionCombo.set_active_id(currentPosition);
    iconPositionBox.append(iconPositionCombo);
    
    mainBox.append(iconPositionBox);
    
    // Refresh Interval setting
    const refreshIntervalBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10
    });
    
    const refreshIntervalLabel = new Gtk.Label({
        label: '<b>Refresh Interval</b>',
        use_markup: true,
        halign: Gtk.Align.START
    });
    refreshIntervalBox.append(refreshIntervalLabel);
    
    const refreshIntervalDesc = new Gtk.Label({
        label: 'How often to check for new releases (in minutes)',
        halign: Gtk.Align.START,
        wrap: true
    });
    refreshIntervalBox.append(refreshIntervalDesc);
    
    const currentMinutes = Math.floor(currentInterval / 60);
    const adjustment = new Gtk.Adjustment({
        value: currentMinutes,
        lower: 1,
        upper: 1440,
        step_increment: 1,
        page_increment: 10
    });
    
    const refreshIntervalSpin = new Gtk.SpinButton({
        adjustment: adjustment,
        numeric: true,
        climb_rate: 1,
        digits: 0
    });
    refreshIntervalSpin.set_value(currentMinutes);
    refreshIntervalBox.append(refreshIntervalSpin);
    
    mainBox.append(refreshIntervalBox);
    
    // API Token setting (for release-monitoring.org)
    const apiTokenBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10
    });
    
    const apiTokenLabel = new Gtk.Label({
        label: '<b>Release-monitoring.org API Token</b>',
        use_markup: true,
        halign: Gtk.Align.START
    });
    apiTokenBox.append(apiTokenLabel);
    
    const apiTokenDesc = new Gtk.Label({
        label: 'API token to bypass bot protection. Get your token from https://release-monitoring.org/settings/',
        halign: Gtk.Align.START,
        wrap: true
    });
    apiTokenBox.append(apiTokenDesc);
    
    const apiTokenEntry = new Gtk.Entry({
        placeholder_text: 'Enter your API token (optional)',
        visibility: false, // Hide token for security
        text: currentApiToken || ''
    });
    apiTokenBox.append(apiTokenEntry);
    
    mainBox.append(apiTokenBox);
    
    // Buttons
    const buttonBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        halign: Gtk.Align.END,
        margin_top: 20
    });
    
    const cancelButton = new Gtk.Button({
        label: 'Cancel'
    });
    cancelButton.connect('clicked', () => {
        app.quit();
    });
    buttonBox.append(cancelButton);
    
    const saveButton = new Gtk.Button({
        label: 'Save',
        css_classes: ['suggested-action']
    });
    saveButton.connect('clicked', () => {
        const newPosition = iconPositionCombo.get_active_id();
        const newMinutes = refreshIntervalSpin.get_value_as_int();
        const newInterval = newMinutes * 60;
        const newApiToken = apiTokenEntry.get_text().trim() || '';
        
        console.log(`Saving settings: position=${newPosition}, interval=${newInterval} seconds, apiToken=${newApiToken ? '***' : '(empty)'}`);
        
        // Write settings to signal file for main extension to read
        const settingsData = {
            iconPosition: newPosition,
            refreshInterval: newInterval,
            apiToken: newApiToken
        };
        
        const settingsFile = Gio.File.new_for_path('/tmp/release-monitor-settings-update.json');
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(JSON.stringify(settingsData));
            settingsFile.replace_contents(data, null, false, Gio.FileCreateFlags.NONE, null);
            
            // Create signal file
            const signalFile = Gio.File.new_for_path('/tmp/release-monitor-update-settings');
            signalFile.replace_contents('1', null, false, Gio.FileCreateFlags.NONE, null);
            
            console.log('Settings saved to signal file');
            app.quit();
        } catch (e) {
            console.error(`Error saving settings: ${e.message}`);
        }
    });
    buttonBox.append(saveButton);
    
    mainBox.append(buttonBox);
    
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

