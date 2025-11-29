const Soup = imports.gi.Soup;
const GLib = imports.gi.GLib;

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
            this.session.queue_message(message, (session, msg) => {
                if (msg.status_code === 200) {
                    try {
                        const decoder = new TextDecoder('utf-8');
                        const response = decoder.decode(msg.response_body.data);
                        const release = JSON.parse(response);
                        resolve({
                            tag_name: release.tag_name,
                            name: release.name || release.tag_name,
                            published_at: release.published_at,
                            html_url: release.html_url,
                            body: release.body
                        });
                    } catch (e) {
                        reject(new Error(`Failed to parse response: ${e}`));
                    }
                } else if (msg.status_code === 404) {
                    resolve(null); // No releases found
                } else {
                    reject(new Error(`GitHub API error: ${msg.status_code}`));
                }
            });
        });
    }

    async checkRepository(owner, repo) {
        const url = `${this.baseUrl}/repos/${owner}/${repo}`;
        const message = Soup.Message.new('GET', url);
        
        message.request_headers.append('Accept', 'application/vnd.github.v3+json');
        message.request_headers.append('User-Agent', 'GNOME-Release-Monitor');

        return new Promise((resolve, reject) => {
            this.session.queue_message(message, (session, msg) => {
                if (msg.status_code === 200) {
                    resolve(true);
                } else if (msg.status_code === 404) {
                    resolve(false);
                } else {
                    reject(new Error(`GitHub API error: ${msg.status_code}`));
                }
            });
        });
    }
};

var GitHubAPI = GitHubAPI;

