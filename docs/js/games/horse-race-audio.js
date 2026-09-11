// The racecourse soundtrack: one recording, cut to the length of the race.
//
// There is no synthesis here. An earlier version generated hoofbeats and a
// crowd with the Web Audio API; a real recording beats it outright, so the
// track is the audio and the interface is only what a recording needs.
//
// The race and the track are the same length and are paused and resumed
// together, so they stay in step without any sync logic.

(function () {
  const MUTE_KEY = 'portal.race.muted';

  function readMuted() {
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (_e) { return false; }
  }
  function writeMuted(on) {
    try { localStorage.setItem(MUTE_KEY, on ? '1' : '0'); } catch (_e) { /* private mode */ }
  }

  function supported() {
    return typeof window !== 'undefined' && typeof window.Audio === 'function';
  }

  // create({ url }) -> { start, stop, suspend, mute, isMuted, isRunning }
  function create(opts) {
    const url = opts && opts.url;
    let el = null;
    let muted = readMuted();
    let running = false;
    let suspended = false;

    return {
      // Must be called from a user gesture: a keypress or a click. Audio
      // started any other way is blocked by every current browser.
      start() {
        if (running || !url || !supported()) return;
        running = true;
        try {
          el = new Audio(url);
          el.preload = 'auto';
          el.muted = muted;
          // A missing or unplayable file means a silent race, never a broken
          // one — the slide keeps running either way.
          el.addEventListener('error', () => { el = null; }, { once: true });
          const p = el.play();
          if (p && typeof p.catch === 'function') p.catch(() => { el = null; });
        } catch (_e) { el = null; }
      },

      stop() {
        running = false;
        if (!el) return;
        try { el.pause(); el.removeAttribute('src'); el.load(); } catch (_e) { /* already gone */ }
        el = null;
      },

      // Pausing the race pauses the track, so the two never drift apart.
      // Transient: it does not touch the stored mute preference.
      suspend(on) {
        suspended = !!on;
        if (!el) return;
        if (suspended) el.pause();
        else { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
      },

      mute(on) {
        muted = !!on;
        writeMuted(muted);
        if (el) el.muted = muted;
      },

      isMuted() { return muted; },
      isSuspended() { return suspended; },
      isRunning() { return running; },
    };
  }

  window.HorseRaceAudio = { create, supported, readMuted };
})();
