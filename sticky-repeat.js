// Sticky Repeat 1.0.0 — preserve the selected repeat mode across Spotify tracks.
// Local-only Spicetify extension. No network, credentials, or telemetry.
(function (root) {
  "use strict";

  function createController(options) {
    const clock = options.now || Date.now;
    const later = options.setTimeout || setTimeout;
    const cancel = options.clearTimeout || clearTimeout;
    const validMode = (mode) => Number.isInteger(mode) && mode >= 0 && mode <= 2;
    const key = (s) => s?.item?.uri
      ? [s.item.uri, s.item.uid || "", s.playbackId || ""].join("|") : null;
    let state = options.getState();
    let previousKey = key(state);
    let desired = validMode(state?.repeat) ? state.repeat : null;
    let enabled = options.enabled !== false;
    let generation = 0;
    let until = 0;
    let busy = false;
    let disposed = false;
    let errorReported = false;
    let adoption = null;
    const timers = new Set();

    function snapshot() {
      return { enabled, desired, repeat: state?.repeat, restoring: clock() < until };
    }
    function notify() { options.onChange?.(snapshot()); }
    function schedule(fn, delay) {
      const token = generation;
      const id = later(() => {
        timers.delete(id);
        if (!disposed && token === generation) fn();
      }, delay);
      timers.add(id);
      return id;
    }
    function stop() {
      generation++;
      for (const id of timers) cancel(id);
      timers.clear();
      adoption = null;
      until = 0;
    }
    function playable(s) {
      return /^spotify:(track|local):/.test(s?.item?.uri || "") &&
        s?.item?.metadata?.is_advertisement !== "true";
    }
    function permitted(s) {
      if (!playable(s)) return false;
      const restrictions = s.restrictions || {};
      if (desired === 2) return restrictions.canToggleRepeatTrack !== false;
      if (desired === 1) return restrictions.canToggleRepeatContext !== false;
      if (s.repeat === 2) return restrictions.canToggleRepeatTrack !== false;
      if (s.repeat === 1) return restrictions.canToggleRepeatContext !== false;
      return true;
    }
    function report(error) {
      if (!errorReported) {
        errorReported = true;
        options.onError?.(error);
      }
    }
    async function reconcile() {
      if (disposed || !enabled || busy || desired === null || clock() > until) return;
      const current = options.getState();
      if (!current || !validMode(current.repeat) || current.repeat === desired || !permitted(current)) return;
      busy = true;
      const token = generation;
      try {
        await options.setRepeat(desired);
      } catch (error) {
        if (token === generation) report(error);
      } finally {
        busy = false;
        // A slow restore may finish after a newer user choice. Correct it using
        // the latest choice, never by replaying the obsolete request.
        if (!disposed && enabled && token !== generation) {
          begin();
          schedule(reconcile, 80);
        }
      }
    }
    function begin() {
      stop();
      if (!enabled || desired === null) return;
      until = clock() + 3600;
      errorReported = false;
      for (const delay of [120, 350, 800, 1500, 2500, 3500]) schedule(reconcile, delay);
    }
    function choose(mode) {
      if (disposed || !validMode(mode)) return;
      desired = mode;
      // Also protects a manual choice made while an old restore is in flight.
      begin();
      notify();
    }
    function action(name) {
      if (disposed || !enabled) return;
      if (["play", "skipToNext", "skipToPrevious"].includes(name)) begin();
    }
    function update(next) {
      if (disposed) return;
      const nextKey = key(next);
      const changed = !!nextKey && !!previousKey && nextKey !== previousKey;
      state = next;
      if (nextKey) previousKey = nextKey;
      if (!playable(next) || !validMode(next.repeat)) return;
      if (desired === null || !enabled) {
        desired = next.repeat;
        notify();
        return;
      }
      if (changed) begin();
      if (clock() < until) {
        notify();
        return;
      }
      if (next.repeat === desired) {
        if (adoption) {
          cancel(adoption.id);
          timers.delete(adoption.id);
          adoption = null;
        }
        return;
      }
      // A core/Connect update can reset repeat just before the track update.
      // Briefly defer adopting it; a genuine same-track change is still honored.
      if (adoption?.mode === next.repeat) return;
      if (adoption) { cancel(adoption.id); timers.delete(adoption.id); }
      const mode = next.repeat;
      adoption = { mode, id: schedule(() => {
        adoption = null;
        if (state?.repeat === mode) { desired = mode; notify(); }
      }, 500) };
    }
    function setEnabled(value) {
      if (disposed) return;
      stop();
      enabled = !!value;
      state = options.getState();
      previousKey = key(state);
      if (validMode(state?.repeat)) desired = state.repeat;
      notify();
    }
    function dispose() { disposed = true; stop(); }
    return { update, action, choose, setEnabled, snapshot, dispose };
  }

  if (typeof document === "undefined" && typeof module === "object" && module.exports) {
    module.exports = { createController };
    return;
  }

  let attempts = 0;
  function boot() {
    const S = root.Spicetify;
    const api = S?.Player?.origin;
    if (!api?._events?.addListener || typeof api.setRepeat !== "function" ||
        !S.Menu?.Item || !S.Playbar?.Button) {
      if (++attempts < 240) setTimeout(boot, 250);
      else console.warn("[Sticky Repeat] Player API unavailable; extension not started.", {
        player: !!api, events: !!api?._events?.addListener,
        setter: typeof api?.setRepeat, menu: !!S?.Menu?.Item, playbar: !!S?.Playbar?.Button,
      });
      return;
    }
    if (root.__stickyRepeat) return;
    const storageKey = "sticky-repeat.enabled.v1";
    let enabled = true;
    try { enabled = localStorage.getItem(storageKey) !== "false"; } catch (_) { /* in-memory mode */ }
    const originalSetRepeat = api.setRepeat;
    let menu;
    let button;
    const modeNames = ["без повтора", "повтор очереди", "повтор одной песни"];
    const controller = createController({
      getState: () => api._state,
      setRepeat: (mode) => originalSetRepeat.call(api, mode),
      enabled,
      onChange: render,
      onError: (error) => {
        console.warn("[Sticky Repeat] Could not restore repeat:", error);
        S.showNotification?.("Не удалось сохранить повтор. Проверь подключение Spotify.", true);
      },
    });
    function render() {
      const status = controller.snapshot();
      const label = `Сохранять режим повтора: ${status.enabled ? "включено" : "выключено"}` +
        (status.enabled && status.desired !== null ? ` — ${modeNames[status.desired]}` : "");
      menu?.setState(status.enabled);
      if (button) {
        button.active = status.enabled;
        button.label = label;
        button.element.setAttribute("aria-label", label);
        button.element.setAttribute("aria-pressed", String(status.enabled));
        button.element.style.color = status.enabled ? "#1ed760" : "#b3b3b3";
      }
    }
    function toggle() {
      const next = !controller.snapshot().enabled;
      controller.setEnabled(next);
      try { localStorage.setItem(storageKey, String(next)); } catch (_) { /* in-memory mode */ }
      S.showNotification?.(next ? "Режим повтора будет сохраняться при смене песни" : "Сохранение режима повтора выключено");
    }
    // Capture native/local user requests. Our restores call the original method.
    function wrappedSetRepeat(mode, ...args) {
      controller.choose(mode);
      return originalSetRepeat.call(this, mode, ...args);
    }
    api.setRepeat = wrappedSetRepeat;
    const onAction = (event) => controller.action(event.data?.action);
    const onUpdate = (event) => controller.update(event.data);
    api._events.addListener("action", onAction);
    api._events.addListener("update", onUpdate);

    // React may have bound the original setter before the extension loaded.
    // Capture the native repeat control as well, respecting its available modes.
    function onClick(event) {
      const control = event.target?.closest?.('[data-testid="control-button-repeat"]');
      if (!control || control.disabled || control.getAttribute("aria-disabled") === "true") return;
      const state = api._state;
      const r = state?.restrictions || {};
      const context = r.canToggleRepeatContext === true;
      const track = r.canToggleRepeatTrack === true;
      const checked = control.getAttribute("aria-checked");
      const mode = checked === "mixed" ? 2 : checked === "true" ? 1 : checked === "false" ? 0 : state?.repeat;
      if (!Number.isInteger(mode)) return;
      const next = context && track ? (mode + 1) % 3 : context ? (mode + 1) % 2 : track ? (mode === 1 ? 2 : (mode + 2) % 4) : 0;
      controller.choose(next);
    }
    document.addEventListener("click", onClick, true);
    menu = new S.Menu.Item("Сохранять режим повтора", enabled, toggle, "repeat");
    menu.register();
    const lock = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="10.5" r="1" fill="currentColor"/></svg>';
    button = new S.Playbar.Button("Сохранять режим повтора", lock, toggle, false, enabled, false);
    button.element.id = "sticky-repeat-toggle";
    // Playbar's right-container selector is absent in Spotify 1.3.8. Attach to
    // the native repeat control instead, and reattach if React remounts it.
    button.element.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;min-width:32px;padding:0;border:0;background:transparent;border-radius:50%;cursor:pointer";
    function mount() {
      if (!button.element.isConnected) {
        document.querySelector('[data-testid="control-button-repeat"]')?.after(button.element);
      }
    }
    const observer = new MutationObserver(mount);
    observer.observe(document.body, { childList: true, subtree: true });
    mount();
    render();
    root.__stickyRepeat = {
      version: "1.0.0",
      status: controller.snapshot,
      dispose() {
        controller.dispose();
        observer.disconnect();
        document.removeEventListener("click", onClick, true);
        api._events.removeListener?.("action", onAction);
        api._events.removeListener?.("update", onUpdate);
        if (api.setRepeat === wrappedSetRepeat) api.setRepeat = originalSetRepeat;
        menu.deregister();
        button.deregister();
        delete root.__stickyRepeat;
      },
    };
    console.info("[Sticky Repeat] Loaded 1.0.0");
  }
  boot();
})(globalThis);
