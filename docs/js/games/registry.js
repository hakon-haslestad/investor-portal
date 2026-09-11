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
//   drinkingRule  shown only when sober mode is off
//   component   { mount(el, props) -> { newRound?, destroy? } }
//
// GameProps (what component.mount receives):
//   trades      already filtered by period + competition
//   players     players in the selected competition, else all members
//   soberMode   boolean
//   pool        the GamePool context (price series, holding text, …)
//   rng         seedable RNG — games must never call Math.random
//   history     GameShell.history, scoped by the caller
//   competitionId

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
      tagline: 'Same draw, name hidden. Call it before the reveal.',
      rules: `<p>A random position is dealt face-down: you get the price chart and nothing else.</p>
              <p>Whose is it? Did it go up or down? Say it out loud, then hit Reveal.</p>
              <p class="text-muted text-small">Honour system — nothing is scored.</p>`,
      tags: ['party'],
      players: '2+',
      minTrades: 1,
      drinkingRule: 'Everyone who called it wrong drinks.',
      component: window.GameSpinTheStock({ guess: true }),
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
