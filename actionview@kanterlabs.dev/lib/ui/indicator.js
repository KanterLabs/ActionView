import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {LEVELS} from '../core/badge.js';
import {HeaderSection} from './sections/header.js';
import {BannerSection} from './sections/banner.js';
import {JobsSection} from './sections/jobs.js';
import {TrendsSection} from './sections/trends.js';
import {CapacitySection} from './sections/capacity.js';
import {RecentSection} from './sections/recent.js';
import {SourcesSection} from './sections/sources.js';

/**
 * Panel button + dropdown. A dumb renderer of Store: it never decides state,
 * it only draws store.view / store.badge and forwards clicks.
 */
export const Indicator = GObject.registerClass(
class ActionViewIndicator extends PanelMenu.Button {
    _init({store, settings, gicon, onRefresh, onOpenDashboard, onOpenPrefs}) {
        super._init(0.5, 'ActionView', false);
        this._store = store;
        this._settings = settings;
        this._tickId = 0;
        this.add_style_class_name('actionview-indicator');

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._gicon = gicon;
        // Unreachable must never look like idle: swap to a distinct icon.
        this._offlineIcon = new Gio.ThemedIcon({name: 'network-offline-symbolic'});
        this._icon = new St.Icon({gicon, style_class: 'system-status-icon actionview-icon'});
        this._label = new St.Label({style_class: 'actionview-panel-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this.menu.box.add_style_class_name('actionview-menu');
        this._sections = [
            new HeaderSection({onRefresh, onOpenDashboard, onOpenPrefs}),
            new BannerSection(),
            new JobsSection(),
            new TrendsSection(),
            new CapacitySection(),
            new RecentSection(),
            new SourcesSection(),
        ];
        this._sections.forEach((s, i) => {
            if (i > 1)
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.menu.addMenuItem(s.section);
        });

        this.menu.connectObject('open-state-changed', (_menu, open) => this._onOpenChanged(open), this);
        store.connectObject('changed', () => this._render(), this);
        settings.connectObject('changed::panel-show-label', () => this._render(),
            'changed::muted-repos', () => {
                store.recomputeBadge();
                this._render();
            }, this);
        this._render();
    }

    _onOpenChanged(open) {
        if (open) {
            this._store.acknowledge();
            this._render();
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            this._stopTick();
        }
    }

    _tick() {
        const now = Date.now();
        this._sections[0].update(this._store, now);
        this._sections[2].tick(now);
        this._sections[5].tick(now);
    }

    _stopTick() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _render() {
        const {badge} = this._store;
        for (const level of LEVELS)
            this.remove_style_class_name(`actionview-level-${level}`);
        this.add_style_class_name(`actionview-level-${badge.level}`);
        this._icon.gicon = badge.level === 'offline' ? this._offlineIcon : this._gicon;
        const showLabel = this._settings.get_boolean('panel-show-label') || badge.level === 'offline';
        this._label.text = badge.label;
        this._label.visible = showLabel && Boolean(badge.label);
        this.accessible_name = `ActionView: ${badge.summary}`;

        // Rendering a closed menu is wasted work; it re-renders on open.
        if (!this.menu.isOpen)
            return;
        const now = Date.now();
        for (const section of this._sections)
            section.update(this._store, now);
    }

    destroy() {
        this._stopTick();
        super.destroy();
    }
});
