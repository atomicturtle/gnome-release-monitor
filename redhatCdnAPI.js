imports.gi.versions.Soup = '3.0';
import Soup from 'gi://Soup';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Logger from './logger.js';

// ============================================================================
// RedhatCdnAPI - Latest RHEL kernel from CDN BaseOS or Security Data API
// ============================================================================
export const RedhatCdnAPI = class {
    constructor(certPath = null, keyPath = null, caPath = null) {
        this.session = new Soup.Session();
        this.certPath = certPath;
        this.keyPath = keyPath;
        this.caPath = caPath;
        this.securityDataBase = 'https://access.redhat.com/hydra/rest/securitydata';
        this._configureTls();
    }

    setCertificatePaths(certPath, keyPath, caPath) {
        this.certPath = certPath;
        this.keyPath = keyPath;
        this.caPath = caPath;
        this._configureTls();
    }

    _defaultCertsDir() {
        return GLib.build_filenamev([GLib.get_user_config_dir(), 'release-monitor', 'certs']);
    }

    _resolvePaths() {
        let certPath = (this.certPath || '').trim();
        let keyPath = (this.keyPath || '').trim();
        let caPath = (this.caPath || '').trim();
        const certsDir = this._defaultCertsDir();

        if (!caPath) {
            const defaultCa = GLib.build_filenamev([certsDir, 'redhat-uep.pem']);
            if (Gio.File.new_for_path(defaultCa).query_exists(null)) {
                caPath = defaultCa;
            }
        }

        if (!certPath || !keyPath) {
            try {
                const dir = Gio.File.new_for_path(certsDir);
                if (dir.query_exists(null)) {
                    const enumerator = dir.enumerate_children(
                        'standard::name',
                        Gio.FileQueryInfoFlags.NONE,
                        null
                    );
                    let info;
                    const keys = [];
                    while ((info = enumerator.next_file(null)) !== null) {
                        const name = info.get_name();
                        if (name.endsWith('-key.pem')) {
                            keys.push(name);
                        }
                    }
                    enumerator.close(null);
                    keys.sort();
                    if (keys.length > 0) {
                        const keyName = keys[keys.length - 1];
                        const certName = keyName.replace(/-key\.pem$/, '.pem');
                        const resolvedKey = GLib.build_filenamev([certsDir, keyName]);
                        const resolvedCert = GLib.build_filenamev([certsDir, certName]);
                        if (Gio.File.new_for_path(resolvedCert).query_exists(null)) {
                            if (!keyPath) {
                                keyPath = resolvedKey;
                            }
                            if (!certPath) {
                                certPath = resolvedCert;
                            }
                        }
                    }
                }
            } catch (e) {
                Logger.debug(`RedhatCdnAPI: auto-detect certs failed: ${e.message}`);
            }
        }

        return {certPath, keyPath, caPath};
    }

    _configureTls() {
        const {caPath} = this._resolvePaths();
        try {
            if (caPath && Gio.File.new_for_path(caPath).query_exists(null)) {
                const tlsDb = Gio.TlsFileDatabase.new(caPath);
                this.session.set_tls_database(tlsDb);
                Logger.debug(`RedhatCdnAPI: using CA database ${caPath}`);
            }
        } catch (e) {
            Logger.warn(`RedhatCdnAPI: could not set TLS CA database: ${e.message}`);
        }
    }

    _repoBase(major, arch = 'x86_64') {
        const m = String(major);
        return `https://cdn.redhat.com/content/dist/rhel${m}/${m}/${arch}/baseos/os/`;
    }

    _hasClientCerts() {
        const {certPath, keyPath} = this._resolvePaths();
        return Boolean(
            certPath &&
            keyPath &&
            Gio.File.new_for_path(certPath).query_exists(null) &&
            Gio.File.new_for_path(keyPath).query_exists(null)
        );
    }

    _applyClientCert(message) {
        const {certPath, keyPath} = this._resolvePaths();
        if (!certPath || !keyPath) {
            return;
        }
        const cert = Gio.TlsCertificate.new_from_files(certPath, keyPath);
        message.set_tls_client_certificate(cert);
    }

    _sendAndRead(url, useClientCert = false) {
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('User-Agent', 'GNOME-Release-Monitor');
        message.request_headers.append('Accept', '*/*');
        if (useClientCert) {
            this._applyClientCert(message);
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
                        const data = bytes ? bytes.get_data() : null;
                        resolve({status, data});
                    } catch (e) {
                        reject(new Error(`Request failed for ${url}: ${e.message}`));
                    }
                }
            );
        });
    }

    _gunzip(data) {
        const memIn = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(data));
        const converter = Gio.ZlibDecompressor.new(Gio.ZlibCompressorFormat.GZIP);
        const converterStream = Gio.ConverterInputStream.new(memIn, converter);
        // Prefer splice: Gio.InputStream.read(Uint8Array) is not introspectable on some GJS builds
        const memOut = Gio.MemoryOutputStream.new_resizable();
        memOut.splice(
            converterStream,
            Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
            null
        );
        const outBytes = memOut.steal_as_bytes();
        return outBytes.get_data();
    }

    _bytesToString(data) {
        return new TextDecoder('utf-8').decode(data);
    }

    _parseVerRelParts(value) {
        // rpmvercmp-style: skip non-alphanumeric separators, then alternate alpha/digit runs
        const parts = [];
        let i = 0;
        const s = value || '';
        while (i < s.length) {
            while (i < s.length && !/[A-Za-z0-9]/.test(s[i])) {
                i++;
            }
            if (i >= s.length) {
                break;
            }
            if (/\d/.test(s[i])) {
                let j = i;
                while (j < s.length && /\d/.test(s[j])) {
                    j++;
                }
                parts.push({num: true, v: parseInt(s.slice(i, j), 10)});
                i = j;
            } else {
                let j = i;
                while (j < s.length && /[A-Za-z]/.test(s[j])) {
                    j++;
                }
                parts.push({num: false, v: s.slice(i, j)});
                i = j;
            }
        }
        return parts;
    }

    _compareSegment(a, b) {
        const ap = this._parseVerRelParts(a || '');
        const bp = this._parseVerRelParts(b || '');
        const len = Math.max(ap.length, bp.length);
        for (let i = 0; i < len; i++) {
            const x = ap[i] || {num: true, v: 0};
            const y = bp[i] || {num: true, v: 0};
            if (x.num !== y.num) {
                // Numeric segments beat non-numeric (rpmvercmp-ish)
                return x.num ? 1 : -1;
            }
            if (x.num) {
                if (x.v !== y.v) {
                    return x.v < y.v ? -1 : 1;
                }
            } else if (x.v !== y.v) {
                return x.v < y.v ? -1 : 1;
            }
        }
        return 0;
    }

    compareEvr(a, b) {
        if (a.epoch !== b.epoch) {
            return a.epoch < b.epoch ? -1 : 1;
        }
        const verCmp = this._compareSegment(a.version, b.version);
        if (verCmp !== 0) {
            return verCmp;
        }
        return this._compareSegment(a.release, b.release);
    }

    _parsePackageXmlChunk(chunk) {
        const nameMatch = chunk.match(/<name>([^<]+)<\/name>/);
        if (!nameMatch || nameMatch[1] !== 'kernel') {
            return null;
        }
        const archMatch = chunk.match(/<arch>([^<]+)<\/arch>/);
        const epochMatch = chunk.match(/<version[^>]*epoch="([^"]*)"/);
        const verMatch = chunk.match(/<version[^>]*ver="([^"]*)"/);
        const relMatch = chunk.match(/<version[^>]*rel="([^"]*)"/);
        const timeMatch = chunk.match(/<time[^>]*file="(\d+)"/);
        const locMatch = chunk.match(/<location[^>]*href="([^"]*)"/);
        if (!verMatch || !relMatch) {
            return null;
        }
        return {
            name: 'kernel',
            arch: archMatch ? archMatch[1] : 'x86_64',
            epoch: parseInt(epochMatch ? epochMatch[1] : '0', 10) || 0,
            version: verMatch[1],
            release: relMatch[1],
            fileTime: timeMatch ? parseInt(timeMatch[1], 10) : 0,
            location: locMatch ? locMatch[1] : null,
        };
    }

    _newestKernelFromPrimaryXml(xmlText) {
        const packages = [];
        const re = /<package\b[\s\S]*?<\/package>/g;
        let match;
        while ((match = re.exec(xmlText)) !== null) {
            const pkg = this._parsePackageXmlChunk(match[0]);
            if (pkg && pkg.arch !== 'src') {
                packages.push(pkg);
            }
        }
        if (packages.length === 0) {
            return null;
        }
        packages.sort((a, b) => this.compareEvr(b, a));
        return packages[0];
    }

    _parseRepomdPrimaryHref(repomdXml) {
        // Prefer primary metadata (not primary_db)
        const re = /<data\s+type="primary">[\s\S]*?<location[^>]*href="([^"]+)"[\s\S]*?<\/data>/;
        const match = repomdXml.match(re);
        return match ? match[1] : null;
    }

    async _getLatestFromCdn(major, arch = 'x86_64') {
        if (!this._hasClientCerts()) {
            throw new Error('No RHEL CDN entitlement certificate configured');
        }

        const base = this._repoBase(major, arch);
        const repomdUrl = `${base}repodata/repomd.xml`;
        Logger.info(`RedhatCdnAPI: fetching ${repomdUrl}`);
        const repomdRes = await this._sendAndRead(repomdUrl, true);
        if (repomdRes.status !== 200 || !repomdRes.data) {
            throw new Error(`CDN repomd.xml HTTP ${repomdRes.status}`);
        }

        const repomdXml = this._bytesToString(repomdRes.data);
        const primaryHref = this._parseRepomdPrimaryHref(repomdXml);
        if (!primaryHref) {
            throw new Error('Could not find primary metadata in repomd.xml');
        }

        const primaryUrl = primaryHref.startsWith('http')
            ? primaryHref
            : `${base}${primaryHref}`;
        Logger.info(`RedhatCdnAPI: fetching primary ${primaryUrl}`);
        const primaryRes = await this._sendAndRead(primaryUrl, true);
        if (primaryRes.status !== 200 || !primaryRes.data) {
            throw new Error(`CDN primary metadata HTTP ${primaryRes.status}`);
        }

        let xmlBytes = primaryRes.data;
        if (primaryHref.endsWith('.gz')) {
            xmlBytes = this._gunzip(primaryRes.data);
        }
        const xmlText = this._bytesToString(xmlBytes);
        const newest = this._newestKernelFromPrimaryXml(xmlText);
        if (!newest) {
            throw new Error('No kernel package found in CDN primary metadata');
        }

        const tagName = `${newest.version}-${newest.release}`;
        const publishedAt = newest.fileTime
            ? new Date(newest.fileTime * 1000).toISOString()
            : new Date().toISOString();
        const htmlUrl = newest.location
            ? (newest.location.startsWith('http') ? newest.location : `${base}${newest.location}`)
            : `https://access.redhat.com/downloads/content/package-latest?name=kernel`;

        return {
            tag_name: tagName,
            version: tagName,
            name: `RHEL ${major} kernel ${tagName}`,
            published_at: publishedAt,
            html_url: htmlUrl,
            body: `Latest kernel from RHEL ${major} BaseOS CDN (${arch}).`,
            source_method: 'cdn',
        };
    }

    _majorMatchesPackage(pkg, major) {
        const m = String(major);
        // Match .el8 / .el8_ / .el9 / .el9_4 / .el10 / .el10_
        const re = new RegExp(`\\.el${m}(?:_|\\.|$)`);
        return re.test(pkg);
    }

    _extractKernelNvra(pkg) {
        // Examples:
        // kernel-0:5.14.0-427.138.1.el9_4.x86_64
        // kernel-5.14.0-427.138.1.el9_4.x86_64
        const match = pkg.match(
            /^kernel-(?:(\d+):)?([^-]+)-(.+)\.(x86_64|aarch64|ppc64le|s390x)$/
        );
        if (!match) {
            return null;
        }
        return {
            epoch: parseInt(match[1] || '0', 10) || 0,
            version: match[2],
            release: match[3],
        };
    }

    _isMainKernelPackage(pkg) {
        // Main binary kernel only (not kernel-core, kernel-modules, kernel-rt, etc.)
        return /^kernel-(?:\d+:)?\d/.test(pkg) &&
            !/^kernel-(?:core|modules|devel|headers|tools|doc|debug|rt|abi|uki|64k|zfcpdump|bootwrapper|kdump)/.test(pkg);
    }

    async _getLatestFromSecurityData(major) {
        const url = `${this.securityDataBase}/csaf.json?package=kernel&created_days_ago=60&per_page=100`;
        Logger.info(`RedhatCdnAPI: Security Data fallback ${url}`);
        const res = await this._sendAndRead(url, false);
        if (res.status !== 200 || !res.data) {
            throw new Error(`Security Data API HTTP ${res.status}`);
        }

        let advisories;
        try {
            advisories = JSON.parse(this._bytesToString(res.data));
        } catch (e) {
            throw new Error(`Failed to parse Security Data response: ${e.message}`);
        }
        if (!Array.isArray(advisories) || advisories.length === 0) {
            return null;
        }

        let best = null;
        let bestMeta = null;
        for (const advisory of advisories) {
            const packages = advisory.released_packages || [];
            for (const pkg of packages) {
                if (!this._isMainKernelPackage(pkg)) {
                    continue;
                }
                if (!this._majorMatchesPackage(pkg, major)) {
                    continue;
                }
                const evr = this._extractKernelNvra(pkg);
                if (!evr) {
                    continue;
                }
                if (!best || this.compareEvr(evr, best) > 0) {
                    best = evr;
                    bestMeta = advisory;
                }
            }
        }

        if (!best || !bestMeta) {
            return null;
        }

        const tagName = `${best.version}-${best.release}`;
        const rhsa = bestMeta.RHSA || '';
        return {
            tag_name: tagName,
            version: tagName,
            name: `RHEL ${major} kernel ${tagName}`,
            published_at: bestMeta.released_on || new Date().toISOString(),
            html_url: rhsa
                ? `https://access.redhat.com/errata/${rhsa}`
                : 'https://access.redhat.com/security/security-updates/',
            body: `${rhsa} (${bestMeta.severity || 'unknown'}): kernel ${tagName} via Red Hat Security Data API.`,
            source_method: 'security-data',
        };
    }

    async getLatestKernel(major, arch = 'x86_64') {
        const majorStr = String(major);
        if (!['8', '9', '10'].includes(majorStr)) {
            throw new Error(`Unsupported RHEL major version: ${major}`);
        }

        // CDN only — no Security Data fallback. RHSA-only misses RHBA kernels and is
        // the wrong signal for rebuilding Rocky from shipping RHEL NEVRAs.
        return await this._getLatestFromCdn(majorStr, arch || 'x86_64');
    }
};
