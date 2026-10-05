import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ForgeClient} from './lib/client.js';
import {SUPPORTED_SCHEMA} from './lib/core/normalize.js';
import {normalizeBaseUrl} from './lib/core/url.js';

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, lower, upper, subtitle = '') {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** URL entry: normalizes on apply; an invalid URL is not saved and shows a toast. */
function urlRow(settings, key, title, window) {
    const row = new Adw.EntryRow({title, show_apply_button: true, text: settings.get_string(key)});
    row.connect('apply', () => applyUrl(settings, key, row, window));
    return row;
}

/** @returns {string|null} the saved URL, or null when the text is invalid */
function applyUrl(settings, key, row, window) {
    const {url, error} = normalizeBaseUrl(row.text);
    if (error) {
        row.add_css_class('error');
        window.add_toast(new Adw.Toast({title: error}));
        return null;
    }
    row.remove_css_class('error');
    if (row.text !== url)
        row.text = url;
    if (settings.get_string(key) !== url)
        settings.set_string(key, url);
    return url;
}

export default class ActionViewPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const client = new ForgeClient({timeoutSeconds: 5});
        const pending = {cancellable: null};
        window.connect('close-request', () => {
            pending.cancellable?.cancel();
            client.destroy();
            return false;
        });
        window.add(this._generalPage(settings, client, pending, window));
        window.add(this._notificationsPage(settings));
    }

    _generalPage(settings, client, pending, window) {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'network-server-symbolic'});

        const connection = new Adw.PreferencesGroup({
            title: 'Forge',
            description: 'Forge must accept connections from this machine. Over Tailscale with a ' +
                'subnet route, run "sudo tailscale set --accept-routes" once.',
        });
        const baseRow = urlRow(settings, 'base-url', 'Base URL', window);
        connection.add(baseRow);
        connection.add(urlRow(settings, 'dashboard-url', 'Dashboard URL (optional)', window));

        const test = new Adw.ActionRow({title: 'Test connection', subtitle: 'Not tested'});
        const button = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER});
        button.connect('clicked', async () => {
            // Test what is in the box, not a previously saved value: apply it first.
            const url = applyUrl(settings, 'base-url', baseRow, window);
            if (url === null) {
                test.subtitle = 'Failed: invalid URL';
                return;
            }
            const cancellable = new Gio.Cancellable();
            pending.cancellable = cancellable;
            button.sensitive = false;
            test.subtitle = 'Testing…';
            const result = await testConnection(client, url, cancellable);
            if (cancellable.is_cancelled())
                return; // window closed mid-test: its widgets are gone
            pending.cancellable = null;
            test.subtitle = result;
            button.sensitive = true;
        });
        test.add_suffix(button);
        connection.add(test);
        page.add(connection);

        const polling = new Adw.PreferencesGroup({title: 'Polling'});
        polling.add(spinRow(settings, 'poll-active-seconds', 'Active interval (s)', 2, 60,
            'While jobs run/queue or the menu is open'));
        polling.add(spinRow(settings, 'poll-idle-seconds', 'Idle interval (s)', 10, 600));
        page.add(polling);

        const panel = new Adw.PreferencesGroup({title: 'Panel'});
        panel.add(switchRow(settings, 'panel-show-label', 'Show counts next to the icon'));
        const boxes = ['left', 'center', 'right'];
        const position = new Adw.ComboRow({
            title: 'Position',
            model: Gtk.StringList.new(['Left', 'Center', 'Right']),
            selected: Math.max(0, boxes.indexOf(settings.get_string('panel-box'))),
        });
        position.connect('notify::selected', () => settings.set_string('panel-box', boxes[position.selected]));
        panel.add(position);
        page.add(panel);
        return page;
    }

    _notificationsPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Notifications', icon_name: 'preferences-system-notifications-symbolic'});

        const events = new Adw.PreferencesGroup({title: 'Notify when'});
        events.add(switchRow(settings, 'notify-failure', 'A run fails', 'Includes timeouts and startup failures'));
        events.add(switchRow(settings, 'notify-success', 'A run succeeds'));
        events.add(switchRow(settings, 'notify-start', 'A job starts'));
        events.add(switchRow(settings, 'notify-queued', 'A job waits too long for a runner'));
        events.add(spinRow(settings, 'queued-alert-minutes', 'Queue threshold (minutes)', 1, 120));
        events.add(switchRow(settings, 'notify-alerts', 'Forge raises an alert', 'Also stale data sources'));
        page.add(events);

        const muted = new Adw.PreferencesGroup({
            title: 'Muted repositories',
            description: 'No notifications and not counted in the panel. Still listed (dimmed) in the menu.',
        });
        const add = new Adw.EntryRow({title: 'Add repository (e.g. web-app)', show_apply_button: true});
        add.connect('apply', () => {
            const repo = add.text.trim().replace(/^.*\//, '');
            const list = settings.get_strv('muted-repos');
            if (repo && !list.includes(repo))
                settings.set_strv('muted-repos', [...list, repo]);
            add.text = '';
        });
        muted.add(add);

        let rows = [];
        const refresh = () => {
            rows.forEach(r => muted.remove(r));
            rows = settings.get_strv('muted-repos').map(repo => {
                const row = new Adw.ActionRow({title: repo});
                const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
                    css_classes: ['flat'], tooltip_text: `Unmute ${repo}`});
                remove.connect('clicked', () =>
                    settings.set_strv('muted-repos', settings.get_strv('muted-repos').filter(r => r !== repo)));
                row.add_suffix(remove);
                muted.add(row);
                return row;
            });
        };
        const id = settings.connect('changed::muted-repos', refresh);
        page.connect('destroy', () => settings.disconnect(id));
        refresh();
        page.add(muted);
        return page;
    }
}

async function testConnection(client, baseUrl, cancellable) {
    try {
        const {json} = await client.getJson(baseUrl, '/api/operations', cancellable);
        const version = json?.schema_version;
        const served = json?.served_at ? GLib.DateTime.new_from_iso8601(json.served_at, null)?.to_local()
            .format('%H:%M:%S') : '?';
        const note = version === SUPPORTED_SCHEMA ? '' : ` (ActionView expects v${SUPPORTED_SCHEMA})`;
        return `OK · schema v${version ?? '?'}${note} · served ${served}`;
    } catch (error) {
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return null;
        return `Failed: ${error.message}`;
    }
}
