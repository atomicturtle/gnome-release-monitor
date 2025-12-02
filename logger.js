import GLib from "gi://GLib";

// Simple log levels
export const LogLevel = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

// Default to WARN in normal use (only warnings/errors)
let currentLevel = LogLevel.WARN;

export function setLogLevel(level) {
    currentLevel = level;
}

function _timestamp() {
    try {
        const now = GLib.DateTime.new_now_local();
        return now.format('%Y-%m-%d %H:%M:%S');
    } catch (e) {
        return '';
    }
}

function _format(levelLabel, message) {
    const ts = _timestamp();
    const prefix = ts ? `[${ts}]` : '';
    return `${prefix}[ReleaseMonitor][${levelLabel}] ${message}`;
}

export function debug(message) {
    if (currentLevel <= LogLevel.DEBUG) {
        log(_format('DEBUG', String(message)));
    }
}

export function info(message) {
    if (currentLevel <= LogLevel.INFO) {
        log(_format('INFO', String(message)));
    }
}

export function warn(message) {
    if (currentLevel <= LogLevel.WARN) {
        log(_format('WARN', String(message)));
    }
}

export function error(message, e = null) {
    const fullMessage = e && e.stack
        ? `${String(message)}: ${e.message}\n${e.stack}`
        : String(message);
    logError(new Error(_format('ERROR', fullMessage)));
}


