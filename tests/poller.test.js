// Poller tests. gjs only (Poller uses Gio.Cancellable):
//   gjs -m tests/poller.test.js
// A fake scheduler stands in for GLib timeouts, so nothing actually waits.

import {Poller} from '../actionview@kanterlabs.dev/lib/poller.js';

const tests = [];
const test = (name, fn) => tests.push({name, fn});
function assert(cond, message) {
    if (!cond)
        throw new Error(message ?? 'assertion failed');
}
function eq(actual, expected, message) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${message ?? 'not equal'}\n   actual: ${a}\n expected: ${e}`);
}

/** Let pending promise continuations (the end of Poller._run) execute. */
async function settle() {
    for (let i = 0; i < 10; i++)
        await Promise.resolve();
}

class FakeScheduler {
    constructor() {
        this.timers = new Map();
        this._next = 1;
    }

    add(seconds, fn) {
        const id = this._next++;
        this.timers.set(id, {seconds, fn});
        return id;
    }

    remove(id) {
        assert(this.timers.delete(id), `removed unknown timer ${id}`);
    }

    get delays() {
        return [...this.timers.values()].map(t => t.seconds);
    }

    /** Fire the only pending timer. */
    fire() {
        eq(this.timers.size, 1, 'exactly one timer pending');
        const [[id, {fn}]] = this.timers;
        this.timers.delete(id);
        fn();
    }
}

/** A poller whose ticks stay in flight until the test resolves them. */
function harness({active = 5, idle = 30, isActive = false, failures = 0} = {}) {
    const h = {scheduler: new FakeScheduler(), ticks: 0, pending: [], failures, isActive, cancellables: []};
    h.poller = new Poller({
        tick: cancellable => {
            h.ticks++;
            h.cancellables.push(cancellable);
            return new Promise(resolve => h.pending.push(resolve));
        },
        intervals: () => ({active, idle}),
        isActive: () => h.isActive,
        failures: () => h.failures,
        scheduler: h.scheduler,
    });
    h.finishTick = async () => {
        h.pending.shift()();
        await settle();
    };
    return h;
}

test('poller: polls at once, then waits the idle interval', async () => {
    const h = harness();
    h.poller.start();
    eq(h.ticks, 1);
    eq(h.scheduler.delays, [], 'no timer while a request is in flight');
    await h.finishTick();
    eq(h.scheduler.delays, [30]);
    h.scheduler.fire();
    eq(h.ticks, 2);
    h.poller.stop();
});

test('poller: active interval while something runs or the menu is open', async () => {
    const h = harness({isActive: true});
    h.poller.start();
    await h.finishTick();
    eq(h.scheduler.delays, [5]);
    h.poller.stop();
});

test('poller: failures back off', async () => {
    const h = harness({failures: 2});
    h.poller.start();
    await h.finishTick();
    eq(h.scheduler.delays, [10]);
    h.poller.stop();
});

test('poller: a poke during a request runs once right after it', async () => {
    const h = harness();
    h.poller.start();
    h.poller.pokeNow();
    h.poller.pokeNow();
    eq(h.ticks, 1, 'still one request in flight');
    await h.finishTick();
    eq(h.ticks, 2, 'the poke ran immediately, once');
    eq(h.scheduler.delays, []);
    await h.finishTick();
    eq(h.scheduler.delays, [30]);
    h.poller.stop();
});

test('poller: a poke while idle replaces the pending timer', async () => {
    const h = harness();
    h.poller.start();
    await h.finishTick();
    h.poller.pokeNow();
    eq(h.ticks, 2);
    eq(h.scheduler.delays, [], 'old timer removed');
    await h.finishTick();
    h.poller.reschedule();
    h.poller.reschedule();
    eq(h.scheduler.delays, [30], 'reschedule never stacks timers');
    eq(h.poller.activeSources, 1);
    h.poller.stop();
});

test('poller: stop during a request cancels it and schedules nothing', async () => {
    const h = harness();
    h.poller.start();
    h.poller.stop();
    assert(h.cancellables[0].is_cancelled());
    await h.finishTick();
    eq(h.scheduler.delays, []);
    eq(h.poller.activeSources, 0);
    h.poller.pokeNow();
    eq(h.ticks, 1, 'a stopped poller ignores pokes');
});

test('poller: a throwing tick still schedules the next poll', async () => {
    // Logs one "poll failed unexpectedly" line (gjs's console is read-only, so it can't be captured).
    const h = harness();
    h.poller._tick = () => Promise.reject(new Error('expected by poller.test.js'));
    h.poller.start();
    await settle();
    eq(h.scheduler.delays, [30]);
    h.poller.stop();
});

let failed = 0;
for (const {name, fn} of tests) {
    try {
        await fn();
        print(`ok   ${name}`);
    } catch (error) {
        failed++;
        print(`FAIL ${name}\n     ${String(error.message).replaceAll('\n', '\n     ')}`);
    }
}
print(`\n${tests.length - failed}/${tests.length} passed`);
imports.system.exit(failed ? 1 : 0);
