# Release Monitor

A GNOME Shell extension that monitors GitHub projects, release-monitoring.org, and RHEL kernels for new releases and notifies you when they become available.

## Features

- Monitor multiple GitHub repositories and release-monitoring.org projects for new releases
- Monitor RHEL 8/9/10 `kernel` packages via Red Hat CDN (with entitlement certs) or the public Security Data API
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

2. Compile GSettings schemas and copy the extension:
```bash
glib-compile-schemas schemas/
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

3. Choose a source:
   - **GitHub** — owner/organization and repository name
   - **release-monitoring.org** — project name
   - **RHEL Kernel (CDN)** — RHEL major 8, 9, or 10

4. The extension will automatically check for new releases every 30 minutes and notify you when a new release is detected.

5. Click on a notification to open the release or advisory page.

6. To remove a project, click the "Remove" button next to it in the preferences window.

## RHEL kernel monitoring

Monitors track the newest `kernel` NEVRA for each RHEL major (`8` / `9` / `10`) on x86_64 BaseOS.

### Primary: Red Hat CDN

With entitlement certificates, the extension fetches CDN BaseOS repodata:

- `https://cdn.redhat.com/content/dist/rhel8/8/x86_64/baseos/os/`
- `https://cdn.redhat.com/content/dist/rhel9/9/x86_64/baseos/os/`
- `https://cdn.redhat.com/content/dist/rhel10/10/x86_64/baseos/os/`

Copy readable PEMs to:

```
~/.config/release-monitor/certs/
  <entitlement-id>.pem
  <entitlement-id>-key.pem
  redhat-uep.pem
```

Or set explicit paths in **Settings** (`rhel-cdn-cert-path`, `rhel-cdn-key-path`, `rhel-cdn-ca-path`). Entitlement files under `/etc/pki/entitlement/` are often root-only; copy them to the config certs directory.

### Fallback: Security Data API

Without CDN certs (or if CDN returns an error), the monitor uses the public Red Hat Security Data API for recent RHSA advisories with `package=kernel`, filtered by `.el8` / `.el9` / `.el10`. This catches **security** kernel releases early but may miss bugfix-only (RHBA) kernels.

### Why CentOS Stream is not monitored

CentOS Stream is a continuous preview of the *next* RHEL minor release. Stream kernel NEVRAs often diverge from the shipping RHEL z-stream, and Important/Critical security fixes frequently ship to RHEL first. For Rocky rebuilds of shipping RHEL kernels, RHEL CDN / RHSA is the accurate signal.

## Configuration

The list of monitored projects is stored in:
```
~/.config/release-monitor/projects.json
```

You can manually edit this file if needed, but it's recommended to use the preferences window.

Example RHEL kernel entry:

```json
{
  "source": "rhel-cdn",
  "major": "9",
  "arch": "x86_64",
  "package": "kernel",
  "owner": "rhel",
  "repo": "kernel-9",
  "projectName": "rhel-9/kernel",
  "lastRelease": null,
  "lastChecked": null
}
```

### Known Limitations

- **release-monitoring.org "Retrieved on" date**: The "Retrieved on (UTC)" date shown on the release-monitoring.org web interface is not exposed via their API v2. The extension uses the project's `updated_on` timestamp (when the project was last checked) as a fallback, which may not match the exact date when a specific version was first detected.
- **RHEL Security Data fallback**: Only RHSA (security) kernel updates are visible without CDN entitlements.
- **EUS/AUS/SAP content paths** are not monitored in this version (main `rhelN/N` BaseOS only).

## Requirements

- GNOME Shell 45 or later
- Internet connection for checking releases
- (Optional) Red Hat entitlement certificates for full CDN kernel detection including non-security updates

## Troubleshooting

If the extension doesn't work:

1. Check if it's enabled: `gnome-extensions list`
2. Check for errors: `journalctl -f | grep -i "release-monitor"`
3. Make sure you have an internet connection
4. Verify the GitHub repository exists and has releases
5. For RHEL CDN issues, confirm cert/key/CA paths are readable by your user and watch for CDN/Security Data messages in the journal

## Testing

### RHEL kernel fetch (CLI)

```bash
cd ~/src/gnome-release-monitor
./test-rhel-kernels.js          # RHEL 8, 9, and 10
./test-rhel-kernels.js 9        # one major
CERT=/path/cert.pem KEY=/path/key.pem CA=/path/redhat-uep.pem ./test-rhel-kernels.js
```

Without entitlement PEMs this uses the Security Data API fallback and prints version, method, published time, and errata URL.

### Notification icon

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
2. Recompile schemas if needed: `glib-compile-schemas schemas/`
3. Copy into `~/.local/share/gnome-shell/extensions/release-monitor@atomicrocketturtle.com/`
4. Restart GNOME Shell (Alt+F2, type `r`)

## License

This extension is provided as-is for personal use.
