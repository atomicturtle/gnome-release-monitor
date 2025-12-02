import Gio from "gi://Gio";
import GLib from "gi://GLib";
import * as Logger from "./logger.js";

// ============================================================================
// ConfigManager - Manages project configuration storage
// ============================================================================
export const ConfigManager = class {
    constructor() {
        this.configDir = GLib.get_user_config_dir();
        this.configFile = Gio.File.new_for_path(
            GLib.build_filenamev([this.configDir, 'release-monitor', 'projects.json'])
        );
        this.lockFile = Gio.File.new_for_path(
            GLib.build_filenamev([this.configDir, 'release-monitor', 'projects.json.lock'])
        );
        this.projects = [];
        this._ensureConfigDir();
        this.load();
    }

    _ensureConfigDir() {
        try {
            const configDirFile = this.configFile.get_parent();
            if (!configDirFile.query_exists(null)) {
                configDirFile.make_directory_with_parents(null);
            }
        } catch (e) {
            Logger.error("Failed to create config directory", e);
            // Re-throw as this is critical - config directory must exist
            throw new Error(`Cannot create config directory: ${e.message}`);
        }
    }

    // Signal directory helpers for inter-process communication
    _getSignalDirectory() {
        const signalDirPath = GLib.build_filenamev([this.configDir, 'release-monitor', 'signals']);
        return Gio.File.new_for_path(signalDirPath);
    }

    _ensureSignalDir() {
        try {
            const signalDir = this._getSignalDirectory();
            if (!signalDir.query_exists(null)) {
                signalDir.make_directory_with_parents(null);
            }
        } catch (e) {
            Logger.error("Failed to create signal directory", e);
            // Don't throw - signal directory is not critical for basic operation
            // Signals will fail gracefully if directory doesn't exist
        }
    }

    getSignalFile(signalName) {
        this._ensureSignalDir();
        const signalDir = this._getSignalDirectory();
        return signalDir.get_child(signalName);
    }

    createSignal(signalName) {
        try {
            const signalFile = this.getSignalFile(signalName);
            // Create empty file atomically
            signalFile.replace_contents('', null, false, Gio.FileCreateFlags.NONE, null);
            Logger.debug(`Signal created: ${signalName}`);
            return true;
        } catch (e) {
            Logger.error(`Failed to create signal ${signalName}`, e);
            return false;
        }
    }

    _acquireLock(timeoutMs = 2000) {
        const start = GLib.get_monotonic_time();
        const timeoutUs = timeoutMs * 1000;

        while (true) {
            try {
                // Try to create lock file exclusively; fail if it exists
                if (!this.lockFile.query_exists(null)) {
                    const outputStream = this.lockFile.create(Gio.FileCreateFlags.NONE, null);
                    outputStream.close(null);
                    return true;
                }
            } catch (e) {
                // If creation fails for reasons other than already exists, log and continue
                Logger.debug(`Config lock create failed: ${e.message}`);
            }

            const elapsed = GLib.get_monotonic_time() - start;
            if (elapsed > timeoutUs) {
                Logger.warn("ConfigManager: lock acquisition timed out");
                return false;
            }

            // Sleep briefly before retrying (50ms)
            GLib.usleep(50_000);
        }
    }

    _releaseLock() {
        try {
            if (this.lockFile.query_exists(null)) {
                this.lockFile.delete(null);
            }
        } catch (e) {
            Logger.warn(`ConfigManager: failed to release lock: ${e.message}`);
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
            Logger.error("Error loading config", e);
            this.projects = [];
        }
    }

    save() {
        if (!this._acquireLock()) {
            Logger.error("ConfigManager: could not acquire lock for save()");
            return;
        }

        try {
            const encoder = new TextEncoder();
            const jsonStr = JSON.stringify(this.projects, null, 2);
            const data = encoder.encode(jsonStr);

            // Write to a temporary file first, then atomically replace the target
            const tmpPath = GLib.build_filenamev([this.configDir, 'release-monitor', 'projects.json.tmp']);
            const tmpFile = Gio.File.new_for_path(tmpPath);

            const tmpStream = tmpFile.replace(null, false, Gio.FileCreateFlags.NONE, null);
            tmpStream.write_all(data, null);
            tmpStream.close(null);

            // Atomic replace of config file with temp file
            tmpFile.move(this.configFile, Gio.FileCopyFlags.OVERWRITE, null, null);

            Logger.info("Config saved successfully");
        } catch (e) {
            Logger.error("Error saving config", e);
        } finally {
            this._releaseLock();
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
    
    updateProjectVersionFilter(owner, repo, newVersionFilter, source = 'github', currentVersionFilter = null) {
        // Normalize versionFilter: null, undefined, and empty string are treated as "no filter"
        const normalizedCurrentFilter = (currentVersionFilter === null || currentVersionFilter === undefined || currentVersionFilter === '') ? null : currentVersionFilter;
        
        const project = this.projects.find(
            p => {
                if (source === 'release-monitoring') {
                    const pFilter = (p.versionFilter === null || p.versionFilter === undefined || p.versionFilter === '') ? null : p.versionFilter;
                    return p.source === 'release-monitoring' && p.projectName === owner && pFilter === normalizedCurrentFilter;
                } else {
                    const isGitHub = (p.source === 'github' || !p.source || p.source === null);
                    const pFilter = (p.versionFilter === null || p.versionFilter === undefined || p.versionFilter === '') ? null : p.versionFilter;
                    return isGitHub && p.owner === owner && p.repo === repo && pFilter === normalizedCurrentFilter;
                }
            }
        );
        if (project) {
            project.versionFilter = newVersionFilter || null;
            this.save();
        }
    }

    removeProject(owner, repo, source = 'github', versionFilter = null) {
        // Normalize versionFilter: null, undefined, and empty string are treated as "no filter"
        const normalizedFilter = (versionFilter === null || versionFilter === undefined || versionFilter === '') ? null : versionFilter;
        
        Logger.info(`removeProject: Removing project owner=${owner}, repo=${repo}, source=${source}, versionFilter=${normalizedFilter}`);
        const beforeCount = this.projects.length;
        
        if (source === 'release-monitoring') {
            this.projects = this.projects.filter(
                p => {
                    const pFilter = (p.versionFilter === null || p.versionFilter === undefined || p.versionFilter === '') ? null : p.versionFilter;
                    const matches = p.source === 'release-monitoring' && p.projectName === owner && pFilter === normalizedFilter;
                    if (matches) {
                        Logger.debug(`removeProject: Filtering out release-monitoring project: ${p.projectName} (filter: ${pFilter})`);
                    }
                    return !matches;
                }
            );
        } else {
            // For GitHub projects, also handle projects without source field (backward compatibility)
            // Projects with null/undefined source are treated as GitHub projects
            this.projects = this.projects.filter(
                p => {
                    const isGitHub = (p.source === 'github' || !p.source || p.source === null);
                    const pFilter = (p.versionFilter === null || p.versionFilter === undefined || p.versionFilter === '') ? null : p.versionFilter;
                    const matches = isGitHub && p.owner === owner && p.repo === repo && pFilter === normalizedFilter;
                    if (matches) {
                        Logger.debug(`removeProject: Filtering out GitHub project: ${p.owner}/${p.repo} (source was: ${p.source}, filter: ${pFilter})`);
                    }
                    return !matches;
                }
            );
        }
        
        const afterCount = this.projects.length;
        Logger.info(`removeProject: Project count changed from ${beforeCount} to ${afterCount}`);
        if (beforeCount === afterCount) {
            Logger.error(`removeProject: WARNING - Project was not removed! Check if project exists with owner=${owner}, repo=${repo}, source=${source}, versionFilter=${normalizedFilter}`);
        }
        this.save();
        Logger.info("removeProject: Config saved after removal");
    }

    updateProjectRelease(owner, repo, release, source = 'github', projectName = null, versionFilter = null, isNewRelease = false) {
        // Normalize versionFilter: null, undefined, and empty string are treated as "no filter"
        const normalizedFilter = (versionFilter === null || versionFilter === undefined || versionFilter === '') ? null : versionFilter;
        
        let project;
        if (source === 'release-monitoring') {
            project = this.projects.find(
                p => {
                    const pFilter = (p.versionFilter === null || p.versionFilter === undefined || p.versionFilter === '') ? null : p.versionFilter;
                    return p.source === 'release-monitoring' && p.projectName === projectName && pFilter === normalizedFilter;
                }
            );
        } else {
            // For GitHub projects, also handle projects without source field (backward compatibility)
            project = this.projects.find(
                p => {
                    const isGitHub = (p.source === 'github' || !p.source || p.source === null);
                    const pFilter = (p.versionFilter === null || p.versionFilter === undefined || p.versionFilter === '') ? null : p.versionFilter;
                    return isGitHub && p.owner === owner && p.repo === repo && pFilter === normalizedFilter;
                }
            );
        }
        if (project) {
            // Ensure the release object has all necessary fields
            const releaseToSave = {
                tag_name: release.tag_name || release.version || release.name,
                version: release.version || release.tag_name || release.name,
                name: release.name || release.tag_name || release.version,
                published_at: release.published_at || null,
                html_url: release.html_url || null,
                body: release.body || null
            };
            project.lastRelease = releaseToSave;
            project.lastChecked = new Date().toISOString();
            // Set hasNewRelease flag: true if this is a new release, false otherwise
            project.hasNewRelease = isNewRelease;
            const identifier = source === 'release-monitoring' ? projectName : `${owner}/${repo}`;
            Logger.info(`updateProjectRelease: Saving release ${releaseToSave.tag_name} (version: ${releaseToSave.version}, name: ${releaseToSave.name}) for ${identifier} (filter: ${normalizedFilter}, hasNewRelease: ${isNewRelease})`);
            this.save();
            Logger.info("updateProjectRelease: Config saved, reloading...");
            this.load(); // Reload to ensure consistency
            // Verify after reload
            const verifyProject = this.projects.find(
                p => {
                    if (source === 'release-monitoring') {
                        const pFilter = (p.versionFilter === null || p.versionFilter === undefined || p.versionFilter === '') ? null : p.versionFilter;
                        return p.source === 'release-monitoring' && p.projectName === projectName && pFilter === normalizedFilter;
                    } else {
                        const isGitHub = (p.source === 'github' || !p.source || p.source === null);
                        const pFilter = (p.versionFilter === null || p.versionFilter === undefined || p.versionFilter === '') ? null : p.versionFilter;
                        return isGitHub && p.owner === owner && p.repo === repo && pFilter === normalizedFilter;
                    }
                }
            );
            if (verifyProject && verifyProject.lastRelease) {
                const savedVersion = verifyProject.lastRelease.tag_name || verifyProject.lastRelease.version;
                Logger.info(`updateProjectRelease: Verified saved version is ${savedVersion} for ${identifier} (filter: ${normalizedFilter})`);
            } else {
                Logger.error(`updateProjectRelease: WARNING - Could not verify saved release for ${identifier} (filter: ${normalizedFilter})`);
            }
        } else {
            const identifier = source === 'release-monitoring' ? projectName : `${owner}/${repo}`;
            Logger.error(`updateProjectRelease: Project ${identifier} not found in config (source: ${source}, filter: ${normalizedFilter})`);
        }
    }

    getProjects() {
        return this.projects;
    }
};

