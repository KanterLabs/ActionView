// Turns store events into GNOME notifications (filtering/coalescing is in core/notifications.js).

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {planNotifications, rateLimit} from './core/notifications.js';
import {isSnoozed} from './core/snooze.js';
import {openUri} from './util.js';

const URGENCY = {
    low: MessageTray.Urgency.LOW,
    normal: MessageTray.Urgency.NORMAL,
    high: MessageTray.Urgency.HIGH,
};

export class Notifier {
    constructor(settings, gicon) {
        this._settings = settings;
        this._gicon = gicon;
        this._source = null;
        this._sentAt = [];
    }

    handle(events) {
        const s = this._settings;
        // Snoozed: nothing is lost (badge, unseen failures and the menu keep updating), just quiet.
        if (isSnoozed(s.get_int64('snooze-until'), Date.now()))
            return;
        const planned = planNotifications(events, {
            notifyFailure: s.get_boolean('notify-failure'),
            notifySuccess: s.get_boolean('notify-success'),
            notifyStart: s.get_boolean('notify-start'),
            notifyQueued: s.get_boolean('notify-queued'),
            notifyAlerts: s.get_boolean('notify-alerts'),
            mutedRepos: s.get_strv('muted-repos'),
        });
        if (!planned.length)
            return;
        const {send, suppressed, sentAt} = rateLimit(planned, this._sentAt, Date.now());
        this._sentAt = sentAt;
        for (const n of send)
            this._show(n);
        if (suppressed) {
            this._show({title: `${suppressed} more Forge event${suppressed === 1 ? '' : 's'}`,
                body: 'Open the ActionView menu for details.', urgency: 'low', url: '', repo: ''});
        }
    }

    _getSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'ActionView', icon: this._gicon});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    _show(n) {
        const source = this._getSource();
        const notification = new MessageTray.Notification({
            source,
            title: n.title,
            body: n.body,
            gicon: this._gicon,
            urgency: URGENCY[n.urgency] ?? MessageTray.Urgency.NORMAL,
        });
        if (n.url) {
            notification.connect('activated', () => openUri(n.url));
            notification.addAction('Open log', () => openUri(n.url));
        }
        if (n.repo) {
            notification.addAction(`Mute ${n.repo}`, () => {
                const muted = this._settings.get_strv('muted-repos');
                if (!muted.includes(n.repo))
                    this._settings.set_strv('muted-repos', [...muted, n.repo]);
            });
        }
        source.addNotification(notification);
    }

    destroy() {
        this._source?.destroy();
        this._source = null;
    }
}
