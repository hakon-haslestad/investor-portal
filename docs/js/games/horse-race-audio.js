// Racecourse atmosphere, synthesised with the Web Audio API.
//
// No audio files: the repo carries no assets, the deck's CSP is
// `default-src 'self'` so a CDN is out anyway, and generated sound can REACT
// to the race rather than loop underneath it. It is stylised — convincing as
// atmosphere, not mistakable for a recording.
//
// Everything hangs off one master gain, so muting is a gain change (the race
// keeps its timing) and stop() is a single disconnect.

(function () {
  const MUTE_KEY = 'portal.race.muted';

  function readMuted() {
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (_e) { return false; }
  }
  function writeMuted(on) {
    try { localStorage.setItem(MUTE_KEY, on ? '1' : '0'); } catch (_e) { /* private mode */ }
  }

  function supported() {
    return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
  }

  function create() {
    let ctx = null;
    let master = null;
    let crowdGain = null;
    let hoofTimer = null;
    let muted = readMuted();
    let running = false;
    let pace = 0;

    // A short burst of filtered noise reads as a hoof strike; four of them in
    // a lopsided pattern read as a gallop.
    let noiseBuffer = null;
    function noise() {
      if (!noiseBuffer) {
        const len = Math.floor(ctx.sampleRate * 0.4);
        noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = noiseBuffer.getChannelData(0);
        let last = 0;
        for (let i = 0; i < len; i++) {
          // Brown-ish noise: softer and more like a crowd than white.
          last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
          d[i] = last * 3.5;
        }
      }
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      return src;
    }

    function hoof(at, gain) {
      const src = noise();
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 160 + Math.random() * 90;
      bp.Q.value = 1.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(gain, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0008, at + 0.10);
      src.connect(bp).connect(g).connect(master);
      src.start(at);
      src.stop(at + 0.14);
    }

    // One gallop stride: four strikes, uneven, the way a canter actually lands.
    const STRIDE = [0, 0.13, 0.26, 0.36];
    function scheduleHooves() {
      if (!running || !ctx) return;
      const now = ctx.currentTime;
      // Faster early, settling as the race runs on; never silent.
      const strideLen = 0.62 - 0.10 * Math.min(1, pace);
      for (const off of STRIDE) hoof(now + off * (strideLen / 0.36), 0.5);
      hoofTimer = setTimeout(scheduleHooves, strideLen * 1000);
    }

    function tone(freq, at, dur, gain, type) {
      const o = ctx.createOscillator();
      o.type = type || 'triangle';
      o.frequency.setValueAtTime(freq, at);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(gain, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0008, at + dur);
      o.connect(g).connect(master);
      o.start(at);
      o.stop(at + dur + 0.05);
    }

    // Call to post: the classic rising bugle figure.
    function bugle() {
      const t = ctx.currentTime;
      const notes = [392, 523.25, 659.25, 783.99, 659.25, 783.99];
      notes.forEach((f, i) => tone(f, t + i * 0.18, 0.3, 0.16, 'square'));
    }

    function bell() {
      const t = ctx.currentTime;
      for (let i = 0; i < 5; i++) tone(1046.5, t + i * 0.13, 0.22, 0.13, 'sine');
    }

    function swell(amount, dur) {
      if (!crowdGain) return;
      const t = ctx.currentTime;
      const base = 0.05;
      crowdGain.gain.cancelScheduledValues(t);
      crowdGain.gain.setValueAtTime(crowdGain.gain.value, t);
      crowdGain.gain.linearRampToValueAtTime(base + amount, t + 0.25);
      crowdGain.gain.linearRampToValueAtTime(base, t + dur);
    }

    // Pausing the race silences the audio WITHOUT touching the user's mute
    // preference — otherwise a pause would persist as "muted" and the sound
    // would never come back.
    let suspended = false;
    function applyGain() {
      if (!master || !ctx) return;
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime((muted || suspended) ? 0 : 0.85, t + 0.12);
    }

    return {
      // MUST be called from inside a user gesture — an AudioContext created
      // on page load is suspended by every current browser.
      start() {
        if (running || !supported()) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        try { ctx = new Ctx(); } catch (_e) { return; }
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
        master = ctx.createGain();
        master.gain.value = (muted || suspended) ? 0 : 0.85;
        master.connect(ctx.destination);

        // Crowd bed: looping noise, heavily lowpassed, sitting well under.
        const bed = noise();
        bed.loop = true;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 420;
        crowdGain = ctx.createGain();
        crowdGain.gain.value = 0.05;
        bed.connect(lp).connect(crowdGain).connect(master);
        bed.start();

        running = true;
        scheduleHooves();
      },

      stop() {
        running = false;
        if (hoofTimer) { clearTimeout(hoofTimer); hoofTimer = null; }
        if (ctx) {
          try { if (master) master.disconnect(); } catch (_e) { /* already gone */ }
          try { ctx.close(); } catch (_e) { /* already closed */ }
        }
        ctx = null; master = null; crowdGain = null; noiseBuffer = null;
      },

      // t in [0,1] — lets the gallop settle as the race runs on.
      setPace(t) { pace = Number.isFinite(t) ? t : 0; },

      // Hooked to the same events that drive the commentary bar.
      cue(kind) {
        if (!running || !ctx) return;
        if (kind === 'off') bugle();
        else if (kind === 'finish') { bell(); swell(0.30, 2.2); }
        else if (kind === 'lead') swell(0.18, 1.4);
        else if (kind === 'photo') swell(0.28, 2.0);
        else if (kind === 'breakaway') swell(0.12, 1.0);
      },

      mute(on) {
        muted = !!on;
        writeMuted(muted);
        applyGain();
      },
      // Transient silence for a paused race; never persisted.
      suspend(on) {
        suspended = !!on;
        applyGain();
        if (suspended && hoofTimer) { clearTimeout(hoofTimer); hoofTimer = null; }
        else if (!suspended && running && !hoofTimer) scheduleHooves();
      },
      isMuted() { return muted; },
      isSuspended() { return suspended; },
      isRunning() { return running; },
    };
  }

  window.HorseRaceAudio = { create, supported, readMuted };
})();
