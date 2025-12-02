import Soup from "gi://Soup";
imports.gi.versions.Soup = '3.0';
import GLib from "gi://GLib";
import * as Logger from "./logger.js";

// ============================================================================
// GitHubAPI - Handles GitHub API interactions
// ============================================================================
export const GitHubAPI = class {
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
        
        Logger.debug(`_matchesVersionPattern: tag="${tagName}" (normalized: "${normalizedTag}") pattern="${pattern}" (normalized: "${normalizedPattern}") regex="${regex}" -> ${matches}`);
        
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
                                
                                Logger.debug(`getLatestReleaseWithFilter: Found ${releases.length} total releases for ${owner}/${repo}`);
                                if (releases.length > 0) {
                                    Logger.debug(`getLatestReleaseWithFilter: First few tag names: ${releases.slice(0, 5).map(r => r.tag_name).join(', ')}`);
                                }
                                
                                // Filter releases by version pattern
                                const matchingReleases = releases.filter(release => {
                                    return this._matchesVersionPattern(release.tag_name, versionFilter);
                                });
                                
                                Logger.debug(`getLatestReleaseWithFilter: Found ${matchingReleases.length} matching releases for pattern "${versionFilter}"`);
                                
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

