import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ForgeClient} from './lib/client.js';
import {SUPPORTED_SCHEMA} from './lib/core/normalize.js';

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

function entryRow(settings, key, title) {
    const row = new Adw.EntryRow({title, show_apply_button: true, text: settings.get_string(key)});
    row.connect('apply', () => settings.set_string(key, row.text.trim()));
    return row;
}

export default class ActionViewPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const client = new ForgeClient({timeoutSeconds: 5});
        window.connect('close-request', () => {
            client.destroy();
            return false;
        });
        window.add(this._generalPage(settings, client));
        window.add(this._notificationsPage(settings));
    }

    _generalPage(settings, client) {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'network-server-symbolic'});

        const connection = new Adw.PreferencesGroup({
            title: 'Forge',
            description: 'Forge must accept connections from this machine. Over Tailscale with a ' +
                'subnet route, run "sudo tailscale set --accept-routes" once.',
        });
        connection.add(entryRow(settings, 'base-url', 'Base URL'));
        connection.add(entryRow(settings, 'dashboard-url', 'Dashboard URL (optional)'));

        const test = new Adw.ActionRow({title: 'Test connection', subtitle: 'Not tested'});
        const button = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER});
        button.connect('clicked', async () => {
            button.sensitive = false;
            test.subtitle = 'Testing…';
            test.subtitle = await testConnection(client, settings.get_string('base-url'));
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
        events.add(switchRow(settings, 'notify-start', 'A job starts on a homelab runner'));
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

async function testConnection(client, baseUrl) {
    try {
        const {json} = await client.getJson(baseUrl, '/api/operations');
        const version = json?.schema_version;
        const served = json?.served_at ? GLib.DateTime.new_from_iso8601(json.served_at, null)?.to_local()
            .format('%H:%M:%S') : '?';
        const note = version === SUPPORTED_SCHEMA ? '' : ` (ActionView expects v${SUPPORTED_SCHEMA})`;
        return `OK · schema v${version ?? '?'}${note} · served ${served}`;
    } catch (error) {
        return `Failed: ${error.message}`;
    }
}
