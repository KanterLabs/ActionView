// Quick Settings toggle: "Forge notifications" on, or snoozed until a time.
// The badge keeps working while snoozed; only notifications are held back.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {SNOOZE_OPTIONS, snoozeEnd, isSnoozed, snoozeLabel} from '../core/snooze.js';

const SnoozeToggle = GObject.registerClass(
class ActionViewSnoozeToggle extends QuickMenuToggle {
    _init({settings, gicon}) {
        // Quick Settings tiles are narrow: short title/subtitle, full wording in the menu header.
        super._init({title: 'Forge', gicon, toggleMode: false,
            accessible_name: 'Forge notifications'});
        this._settings = settings;
        this._expiryId = 0;
        this.menu.setHeader(gicon, 'Forge notifications');

        for (const {id, label} of SNOOZE_OPTIONS)
            this.menu.addAction(label, () => this._snooze(id));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._resume = this.menu.addAction('Resume notifications', () => this._setUntil(0));

        // Click: on → snooze for an hour; snoozed → resume.
        this.connect('clicked', () => {
            if (this._snoozed)
                this._setUntil(0);
            else
                this._snooze('1h');
        });
        settings.connectObject('changed::snooze-until', () => this._sync(), this);
        this._sync();
    }

    get _snoozed() {
        return isSnoozed(this._settings.get_int64('snooze-until'), Date.now());
    }

    _snooze(option) {
        this._setUntil(snoozeEnd(option, Date.now()));
    }

    _setUntil(seconds) {
        this._settings.set_int64('snooze-until', seconds);
    }

    _sync() {
        this._clearExpiry();
        const until = this._settings.get_int64('snooze-until');
        const now = Date.now();
        const snoozed = isSnoozed(until, now);
        this.checked = !snoozed;
        const label = snoozeLabel(until, now);
        this.subtitle = snoozed ? `Until ${label}` : 'On';
        this.menu.setHeader(this.gicon, 'Forge notifications',
            snoozed ? `Snoozed until ${label}` : 'On');
        this._resume.visible = snoozed;
        if (snoozed) {
            // Flip back to "On" when the snooze runs out.
            const seconds = Math.max(1, Math.ceil(until - now / 1000));
            this._expiryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                this._expiryId = 0;
                this._sync();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _clearExpiry() {
        if (this._expiryId) {
            GLib.source_remove(this._expiryId);
            this._expiryId = 0;
        }
    }

    destroy() {
        this._clearExpiry();
        this._settings.disconnectObject(this);
        super.destroy();
    }
});

/** Holder that Quick Settings expects; it shows no panel icon of its own. */
export const SnoozeIndicator = GObject.registerClass(
class ActionViewSnoozeIndicator extends SystemIndicator {
    _init({settings, gicon}) {
        super._init();
        this.quickSettingsItems.push(new SnoozeToggle({settings, gicon}));
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems = [];
        super.destroy();
    }
});
