const test = require('node:test');
const assert = require('node:assert');
const { context, load } = require('./harness');

function ctx() {
  const w = context(['games/rng.js']);
  load(w, 'games/odd-one-out-rules.js');
  return w;
}

// A trade shaped like a refined pool row.
function T(over = {}) {
  return {
    security: over.security || 'Stock',
    investors: over.investors || [{ code: 'HH', name: 'Hakon' }],
    investorName: 'Hakon',
    pnlNok: 0, pnlPct: 0, purchaseAmount: 1000, currentOrSoldValue: 1000,
    sold: false, firstDate: '2024-01-08', lastDate: '2024-06-01', exchange: 'OSL',
    ...over,
  };
}

test('isoWeek is ISO 8601, including the year boundary', () => {
  const { OddOneOutRules: R } = ctx();
  assert.equal(R.isoWeek('2024-01-04'), '2024-W01');
  assert.equal(R.isoWeek('2024-01-08'), '2024-W02');
  // 2023-01-01 is a Sunday, which ISO puts in the last week of 2022.
  assert.equal(R.isoWeek('2023-01-01'), '2022-W52');
  assert.equal(R.isoWeek(null), null);
  assert.equal(R.isoWeek('nonsense'), null);
});

// The core contract: a rule yields a VALID set or null. Never anything else.
test('every rule returns a valid set or null, across many random pools', () => {
  const w = ctx();
  const { OddOneOutRules: R, GameRng } = w;
  const owners = [['HH', 'Hakon'], ['JC', 'Jonas'], ['ØS', 'Øystein']];
  const exchanges = ['OSL', 'STO', 'ETR'];

  for (let seed = 1; seed <= 200; seed++) {
    const rng = GameRng(seed);
    const n = 4 + rng.int(12);
    const trades = [...Array(n)].map((_, i) => {
      const o = rng.pick(owners);
      const sameDay = rng.next() < 0.2;
      const d = `2024-0${1 + rng.int(6)}-${String(1 + rng.int(28)).padStart(2, '0')}`;
      return T({
        security: `S${i}`,
        investors: rng.next() < 0.25
          ? [{ code: o[0], name: o[1] }, { code: 'HF', name: 'Hans' }]
          : [{ code: o[0], name: o[1] }],
        pnlNok: Math.round((rng.next() - 0.5) * 20000),
        sold: rng.next() < 0.5,
        firstDate: d,
        lastDate: sameDay ? d : '2024-09-01',
        exchange: rng.pick(exchanges),
      });
    });

    for (const rule of R.RULES) {
      const set = rule.pick(trades, GameRng(seed + 1000));
      if (set === null) continue;
      assert.equal(set.three.length, 3, `${rule.id} seed ${seed}: three items`);
      assert.ok(set.odd, `${rule.id} seed ${seed}: has an odd one`);
      assert.ok(!set.three.includes(set.odd), `${rule.id} seed ${seed}: odd one is not among the three`);
      assert.equal(new Set(set.three).size, 3, `${rule.id} seed ${seed}: three are distinct`);
      // And the rule must actually hold.
      if (rule.id === 'all-winners') {
        assert.ok(set.three.every((t) => t.pnlNok > 0) && !(set.odd.pnlNok > 0), 'all-winners holds');
      }
      if (rule.id === 'all-losers') {
        assert.ok(set.three.every((t) => t.pnlNok < 0) && !(set.odd.pnlNok < 0), 'all-losers holds');
      }
      if (rule.id === 'never-sold') {
        assert.ok(set.three.every((t) => t.sold === false) && set.odd.sold !== false, 'never-sold holds');
      }
      if (rule.id === 'same-exchange') {
        assert.equal(new Set(set.three.map((t) => t.exchange)).size, 1, 'three share an exchange');
        assert.notEqual(set.odd.exchange, set.three[0].exchange, 'odd one differs');
      }
      if (rule.id === 'same-player') {
        const codes = set.three.map((t) => t.investors[0].code);
        assert.equal(set.three.every((t) => t.investors.length === 1), true, 'three are solely owned');
        assert.equal(new Set(codes).size, 1, 'three share an owner');
        assert.notEqual(set.odd.investors[0].code, codes[0], 'odd one has another owner');
      }
      if (rule.id === 'same-week') {
        assert.equal(new Set(set.three.map((t) => R.isoWeek(t.firstDate))).size, 1, 'three share a week');
        assert.notEqual(R.isoWeek(set.odd.firstDate), R.isoWeek(set.three[0].firstDate), 'odd week differs');
      }
      if (rule.id === 'held-under-day') {
        assert.ok(set.three.every((t) => t.firstDate === t.lastDate && t.sold), 'three are same-day round trips');
        assert.ok(!(set.odd.firstDate === set.odd.lastDate && set.odd.sold), 'odd one is not');
      }
    }
  }
});

test('same-player ignores co-owned stocks, which have no single owner', () => {
  const w = ctx();
  const trades = [
    T({ security: 'A', investors: [{ code: 'HH', name: 'H' }, { code: 'JC', name: 'J' }] }),
    T({ security: 'B', investors: [{ code: 'HH', name: 'H' }, { code: 'JC', name: 'J' }] }),
    T({ security: 'C', investors: [{ code: 'HH', name: 'H' }, { code: 'JC', name: 'J' }] }),
    T({ security: 'D', investors: [{ code: 'JC', name: 'J' }] }),
  ];
  const rule = w.OddOneOutRules.RULES.find((r) => r.id === 'same-player');
  assert.equal(rule.pick(trades, w.GameRng(1)), null, 'three co-owned rows are not "the same player"');
});

test('a rule with nothing to contrast against returns null', () => {
  const w = ctx();
  const R = w.OddOneOutRules;
  const allWinners = [T({ pnlNok: 10 }), T({ pnlNok: 20 }), T({ pnlNok: 30 }), T({ pnlNok: 40 })];
  assert.equal(R.RULES.find((r) => r.id === 'all-winners').pick(allWinners, w.GameRng(1)), null,
    'no loser to be the odd one out');
  const allOsl = [T({ exchange: 'OSL' }), T({ exchange: 'OSL' }), T({ exchange: 'OSL' }), T({ exchange: 'OSL' })];
  assert.equal(R.RULES.find((r) => r.id === 'same-exchange').pick(allOsl, w.GameRng(1)), null);
});

test('missing metadata is skipped, not grouped as empty', () => {
  const w = ctx();
  const trades = [
    T({ exchange: '' }), T({ exchange: '' }), T({ exchange: '' }), T({ exchange: 'STO' }),
  ];
  const rule = w.OddOneOutRules.RULES.find((r) => r.id === 'same-exchange');
  assert.equal(rule.pick(trades, w.GameRng(1)), null, 'three blank exchanges are not a shared exchange');
});

test('buildRound produces four shuffled cards whose answer points at the odd one', () => {
  const w = ctx();
  const trades = [
    T({ security: 'A', pnlNok: 100 }), T({ security: 'B', pnlNok: 200 }),
    T({ security: 'C', pnlNok: 300 }), T({ security: 'D', pnlNok: -50 }),
    T({ security: 'E', pnlNok: 400 }), T({ security: 'F', pnlNok: -10 }),
  ];
  for (let seed = 1; seed <= 50; seed++) {
    const round = w.OddOneOutRules.buildRound(trades, w.GameRng(seed));
    assert.ok(round, `seed ${seed} produced a round`);
    assert.equal(round.cards.length, 4);
    assert.ok(round.answer >= 0 && round.answer < 4, 'answer indexes a card');
    assert.equal(new Set(round.cards).size, 4, 'four distinct cards');
    assert.ok(round.description.length > 0);
    assert.ok(Array.isArray(round.hideFields));
  }
});

test('buildRound is reproducible from its seed', () => {
  const w = ctx();
  const trades = [...Array(10)].map((_, i) => T({ security: `S${i}`, pnlNok: i % 3 === 0 ? -100 : 100 }));
  const a = w.OddOneOutRules.buildRound(trades, w.GameRng(99));
  const b = w.OddOneOutRules.buildRound(trades, w.GameRng(99));
  assert.equal(a.ruleId, b.ruleId);
  assert.equal(a.answer, b.answer);
  assert.deepEqual(a.cards.map((c) => c.security), b.cards.map((c) => c.security));
});

test('buildRound avoids repeating the previous rule when another is viable', () => {
  const w = ctx();
  // Winners, losers and two exchanges — several rules can fire.
  const trades = [...Array(12)].map((_, i) => T({
    security: `S${i}`, pnlNok: i % 2 ? 100 : -100,
    exchange: i % 3 ? 'OSL' : 'STO', sold: i % 4 === 0,
  }));
  for (let seed = 1; seed <= 30; seed++) {
    const first = w.OddOneOutRules.buildRound(trades, w.GameRng(seed));
    const second = w.OddOneOutRules.buildRound(trades, w.GameRng(seed + 500), first.ruleId);
    assert.notEqual(second.ruleId, first.ruleId, `seed ${seed} repeated ${first.ruleId}`);
  }
});

test('buildRound returns null rather than throwing on a thin or empty pool', () => {
  const w = ctx();
  const R = w.OddOneOutRules;
  assert.equal(R.buildRound([], w.GameRng(1)), null);
  assert.equal(R.buildRound([T(), T(), T()], w.GameRng(1)), null, 'three trades cannot fill four cards');
  assert.equal(R.buildRound(null, w.GameRng(1)), null);
  // Four identical trades: no rule can separate them.
  const same = [T(), T(), T(), T()];
  assert.equal(R.buildRound(same, w.GameRng(1)), null);
});

test('no rule leaves the field it keys on visible on the cards', () => {
  const { OddOneOutRules: R } = ctx();
  for (const rule of R.RULES) {
    const leak = R.RULE_LEAKS[rule.id];
    assert.ok(leak !== undefined, `${rule.id} is not declared in RULE_LEAKS`);
    if (leak) {
      assert.ok(rule.hideFields.includes(leak),
        `${rule.id} keys on "${leak}" but does not hide it — the board would print the answer`);
    }
  }
});

test('every hidden field is one the board actually renders', () => {
  const { OddOneOutRules: R } = ctx();
  const known = new Set(R.CARD_FIELDS.concat(['exchange', 'ticker']));
  for (const rule of R.RULES) {
    for (const f of rule.hideFields) {
      assert.ok(known.has(f), `${rule.id} hides unknown field "${f}"`);
    }
  }
});

test('same-sector is deliberately absent — the sheet has no sector column', () => {
  const { OddOneOutRules: R } = ctx();
  assert.equal(R.RULES.find((r) => r.id === 'same-sector'), undefined);
  assert.ok(R.RULES.find((r) => r.id === 'same-exchange'), 'same-exchange is implemented instead');
});
