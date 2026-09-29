// Test-only driver, loaded next to ActionView inside a throwaway headless
// gnome-shell by tools/smoke.sh. Never installed on a real desktop.
//
// Env:
//   ACTIONVIEW_FIXTURE       live fixture path ActionView's client reads each poll
//   ACTIONVIEW_SMOKE_DIR     directory holding scenario fixtures
//   ACTIONVIEW_SMOKE_STEPS   comma list of scenario "steps"; "a>b" loads a then b (diff transitions)
//   ACTIONVIEW_SMOKE_OUT     output dir for screenshots + report.json

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');

const TARGET = 'actionview@kanterlabs.dev';
const CYCLES = 20;

// The shell may disable/re-enable extensions during startup; run the script once.
let started = false;

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

export default class SmokeDriver extends Extension {
    enable() {
        if (started)
            return;
        started = true;
        this._run().catch(error => this._finish({fatal: `${error}\n${error.stack}`}));
    }

    disable() {}

    async _run() {
        const env = name => GLib.getenv(name) ?? '';
        const live = env('ACTIONVIEW_FIXTURE');
        const dir = env('ACTIONVIEW_SMOKE_DIR');
        const out = env('ACTIONVIEW_SMOKE_OUT');
        const steps = env('ACTIONVIEW_SMOKE_STEPS').split(',').filter(Boolean);
        this._out = out;
        const report = {scenarios: [], cycles: null};

        await sleep(1500);
        Main.overview.hide();
        await this._waitFor(() => this._target()?._store?.view, 15000, 'first poll');

        for (const step of steps) {
            const names = step.split('>');
            for (const name of names) {
                if (name === 'offline') {
                    // Forge unreachable: the client's fixture read fails. Three
                    // failures flip the connection to "down".
                    Gio.File.new_for_path(live).delete(null);
                    for (let i = 0; i < 3; i++)
                        await this._poll();
                } else {
                    copy(`${dir}/${name}.json`, live);
                    await this._poll();
                }
            }
            const ext = this._target();
            const indicator = ext._indicator;
            // Read the badge before opening: opening the menu acknowledges failures.
            const badge = ext._store.badge;
            const panelLabel = indicator._label.visible ? indicator._label.text : '';
            const unackedFailures = ext._store.state.unackedFailures.length;
            const base = `${out}/${step.replaceAll('>', '-to-')}`;
            await sleep(600);
            await screenshot(`${base}-panel.png`); // badge + any notification banner, menu closed
            indicator.menu.open(false);
            await sleep(1200);
            const png = `${base}.png`;
            await screenshot(png);
            report.scenarios.push({
                step,
                badge,
                panelLabel,
                running: ext._store.view.running.length,
                queued: ext._store.view.queued.length,
                unackedFailures,
                screenshot: png,
            });
            indicator.menu.close(false);
            await sleep(300);
        }

        // Restore data (a step may have left Forge "offline") before the remaining checks.
        copy(`${dir}/base.json`, live);
        await this._poll();

        // Preferences window (separate gjs process) renders without errors.
        this._target().openPreferences();
        await sleep(4000);
        await screenshot(`${out}/prefs.png`);
        report.prefsScreenshot = `${out}/prefs.png`;

        // Leak check: enable/disable repeatedly, then make sure exactly one
        // indicator exists and the poller holds at most one pending source.
        for (let i = 0; i < CYCLES; i++) {
            Main.extensionManager.disableExtension(TARGET);
            await sleep(50);
            Main.extensionManager.enableExtension(TARGET);
            await sleep(50);
        }
        await sleep(1500);
        const ext = this._target();
        const indicators = Main.panel._rightBox.get_children()
            .concat(Main.panel._leftBox.get_children(), Main.panel._centerBox.get_children())
            .filter(c => c.get_first_child()?.constructor?.name?.includes('ActionViewIndicator')).length;
        report.cycles = {
            count: CYCLES,
            indicators,
            statusAreaPresent: Boolean(Main.panel.statusArea[TARGET]),
            pollerSources: ext?._poller?.activeSources ?? null,
            haveView: Boolean(ext?._store?.view),
        };
        this._finish(report);
    }

    _target() {
        return Main.extensionManager.lookup(TARGET)?.stateObj ?? null;
    }

    async _poll() {
        await this._waitFor(() => this._target()?._store, 5000, 'extension enabled');
        const store = this._target()._store;
        const before = store.conn.lastAttemptAt;
        this._target()._poller.pokeNow();
        await this._waitFor(() => this._target()?._store === store &&
            store.conn.lastAttemptAt !== before, 5000, 'poll');
    }

    async _waitFor(predicate, timeoutMs, what) {
        const start = Date.now();
        while (!predicate()) {
            if (Date.now() - start > timeoutMs)
                throw new Error(`timed out waiting for ${what}`);
            await sleep(100);
        }
    }

    _finish(report) {
        const text = JSON.stringify(report, null, 2);
        console.log(`ACTIONVIEW-SMOKE-REPORT ${text}`);
        try {
            GLib.file_set_contents(`${this._out}/report.json`, text);
        } catch (error) {
            console.error(`ACTIONVIEW-SMOKE could not write report: ${error.message}`);
        }
        // Always end the session, even if the report couldn't be written.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            global.context.terminate();
            return GLib.SOURCE_REMOVE;
        });
    }
}

function copy(from, to) {
    Gio.File.new_for_path(from).copy(Gio.File.new_for_path(to), Gio.FileCopyFlags.OVERWRITE, null, null);
}

async function screenshot(path) {
    const file = Gio.File.new_for_path(path);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
}
