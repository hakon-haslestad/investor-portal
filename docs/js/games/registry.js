// The game catalogue. Games are DATA, not hardcoded UI — the card grid and
// the router both read this list, so adding a game means adding an entry.
//
// GameDefinition:
//   id          kebab-case, used in the route (#/games/<id>)
//   name        display name
//   icon        one emoji for the card
//   tagline     one sentence, shown on the card
//   rules       short HTML, shown in the shell's "How to play"
//   tags        ('party' | 'skill' | 'recurring')[]
//   players     '1' | '2+' | '3+'
//   minTrades   minimum trades in the filtered set to be playable
//   hosted      true when the game collects one answer per player, so it can
//               be played across devices (see games/room.js)
//   drinkingRule  shown only when sober mode is off
//   component   { mount(el, props) -> { newRound?, destroy? } }
//   wide        true to give the game the full viewport (.container.wide)
//
// GameProps (what component.mount receives):
//   trades      already filtered by period + competition
//   players     players in the selected competition, else all members
//   soberMode   boolean
//   pool        the GamePool context (price series, holding text, …)
//   rng         seedable RNG — games must never call Math.random
//   history     GameShell.history, scoped by the caller
//   competitionId
//   me          the signed-in member row, or null
//   room        the live GameRoom when one is open, else null — games reach
//               it through GameRounds rather than directly

(function () {
  const registry = [
    {
      id: 'spin-the-stock',
      name: 'Spin the stock',
      icon: '🎲',
      tagline: 'Draw a random real position and see how it went.',
      rules: `<p>Hit spin. The wheel lands on a real stock somebody in the club actually bought.</p>
              <p>Green means it made money, red means it lost. The chart shows what the price did while we held it, with our buys and sells marked.</p>`,
      tags: ['party'],
      players: '1',
      minTrades: 1,
      drinkingRule: 'Winner hands out a shot, loser takes one.',
      component: window.GameSpinTheStock({ guess: false }),
    },
    {
      id: 'guess-the-stock',
      name: 'Guess the stock',
      icon: '🤔',
      tagline: 'Five candidates, one chart. Which stock is it?',
      rules: `<p>A position is dealt face-down — you get the price chart and five candidate names, numbered.</p>
              <p>Pick the one you think it is. On phones you tap the number; the names stay on the big screen.</p>
              <p>The wrong answers are other real holdings, so none of them are obviously padding.</p>`,
      tags: ['party', 'skill'],
      players: '1',
      minTrades: 5,
      hosted: true,
      drinkingRule: 'Everyone who guessed wrong drinks.',
      component: window.GameGuessTheStock,
    },
    {
      id: 'odd-one-out',
      name: 'Odd one out',
      icon: '🧩',
      tagline: 'Three of these belong together. Spot the one that does not.',
      rules: `<p>Four stocks from the club's real trades. Three share something — the same buyer, the same week, all winners, the same exchange — and one doesn't.</p>
              <p>Tap the odd one. Whatever would give the answer away is masked, so if the rule is "same buyer" the names are hidden.</p>
              <p>Get it right and your streak grows; get it wrong and it resets.</p>`,
      tags: ['skill', 'party'],
      players: '1',
      minTrades: 8,
      hosted: true,
      drinkingRule: 'Wrong guess drinks.',
      component: window.GameOddOneOut,
    },
    {
      id: 'back-trading',
      name: 'Back trading',
      icon: '⏪',
      tagline: 'Was selling the right call? Replay the decision and find out.',
      rules: `<p>A closed trade is shown as it looked on the day it was sold — entry, exit, and the chart up to that point. Nothing after.</p>
              <p>Say whether you would have held. Then the rest of the chart appears, with the verdict: <strong>good sell</strong> if the price fell, <strong>sold too early</strong> if it ran, <strong>neutral</strong> in between.</p>
              <p>Everyone calls it before the reveal — the verdict is whatever the price has done by the <em>latest</em> close we have.</p>
              <p>The strip shows the verdict at 5, 20, 60, 120 and 250 trading days too, so you can see it flip over time. Horizons with no data yet are left out rather than guessed, and trades with no prices after the sale are not offered at all.</p>`,
      tags: ['skill', 'recurring'],
      // One column is a perfectly good game of it.
      players: '1',
      minTrades: 1,
      hosted: true,
      drinkingRule: 'Sold too early? The seller drinks. Called it wrong? You drink.',
      component: window.GameBackTrading,
    },
    {
      id: 'horse-race',
      name: 'Horse race',
      icon: '🏇',
      tagline: 'Pick a horse, replay a price window, last one drinks.',
      rules: `<p>Everyone picks a ticker from the club's holdings. A past price window is then replayed as a race — position on the track is return since the window opened, so every horse starts level whatever it costs.</p>
              <p>Odds come from how volatile the horse was <em>before</em> the window. They are decoration: they never affect the running.</p>
              <p>Daily closes only, so the shortest race is five days. The finish is the real return — the wobble along the way is just for show.</p>`,
      tags: ['party', 'recurring'],
      // Alone, the rest of the field is drawn for you — so one player is a
      // race, not an empty track.
      players: '1',
      minTrades: 2,
      hosted: true,
      // The track wants the whole screen — see .container.wide.
      wide: true,
      drinkingRule: 'Last place drinks — or, in harder mode, drink once per horse that beat yours.',
      component: window.GameHorseRace,
    },
  ];

  window.Games = {
    registry,
    byId: (id) => registry.find((g) => g.id === id) || null,
    // Games registered after this file loads (kept for the later steps).
    register(def) {
      const i = registry.findIndex((g) => g.id === def.id);
      if (i >= 0) registry[i] = def; else registry.push(def);
    },
  };
})();
