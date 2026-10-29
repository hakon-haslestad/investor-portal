// One round, shared by every game.
//
// A round is: a question, a fixed list of options, and one answer per player.
// Odd One Out asks which of four cards is the odd one; Guess the Stock asks
// which of five names it is; Back Trading asks hold or sell; Horse Race asks
// which horse. The games differ only in what the options ARE and what a
// correct answer MEANS — everything else was being copy-pasted.
//
// Answers arrive from a tap on the shared screen or from a phone. Both go
// through set(), so a game never has two code paths to keep in step.

(function () {
  function create(opts) {
    const roster = (opts.roster || []).filter(Boolean);
    const codes = new Set(roster.map((p) => p.code));
    const exclusive = !!opts.exclusive;
    const onChange = opts.onChange || (() => {});
    const room = opts.room || null;

    let labels = [];
    let announced = null;   // guards against re-announcing the same round
    const picks = new Map();

    // Who already holds this option. Only meaningful when exclusive.
    function holderOf(value) {
      for (const [code, v] of picks) if (v === value) return code;
      return null;
    }

    function valid(code, value) {
      if (!codes.has(code)) return false;              // not in this room
      if (!Number.isInteger(value)) return false;
      return value >= 0 && value < labels.length;
    }

    // The single way an answer is recorded, wherever it came from.
    // Returns false when refused, so a caller can tell that phone to retry.
    function set(code, value) {
      if (!valid(code, value)) return false;
      if (picks.get(code) === value) return true;      // idempotent
      if (exclusive) {
        const holder = holderOf(value);
        // First claim wins. A later one is refused rather than silently
        // stealing the horse somebody already has.
        if (holder && holder !== code) return false;
      }
      picks.set(code, value);
      return true;
    }

    // Merge whatever the room currently holds. Refusals are reported so the
    // host can tell those phones to pick again.
    function merge(answers) {
      const refused = [];
      let changed = false;
      for (const [code, raw] of Object.entries(answers || {})) {
        const value = Number(raw);
        if (!valid(code, value)) continue;
        if (picks.get(code) === value) continue;
        if (set(code, value)) changed = true;
        else refused.push(code);
      }
      return { changed, refused };
    }

    // Subscribing here rather than in each game is deliberate: room.onChange
    // fires its callback synchronously, and a game that subscribed before its
    // own state existed crashed in production. Rounds owns the state it
    // touches, and only notifies the game when a pick actually changed.
    const off = room ? room.onChange((state) => {
      if (!labels.length) return;                      // no round open yet
      const { changed, refused } = merge(state.answers);
      if (changed || refused.length) onChange({ changed, refused, picks });
    }) : null;

    return {
      picks,
      get labels() { return labels.slice(); },
      get complete() { return roster.length > 0 && picks.size >= roster.length; },
      get count() { return picks.size; },
      get remaining() { return roster.filter((p) => !picks.has(p.code)); },
      valueFor: (code) => (picks.has(code) ? picks.get(code) : null),
      holderOf,
      set,

      // Open a new round. `key` identifies it: re-opening with the same key
      // is a no-op, which matters because a game re-renders on every toggle
      // and re-announcing would wipe every phone's answer.
      open({ prompt, labels: next, key }) {
        const id = key != null ? String(key) : JSON.stringify(next);
        if (announced === id) return false;
        announced = id;
        labels = (next || []).map(String);
        picks.clear();
        if (room) room.setRound(prompt || '', labels);
        return true;
      },

      // Clear the answers without announcing a new question.
      reset() { picks.clear(); },

      destroy() { if (off) off(); picks.clear(); },
    };
  }

  window.GameRounds = { create };
})();
