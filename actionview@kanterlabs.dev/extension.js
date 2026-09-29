// ActionView — KanterLabs Forge in the GNOME top bar.
//
// Data flow: Poller → ForgeClient → Store (normalize → diff → badge)
//   → 'changed' → Indicator (render)   → 'events' → Notifier

import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ForgeClient} from './lib/client.js';
import {Poller} from './lib/poller.js';
import {Store} from './lib/store.js';
import {Notifier} from './lib/notifier.js';
import {Indicator} from './lib/ui/indicator.js';
import {openUri, dashboardUrl} from './lib/util.js';

export default class ActionViewExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._gicon = Gio.icon_new_for_string(`${this.path}/icons/actionview-symbolic.svg`);
        this._client = new ForgeClient({userAgent: `ActionView/${this.metadata.version ?? 'dev'}`});
        this._store = new Store(this._settings);
        this._notifier = new Notifier(this._settings, this._gicon);
        this._store.connectObject('events', (_store, events) => this._notifier.handle(events), this);

        this._poller = new Poller({
            tick: cancellable => this._poll(cancellable),
            intervals: () => ({
                active: this._settings.get_int('poll-active-seconds'),
                idle: this._settings.get_int('poll-idle-seconds'),
            }),
            isActive: () => Boolean(this._indicator?.menu.isOpen) || this._store.hasActivity,
            failures: () => this._store.conn.failures,
        });

        this._addIndicator();

        this._settings.connectObject(
            'changed::base-url', () => this._poller.pokeNow(),
            'changed::poll-active-seconds', () => this._poller.reschedule(),
            'changed::poll-idle-seconds', () => this._poller.reschedule(),
            'changed::panel-box', () => this._addIndicator(),
            this);

        this._poller.start();
    }

    disable() {
        this._settings.disconnectObject(this);
        // Stop polling before destroying the indicator: destroying it closes an
        // open menu, whose handler asks the (stopped, still present) poller to reschedule.
        this._poller.stop();
        this._indicator?.destroy();
        this._indicator = null;
        this._poller = null;
        this._store.persist();
        this._store.disconnectObject(this);
        this._notifier.destroy();
        this._notifier = null;
        this._client.destroy();
        this._client = null;
        this._store = null;
        this._gicon = null;
        this._settings = null;
    }

    async _poll(cancellable) {
        const baseUrl = this._settings.get_string('base-url');
        let result;
        try {
            result = await this._client.getJson(baseUrl, '/api/operations', cancellable);
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw error;
            this._store?.applyFailure(error);
            return;
        }
        this._store?.applySuccess(result);
    }

    _addIndicator() {
        this._indicator?.destroy();
        this._indicator = new Indicator({
            store: this._store,
            settings: this._settings,
            gicon: this._gicon,
            onRefresh: () => this._poller.pokeNow(),
            onOpenDashboard: () => {
                this._indicator.menu.close();
                openUri(dashboardUrl(this._settings));
            },
            onOpenPrefs: () => {
                this._indicator.menu.close();
                this.openPreferences();
            },
        });
        // The panel can destroy the indicator before disable() runs (e.g. at shell shutdown).
        const indicator = this._indicator;
        indicator.connect('destroy', () => {
            if (this._indicator === indicator)
                this._indicator = null;
        });
        this._indicator.menu.connectObject('open-state-changed', (_menu, open) => {
            if (open)
                this._poller?.pokeNow();
            else
                this._poller?.reschedule();
        }, this._indicator);
        const box = this._settings.get_string('panel-box');
        Main.panel.addToStatusArea(this.uuid, this._indicator, box === 'right' ? 0 : -1, box);
    }
}
