# Release Monitor

A GNOME Shell extension that monitors GitHub projects for new releases and notifies you when they become available.

## Features

- Monitor multiple GitHub repositories and release-monitoring.org projects for new releases
- Get desktop notifications when new releases are detected
- View all monitored projects and their current releases in a preferences window
- Easy-to-use interface to add and remove projects
- Automatic checking every 30 minutes (configurable)
- Visual indicator icon changes when new releases are available

## Installation

1. Clone or download this repository:
```bash
git clone <repository-url>
cd gnome-release-monitor
```

2. Copy the extension to your GNOME Shell extensions directory:
```bash
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r . ~/.local/share/gnome-shell/extensions/release-monitor@atomicrocketturtle.com
```

3. Restart GNOME Shell (press Alt+F2, type `r` and press Enter) or log out and log back in.

4. Enable the extension using GNOME Extensions app or:
```bash
gnome-extensions enable release-monitor@atomicrocketturtle.com
```

## Usage

1. Click on the extension icon in the top panel to open the preferences window.

2. Click the "Add" button in the top right to add a new project to monitor.

3. Enter the GitHub owner/organization and repository name (e.g., `gnome` and `gnome-shell`).

4. The extension will automatically check for new releases every 30 minutes and notify you when a new release is detected.

5. Click on a notification to open the release page on GitHub.

6. To remove a project, click the "Remove" button next to it in the preferences window.

## Configuration

The list of monitored projects is stored in:
```
~/.config/release-monitor/projects.json
```

You can manually edit this file if needed, but it's recommended to use the preferences window.

### Known Limitations

- **release-monitoring.org "Retrieved on" date**: The "Retrieved on (UTC)" date shown on the release-monitoring.org web interface is not exposed via their API v2. The extension uses the project's `updated_on` timestamp (when the project was last checked) as a fallback, which may not match the exact date when a specific version was first detected.

## Requirements

- GNOME Shell 45 or later
- Internet connection for checking GitHub releases

## Troubleshooting

If the extension doesn't work:

1. Check if it's enabled: `gnome-extensions list`
2. Check for errors: `journalctl -f | grep -i "release-monitor"`
3. Make sure you have an internet connection
4. Verify the GitHub repository exists and has releases

## Testing

To test the notification icon functionality:

1. Run the test script to simulate a new release:
   ```bash
   ./test-new-release.sh
   ```
2. Select a project from the list
3. The script will modify the project's stored release to an older version
4. Trigger a check by:
   - Clicking the reload button in the report window, OR
   - Waiting for the automatic check interval, OR
   - Restarting GNOME Shell (Alt+F2, type `r`)
5. The notification icon should change to indicate a new release is available
6. When you open the report window, the icon should return to normal
7. To restore the original state:
   ```bash
   ./restore-projects.sh
   ```

## Development

To modify the extension:

1. Make your changes to the source files
2. Restart GNOME Shell (Alt+F2, type `r`)
3. The extension will reload automatically

## License

This extension is provided as-is for personal use.

