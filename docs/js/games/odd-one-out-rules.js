// Odd One Out — the rule table. Pure: no DOM, no globals beyond what is
// passed in, so every rule is unit-testable.
//
// A rule takes the filtered trades plus a seeded RNG and returns
//   { three, odd, value, ruleId } | null
// `null` means "cannot produce a valid set from these trades" — the caller
// tries the next rule. Every rule MUST return null rather than a degenerate
// set, because a malformed board is worse than no board.
//
// hideFields names the card fields that would give the answer away. The board
// masks them, so e.g. a same-player round never prints an owner.

(function () {
  // ISO week key, e.g. "2024-W09". Thursday-based, per ISO 8601.
  function isoWeek(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return null;
    const day = (d.getUTCDay() + 6) % 7;          // Mon=0 … Sun=6
    d.setUTCDate(d.getUTCDate() - day + 3);        // the Thursday of this week
    const year = d.getUTCFullYear();
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4day = (jan4.getUTCDay() + 6) % 7;
    const week1Thu = new Date(jan4);
    week1Thu.setUTCDate(jan4.getUTCDate() - jan4day + 3);
    const week = 1 + Math.round((d - week1Thu) / (7 * 86400000));
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  // Group items by a key, skipping those the key function rejects (null).
  function groupBy(items, keyFn) {
    const m = new Map();
    for (const it of items) {
      const k = keyFn(it);
      if (k == null || k === '') continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    }
    return m;
  }

  // The shape every rule shares: find a key with >= 3 items and at least one
  // item under a DIFFERENT key to be the odd one out.
  function pickGrouped(items, keyFn, rng) {
    const groups = groupBy(items, keyFn);
    const big = [...groups.entries()].filter(([, v]) => v.length >= 3);
    if (!big.length) return null;
    for (const [key, members] of rng.shuffle(big)) {
      const others = items.filter((it) => {
        const k = keyFn(it);
        return k != null && k !== '' && k !== key;
      });
      if (!others.length) continue;
      return { three: rng.shuffle(members).slice(0, 3), odd: rng.pick(others), value: key };
    }
    return null;
  }

  // Split on a predicate: three that satisfy it, one that does not.
  function pickSplit(items, predicate, rng) {
    const yes = items.filter(predicate);
    const no = items.filter((it) => !predicate(it));
    if (yes.length < 3 || !no.length) return null;
    return { three: rng.shuffle(yes).slice(0, 3), odd: rng.pick(no), value: null };
  }

  // A trade is attributable to one player only when a single investor owns it;
  // the pool merges co-owned stocks, so those are ambiguous for same-player.
  const soleOwner = (t) => (t.investors && t.investors.length === 1 ? t.investors[0].code : null);
  const soleOwnerName = (t) => (t.investors && t.investors.length === 1 ? t.investors[0].name : null);

  const RULES = [
    {
      id: 'same-player',
      hideFields: ['owner'],
      pick: (trades, rng) => pickGrouped(trades.filter(soleOwner), soleOwner, rng),
      describe: (set) => {
        const n = soleOwnerName(set.three[0]) || set.value;
        return `Three of these were bought by ${n}.`;
      },
    },
    {
      id: 'same-week',
      hideFields: ['dates'],
      pick: (trades, rng) => pickGrouped(trades, (t) => isoWeek(t.firstDate), rng),
      describe: (set) => `Three of these were opened in the same week (${set.value}).`,
    },
    {
      id: 'all-winners',
      hideFields: ['return'],
      pick: (trades, rng) => pickSplit(trades, (t) => (t.pnlNok || 0) > 0, rng),
      describe: () => 'Three of these made money. One did not.',
    },
    {
      id: 'all-losers',
      hideFields: ['return'],
      pick: (trades, rng) => pickSplit(trades, (t) => (t.pnlNok || 0) < 0, rng),
      describe: () => 'Three of these lost money. One did not.',
    },
    {
      id: 'same-exchange',
      // The ticker carries its exchange suffix (.OL, .ST), so hide it too.
      hideFields: ['exchange', 'ticker'],
      pick: (trades, rng) => pickGrouped(trades, (t) => t.exchange || null, rng),
      describe: (set) => `Three of these trade on ${set.value}.`,
    },
    {
      id: 'held-under-day',
      hideFields: ['dates'],
      // Daily closes are all we have, so "under a day" can only honestly mean
      // bought and sold on the same date. Often yields nothing — that is fine.
      pick: (trades, rng) => pickSplit(
        trades, (t) => !!t.firstDate && t.firstDate === t.lastDate && t.sold, rng),
      describe: () => 'Three of these were bought and sold the same day.',
    },
    {
      id: 'never-sold',
      hideFields: ['status'],
      pick: (trades, rng) => pickSplit(trades, (t) => t.sold === false, rng),
      describe: () => 'Three of these we still hold. One is closed.',
    },
    // same-sector is deliberately absent: the Securities tab has `exchange`
    // but no `sector` (apps-script Code.gs SEC_HEADERS), and the brief says
    // do not guess sectors. Adding a sector column would enable it here.
  ];

  // Build a round. `avoidRuleId` keeps the same rule from coming up twice in a
  // row while another one is viable.
  function buildRound(trades, rng, avoidRuleId) {
    if (!Array.isArray(trades) || trades.length < 4) return null;
    const order = rng.shuffle(RULES);
    const preferred = order.filter((r) => r.id !== avoidRuleId);
    for (const rule of preferred.concat(order.filter((r) => r.id === avoidRuleId))) {
      const set = rule.pick(trades, rng);
      if (!set) continue;
      // Guard against a rule handing back the odd one inside its own three.
      if (set.three.some((t) => t === set.odd)) continue;
      if (set.three.length !== 3) continue;
      const cards = rng.shuffle(set.three.concat([set.odd]));
      return {
        ruleId: rule.id,
        hideFields: rule.hideFields,
        description: rule.describe(set),
        cards,
        answer: cards.indexOf(set.odd),
        value: set.value,
      };
    }
    return null;
  }

  // The fields the board prints on each card. Kept here so a rule and the
  // board cannot drift apart about what "hidden" covers.
  const CARD_FIELDS = ['owner', 'return', 'dates', 'status'];

  // What each rule keys on, and therefore must hide. A rule that groups by a
  // field the board prints would show the player its own answer.
  const RULE_LEAKS = {
    'same-player': 'owner',
    'same-week': 'dates',
    'all-winners': 'return',
    'all-losers': 'return',
    'same-exchange': null,      // exchange is not a printed field
    'held-under-day': 'dates',
    'never-sold': 'status',
  };

  window.OddOneOutRules = {
    RULES, buildRound, isoWeek, groupBy, pickGrouped, pickSplit,
    CARD_FIELDS, RULE_LEAKS,
  };
})();
