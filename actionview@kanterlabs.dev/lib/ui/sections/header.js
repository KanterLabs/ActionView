import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ago} from '../../core/format.js';
import {isSnoozed, snoozeLabel} from '../../core/snooze.js';

function iconButton(iconName, accessibleName, callback) {
    const button = new St.Button({
        style_class: 'actionview-icon-button',
        can_focus: true,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName, icon_size: 16}),
    });
    button.connect('clicked', callback);
    return button;
}

/** Status dot · "KanterLabs Forge" · updated-ago · [refresh] [dashboard] [settings] */
export class HeaderSection {
    constructor({onRefresh, onOpenDashboard, onOpenPrefs}) {
        this.section = new PopupMenu.PopupMenuSection();
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false,
            style_class: 'actionview-header'});

        this._dot = new St.Widget({style_class: 'actionview-dot', y_align: Clutter.ActorAlign.CENTER});
        const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const title = new St.Label({text: 'KanterLabs Forge', style_class: 'actionview-header-title'});
        this._status = new St.Label({style_class: 'actionview-header-status'});
        column.add_child(title);
        column.add_child(this._status);

        item.add_child(this._dot);
        item.add_child(column);
        item.add_child(iconButton('view-refresh-symbolic', 'Refresh now', onRefresh));
        item.add_child(iconButton('web-browser-symbolic', 'Open Forge dashboard', onOpenDashboard));
        item.add_child(iconButton('emblem-system-symbolic', 'ActionView settings', onOpenPrefs));
        this.section.addMenuItem(item);
    }

    update(store, now) {
        const {badge, view, conn} = store;
        this._dot.style_class = `actionview-dot actionview-level-${badge.level}`;
        const parts = [];
        if (conn.down || conn.localOffline || !view)
            parts.push(badge.summary);
        else
            parts.push(`Updated ${ago(conn.lastGoodAt, now)}`);
        if (view?.host.hostname)
            parts.push(view.host.hostname);
        if (!conn.down && conn.failures)
            parts.push(`retrying (${conn.lastError})`);
        if (isSnoozed(store.snoozeUntil, now))
            parts.push(`notifications snoozed until ${snoozeLabel(store.snoozeUntil, now)}`);
        this._status.text = parts.join(' · ');
    }
}
