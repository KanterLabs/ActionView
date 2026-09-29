// HTTP client for Forge. Shared by the Shell process and the prefs process, so
// it imports only GLib/Gio/Soup (no Shell modules).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const decoder = new TextDecoder();

export class ForgeClient {
    constructor({timeoutSeconds = 10, userAgent = 'ActionView'} = {}) {
        this._session = new Soup.Session({timeout: timeoutSeconds, user_agent: userAgent});
        this._etags = new Map();
        // Debug/test hook: serve a local JSON file instead of hitting the network.
        this._fixture = GLib.getenv('ACTIONVIEW_FIXTURE');
    }

    /**
     * GET `${baseUrl}${path}` and parse JSON.
     * Sends If-None-Match when the server previously returned an ETag.
     *
     * @returns {Promise<{notModified: boolean, json: unknown}>}
     * @throws {Error} with a short human-readable message; Gio CANCELLED is rethrown as-is.
     */
    async getJson(baseUrl, path, cancellable = null) {
        if (this._fixture && path === '/api/operations')
            return {notModified: false, json: this._readFixture(this._fixture)};

        if (!String(baseUrl).trim())
            throw new Error('Forge URL not set: open ActionView settings');
        const url = joinUrl(baseUrl, path);
        let message;
        try {
            message = Soup.Message.new('GET', url);
        } catch {
            message = null;
        }
        if (!message)
            throw new Error(`invalid URL: ${url}`);
        message.request_headers.append('Accept', 'application/json');
        const etag = this._etags.get(url);
        if (etag)
            message.request_headers.append('If-None-Match', etag);

        let bytes;
        try {
            bytes = await this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw error;
            throw new Error(shortError(error));
        }

        const status = message.get_status();
        if (status === Soup.Status.NOT_MODIFIED)
            return {notModified: true, json: null};
        if (status < 200 || status >= 300)
            throw new Error(`HTTP ${status} ${message.get_reason_phrase() ?? ''}`.trim());

        const newEtag = message.response_headers.get_one('ETag');
        if (newEtag)
            this._etags.set(url, newEtag);
        else
            this._etags.delete(url);

        try {
            return {notModified: false, json: JSON.parse(decoder.decode(bytes.toArray()))};
        } catch {
            throw new Error('response was not JSON');
        }
    }

    _readFixture(path) {
        // A missing fixture simulates Forge being down (the smoke test's "offline" step).
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            throw new Error('connection refused');
        try {
            const [, contents] = GLib.file_get_contents(path);
            return JSON.parse(decoder.decode(contents));
        } catch (error) {
            throw new Error(`fixture ${path}: ${error.message}`);
        }
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }
}

export function joinUrl(baseUrl, path) {
    return `${String(baseUrl).trim().replace(/\/+$/, '')}${path}`;
}

function shortError(error) {
    const text = String(error?.message ?? error);
    if (/timed? ?out/i.test(text))
        // Most common cause: the Forge host's network isn't routed to this machine
        // (e.g. a Tailscale subnet route not accepted) or its firewall drops us.
        return 'timed out (Forge not routed/allowed from here?)';
    if (/refused/i.test(text))
        return 'connection refused';
    if (/resolve|name or service/i.test(text))
        return 'host not found';
    return text.split('\n')[0].slice(0, 120);
}
