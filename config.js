const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

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
            log(`Error loading config: ${e}`);
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
            this.save();
        }
    }

    getProjects() {
        return this.projects;
    }
};

var ConfigManager = ConfigManager;

