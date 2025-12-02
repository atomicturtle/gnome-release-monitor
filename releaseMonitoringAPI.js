import Soup from "gi://Soup";
imports.gi.versions.Soup = '3.0';
import GLib from "gi://GLib";
import { GitHubAPI } from "./githubAPI.js";

// ============================================================================
// ReleaseMonitoringAPI - Handles release-monitoring.org API interactions
// ============================================================================
export const ReleaseMonitoringAPI = class {
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
                        tag_name: matchingVersion, // For compatibility
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
            tag_name: latestVersion, // For compatibility
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

