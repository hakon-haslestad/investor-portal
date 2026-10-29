const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const PAGE = path.join(DOCS, 'js', 'pages', 'presentation-page.js');

function pageSrc() { return fs.readFileSync(PAGE, 'utf8'); }

// The track and the race length live together in HorseRaceAudio.TRACK, so
// both entry points read one definition.
function track() {
  const { context } = require('./harness');
  const w = context(['games/horse-race-audio.js'], { Audio: function Audio() { return {}; } });
  return w.HorseRaceAudio.TRACK;
}

// Minimal MPEG-1 Layer III frame walker — enough to total a duration without
// pulling in a dependency.
function mp3DurationMs(file) {
  const d = fs.readFileSync(file);
  const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const RATES = [44100, 48000, 32000];
  let i = 0;
  if (d.slice(0, 3).toString() === 'ID3') {
    i = 10 + ((d[6] & 0x7f) << 21 | (d[7] & 0x7f) << 14 | (d[8] & 0x7f) << 7 | (d[9] & 0x7f));
  }
  let ms = 0;
  while (i < d.length - 4) {
    if (d[i] === 0xFF && (d[i + 1] & 0xE0) === 0xE0) {
      const ver = (d[i + 1] >> 3) & 3, layer = (d[i + 1] >> 1) & 3;
      const bri = (d[i + 2] >> 4) & 0xF, sri = (d[i + 2] >> 2) & 3, pad = (d[i + 2] >> 1) & 1;
      if (ver === 3 && layer === 1 && bri !== 0 && bri !== 15 && sri !== 3) {
        const sr = RATES[sri];
        ms += (1152 / sr) * 1000;
        i += Math.floor((144 * BITRATES[bri] * 1000) / sr) + pad;
        continue;
      }
    }
    i += 1;
  }
  return ms;
}

test('the declared track actually exists', () => {
  const rel = track().url.replace(/^\.\//, '');
  const file = path.join(DOCS, rel);
  assert.ok(fs.existsSync(file), `${rel} is missing — the race would fall back to synthesised audio`);
  assert.ok(fs.statSync(file).size > 10000, 'and is not a stub');
});

test('the soundtrack is the same length as the race', () => {
  const t = track();
  const raceMs = t.ms;
  const audioMs = mp3DurationMs(path.join(DOCS, t.url.replace(/^\.\//, '')));
  const driftS = Math.abs(audioMs - raceMs) / 1000;
  // They are paused and resumed together, so they only need to START aligned
  // and END together; a couple of seconds either way is inaudible.
  assert.ok(driftS < 3,
    `race is ${raceMs / 1000}s but the track is ${(audioMs / 1000).toFixed(1)}s — ${driftS.toFixed(1)}s apart`);
});

test('the audio is same-origin, which is all the deck CSP permits', () => {
  const rel = track().url;
  assert.ok(rel.startsWith('./'), `${rel} must be a relative path`);
  assert.ok(!/^https?:/.test(rel), 'default-src \'self\' blocks any remote media');
  const html = fs.readFileSync(path.join(DOCS, 'presentation.html'), 'utf8');
  const csp = /content="([^"]*default-src[^"]*)"/.exec(html)[1];
  assert.ok(/default-src 'self'/.test(csp));
  // No media-src override that would be narrower than default-src.
  const media = /media-src ([^;"]*)/.exec(csp);
  if (media) assert.ok(media[1].includes("'self'"), 'media-src must still allow same-origin');
});

test('the audio exposes exactly what the view calls, and nothing more', () => {
  const { context } = require('./harness');
  const w = context(['games/horse-race-audio.js'], { Audio: function Audio() { return {}; } });
  const a = w.HorseRaceAudio.create({ url: './audio/x.mp3' });
  for (const k of ['start', 'stop', 'suspend', 'mute', 'isMuted', 'isRunning']) {
    assert.equal(typeof a[k], 'function', `audio is missing ${k}`);
  }
  assert.equal(a.isRunning(), false, 'nothing plays until start()');
  // The synth is gone: a recording needs no per-frame pacing or event cues.
  assert.equal(a.setPace, undefined);
  assert.equal(a.cue, undefined);
});

test('the view never calls an audio method that no longer exists', () => {
  const src = fs.readFileSync(path.join(DOCS, 'js', 'games', 'horse-race-view.js'), 'utf8');
  const called = [...src.matchAll(/audio\.([a-zA-Z]+)\(/g)].map((m) => m[1]);
  const offered = ['start', 'stop', 'suspend', 'mute', 'isMuted', 'isSuspended', 'isRunning'];
  for (const c of new Set(called)) {
    assert.ok(offered.includes(c), `the view calls audio.${c}(), which the module does not provide`);
  }
});

test('no synthesis is left behind', () => {
  const src = fs.readFileSync(path.join(DOCS, 'js', 'games', 'horse-race-audio.js'), 'utf8');
  for (const gone of ['AudioContext', 'createOscillator', 'createGain', 'createBiquadFilter', 'createSynth']) {
    assert.ok(!src.includes(gone), `${gone} should have gone with the synth`);
  }
});

test('the deck races for exactly as long as the music', () => {
  // The deck is the showpiece: its race and the soundtrack are the same
  // length, so the music lands on the finish.
  assert.match(pageSrc(), /duration: TRACK\.ms/);
  assert.ok(track().ms > 0);
});

test('the Games race keeps its own shorter clock, and says why', () => {
  const game = fs.readFileSync(path.join(DOCS, 'js', 'games', 'horse-race.js'), 'utf8');
  // A quick game, not a centrepiece — so it does NOT inherit the deck's
  // 2.5 minutes just because it shares the recording.
  assert.match(game, /duration: E\(\)\.durationFor\(days\)/);
  assert.ok(!/duration: TRACK\.ms/.test(game), 'the game must not take the deck length');

  const eng = fs.readFileSync(path.join(DOCS, 'js', 'games', 'horse-race-engine.js'), 'utf8');
  const short = /windowDays <= 5 \? (\d+) : (\d+)/.exec(eng);
  assert.ok(short, 'durationFor still decides the game length');
  assert.equal(Number(short[1]), 60000, 'a five-day race is a minute');
  assert.ok(Number(short[2]) <= 90000, 'and a wider window is not much more');
  // The track outlasts the game, which is fine: it is cut off at the line.
  assert.ok(track().ms > Number(short[1]), 'the recording is longer than the game');
});

test('mute is remembered between races', () => {
  const { context } = require('./harness');
  const w = context(['games/horse-race-audio.js'], { Audio: function Audio() { return {}; } });
  const a = w.HorseRaceAudio.create({ url: './audio/x.mp3' });
  assert.equal(a.isMuted(), false);
  a.mute(true);
  assert.equal(a.isMuted(), true);
  // A fresh race reads the stored preference rather than starting loud.
  assert.equal(w.HorseRaceAudio.create({ url: './audio/x.mp3' }).isMuted(), true);
  assert.equal(w.HorseRaceAudio.readMuted(), true);
});
