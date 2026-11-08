const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createController } = require('../sticky-repeat.js');

class Clock {
  time = 0;
  nextId = 1;
  jobs = new Map();
  now = () => this.time;
  setTimeout = (fn, delay = 0) => {
    const id = this.nextId++;
    this.jobs.set(id, { at: this.time + Math.max(0, delay), fn });
    return id;
  };
  clearTimeout = (id) => this.jobs.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    let turns = 0;
    while (true) {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      assert.ok(++turns < 10000, 'scheduler must not spin forever');
      this.time = next[1].at;
      this.jobs.delete(next[0]);
      next[1].fn();
    }
    this.time = end;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

function track(id, repeat = 2, extra = {}) {
  return {
    item: { uri: `spotify:track:${id}`, uid: id, type: 'track' },
    playbackId: `playback-${id}`,
    repeat,
    restrictions: { canToggleRepeatContext: true, canToggleRepeatTrack: true },
    ...extra,
  };
}

function setup(initial = track('A'), options = {}) {
  const clock = new Clock();
  let current = initial;
  const calls = [];
  const errors = [];
  let controller;
  const update = (value) => {
    current = value;
    controller.update(current);
  };
  controller = createController({
    getState: () => current,
    setRepeat(mode) {
      calls.push({ mode, time: clock.time, uri: current?.item?.uri });
      if (options.setRepeat) return options.setRepeat(mode, { update, state: () => current, clock });
      update({ ...current, repeat: mode });
      return Promise.resolve();
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onChange() {},
    onError(error) { errors.push(error); },
    enabled: options.enabled ?? true,
  });
  controller.update(initial);
  return { controller, clock, calls, errors, update, state: () => current };
}

test('repeat one follows Next after Spotify resets it to repeat context', async () => {
  const h = setup();
  h.controller.action('skipToNext');
  h.update(track('B', 1));
  await h.clock.advance(5000);
  assert.equal(h.state().repeat, 2);
  assert.ok(h.calls.some(({ mode, uri }) => mode === 2 && uri === 'spotify:track:B'));
});

test('a track change without a local action also retains repeat one', async () => {
  const h = setup();
  h.update(track('B', 0));
  await h.clock.advance(5000);
  assert.equal(h.state().repeat, 2);
});

test('a reset arriving just before the new track is not mistaken for manual choice', async () => {
  const h = setup();
  h.update(track('A', 1));
  await h.clock.advance(100);
  h.update(track('B', 1));
  await h.clock.advance(5000);
  assert.equal(h.state().repeat, 2);
});

for (const desired of [0, 1, 2]) {
  test(`a new playback context preserves explicit repeat mode ${desired}`, async () => {
    const h = setup(track('A', desired));
    h.controller.action('play');
    h.update(track('B', (desired + 1) % 3));
    await h.clock.advance(5000);
    assert.equal(h.state().repeat, desired);
  });
}

test('manually turning repeat off cancels an outstanding transition restore', async () => {
  const h = setup();
  h.controller.action('skipToNext');
  h.update(track('B', 1));
  h.controller.choose(0);
  h.update(track('B', 0));
  const callCount = h.calls.length;
  await h.clock.advance(5000);
  assert.equal(h.state().repeat, 0);
  assert.ok(h.calls.slice(callCount).every(({ mode }) => mode === 0));
  h.controller.action('skipToNext');
  h.update(track('C', 1));
  await h.clock.advance(5000);
  assert.equal(h.state().repeat, 0);
});

test('rapid successive skips do not adopt an intermediate reset', async () => {
  const h = setup();
  h.controller.action('skipToNext');
  h.update(track('B', 1));
  await h.clock.advance(50);
  h.controller.action('skipToNext');
  h.update(track('C', 0));
  await h.clock.advance(5000);
  assert.equal(h.state().item.uri, 'spotify:track:C');
  assert.equal(h.state().repeat, 2);
});

test('same URI with a new playback instance preserves repeat one', async () => {
  const h = setup();
  h.controller.action('play');
  h.update(track('A', 0, { playbackId: 'another-playback' }));
  await h.clock.advance(5000);
  assert.equal(h.state().repeat, 2);
});

test('disabled extension leaves native repeat changes alone', async () => {
  const h = setup(track('A', 2), { enabled: false });
  h.controller.action('skipToNext');
  h.update(track('B', 1));
  await h.clock.advance(5000);
  assert.equal(h.state().repeat, 1);
  assert.deepEqual(h.calls, []);
});

test('disabling the extension cancels delayed restoration', async () => {
  const h = setup();
  h.controller.action('skipToNext');
  h.update(track('B', 1));
  h.controller.setEnabled(false);
  const count = h.calls.length;
  await h.clock.advance(5000);
  assert.equal(h.calls.length, count);
});

test('enabling starts from the current native mode', async () => {
  const h = setup(track('A', 2), { enabled: false });
  h.update(track('A', 0));
  h.controller.setEnabled(true);
  h.controller.action('skipToNext');
  h.update(track('B', 1));
  await h.clock.advance(5000);
  assert.equal(h.state().repeat, 0);
});

test('a deliberate repeat change from another device is accepted on the same track', async () => {
  const h = setup();
  h.update(track('A', 0));
  await h.clock.advance(5000);
  assert.equal(h.state().repeat, 0);
  assert.deepEqual(h.calls, []);
  h.update(track('B', 1));
  await h.clock.advance(5000);
  assert.equal(h.state().repeat, 0);
});

test('unsupported repeat-one state does not generate forbidden writes', async () => {
  const h = setup();
  h.controller.action('skipToNext');
  h.update(track('B', 0, {
    restrictions: { canToggleRepeatContext: true, canToggleRepeatTrack: false },
  }));
  await h.clock.advance(10000);
  assert.deepEqual(h.calls, []);
});

test('ads are skipped without forgetting the saved music repeat mode', async () => {
  const h = setup();
  h.update({
    ...track('ad', 0),
    item: { uri: 'spotify:ad:example', type: 'ad' },
    restrictions: { canToggleRepeatContext: false, canToggleRepeatTrack: false },
  });
  await h.clock.advance(10000);
  assert.deepEqual(h.calls, []);
  h.update(track('B', 0));
  await h.clock.advance(5000);
  assert.equal(h.state().repeat, 2);
});

test('write failures are reported and retries stop after a finite window', async () => {
  const h = setup(track('A'), { setRepeat: () => Promise.reject(new Error('offline')) });
  h.controller.action('skipToNext');
  h.update(track('B', 0));
  await h.clock.advance(10000);
  assert.ok(h.calls.length > 0 && h.calls.length <= 20, `unexpected retry count ${h.calls.length}`);
  assert.ok(h.errors.length > 0);
  const attempts = h.calls.length;
  await h.clock.advance(60000);
  assert.equal(h.calls.length, attempts);
});

test('a late in-flight restore cannot permanently undo newer manual off', async () => {
  let pending;
  let first = true;
  const h = setup(track('A'), {
    setRepeat(mode, { update, state }) {
      if (first) {
        first = false;
        return new Promise(resolve => {
          pending = () => { update({ ...state(), repeat: mode }); resolve(); };
        });
      }
      update({ ...state(), repeat: mode });
      return Promise.resolve();
    },
  });
  h.controller.action('skipToNext');
  h.update(track('B', 1));
  await h.clock.advance(1000);
  assert.equal(typeof pending, 'function', 'a restore should have started');
  h.controller.choose(0);
  h.update(track('B', 0));
  pending();
  await h.clock.advance(5000);
  assert.equal(h.state().repeat, 0);
});

test('dispose prevents scheduled writes', async () => {
  const h = setup();
  h.controller.action('skipToNext');
  h.update(track('B', 1));
  h.controller.dispose();
  const count = h.calls.length;
  await h.clock.advance(10000);
  assert.equal(h.calls.length, count);
});

test('an obsolete write completing after the retry window still respects newer manual off', async () => {
  let pending;
  let first = true;
  const h = setup(track('A'), {
    setRepeat(mode, { update, state }) {
      if (first) {
        first = false;
        return new Promise(resolve => {
          pending = () => { update({ ...state(), repeat: mode }); resolve(); };
        });
      }
      update({ ...state(), repeat: mode });
      return Promise.resolve();
    },
  });
  h.controller.action('skipToNext');
  h.update(track('B', 1));
  await h.clock.advance(1000);
  h.controller.choose(0);
  h.update(track('B', 0));
  await h.clock.advance(6000);
  pending();
  await h.clock.advance(5000);
  assert.equal(h.state().repeat, 0);
});

test('Spotify browser boot succeeds even when the host also exposes module.exports', () => {
  const clock = new Clock();
  const listeners = new Map();
  const documentListeners = new Map();
  const saved = new Map();
  const menus = [];
  const buttons = [];
  const observers = [];
  const mounts = [];
  const body = {};
  const nativeRepeat = {
    after(element) {
      element.isConnected = true;
      mounts.push(element);
    },
  };
  const originalSetRepeat = async function(mode) { this._state.repeat = mode; };
  const api = {
    _state: track('A'),
    setRepeat: originalSetRepeat,
    _events: {
      addListener(name, fn) { listeners.set(name, fn); },
      removeListener(name, fn) {
        if (listeners.get(name) === fn) listeners.delete(name);
      },
    },
  };
  class MenuItem {
    constructor(name, enabled, onClick) {
      Object.assign(this, { name, enabled, onClick, registered: false });
      menus.push(this);
    }
    register() { this.registered = true; }
    deregister() { this.registered = false; }
    setState(value) { this.enabled = value; }
  }
  class PlaybarButton {
    constructor(label, icon, onClick, disabled, active, registerOnCreate = true) {
      Object.assign(this, { label, icon, onClick, disabled, active, registered: registerOnCreate });
      const attributes = new Map();
      this.element = {
        attributes,
        style: { cssText: '' },
        isConnected: false,
        setAttribute(name, value) { attributes.set(name, value); },
      };
      buttons.push(this);
    }
    deregister() { this.registered = false; this.element.isConnected = false; }
  }
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      observers.push(this);
    }
    observe(target, options) {
      Object.assign(this, { target, options, connected: true });
    }
    disconnect() { this.connected = false; }
  }
  const context = vm.createContext({
    // Spotify is a browser renderer which can nonetheless provide module.exports.
    module: { exports: {} },
    document: {
      body,
      querySelector(selector) {
        return selector === '[data-testid="control-button-repeat"]' ? nativeRepeat : null;
      },
      addEventListener(name, fn) { documentListeners.set(name, fn); },
      removeEventListener(name, fn) {
        if (documentListeners.get(name) === fn) documentListeners.delete(name);
      },
    },
    MutationObserver,
    localStorage: {
      getItem(key) { return saved.get(key) ?? null; },
      setItem(key, value) { saved.set(key, value); },
    },
    Spicetify: {
      Player: { origin: api },
      Menu: { Item: MenuItem },
      Playbar: { Button: PlaybarButton },
      showNotification() {},
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    console: { info() {}, warn() {} },
  });
  const source = fs.readFileSync(require.resolve('../sticky-repeat.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'sticky-repeat.js' });

  assert.ok(context.__stickyRepeat, 'the actual browser extension must boot');
  assert.equal(context.__stickyRepeat.status().enabled, true);
  assert.equal(menus.length, 1);
  assert.equal(menus[0].registered, true);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].element.attributes.get('aria-pressed'), 'true');
  assert.equal(buttons[0].element.isConnected, true, 'toggle must actually be mounted');
  assert.equal(buttons[0].registered, false, 'avoid unavailable legacy Playbar container');
  assert.equal(mounts[0], buttons[0].element);
  assert.equal(observers.length, 1);
  assert.equal(observers[0].target, body);
  assert.equal(observers[0].options.childList, true);
  assert.equal(observers[0].options.subtree, true);
  assert.equal(listeners.size, 2);
  assert.ok(documentListeners.has('click'));
  assert.notEqual(api.setRepeat, originalSetRepeat);
  assert.equal(context.module.exports.createController, undefined, 'browser must not take the Node-only export branch');

  observers[0].callback();
  assert.equal(mounts.length, 1, 'unrelated DOM changes must not duplicate the toggle');
  buttons[0].element.isConnected = false;
  observers[0].callback();
  assert.equal(mounts.length, 2, 'React remount must reattach the toggle');
  assert.equal(buttons[0].element.isConnected, true);

  menus[0].onClick();
  assert.equal(context.__stickyRepeat.status().enabled, false);
  assert.equal(buttons[0].element.attributes.get('aria-pressed'), 'false');
  assert.equal(saved.get('sticky-repeat.enabled.v1'), 'false');

  context.__stickyRepeat.dispose();
  assert.equal(context.__stickyRepeat, undefined);
  assert.equal(api.setRepeat, originalSetRepeat);
  assert.equal(menus[0].registered, false);
  assert.equal(buttons[0].registered, false);
  assert.equal(buttons[0].element.isConnected, false);
  assert.equal(observers[0].connected, false, 'cleanup must stop DOM observation');
  assert.equal(listeners.size, 0);
  assert.equal(documentListeners.size, 0);
});
