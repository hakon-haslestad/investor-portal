// Bank rule engine for the accounting tab. Pure functions, no DOM: DNB bank
// lines in, proposed bilag out, plus a comparison with the ledger (HB) of a
// closed year. Rules are data (accounts only); amounts always come from the
// row. Automatic rules, not accountant-reviewed.
//
// Modes: A = automatic, R = booked but marked for review, H = a human decides
// (the engine only suggests accounts).

(function () {
  const RULES = {
    dnb: [
      { id: 'D1', when: { type: ['Giro', 'Overføring innland'], dir: 'in', payer: 'member' }, mode: 'A', lines: [['D', 1920, 'amt'], ['C', 2250, 'amt']] },
      { id: 'D2', when: { type: ['Giro'], dir: 'out', text: 'nordnet~' }, mode: 'A', lines: [['D', 1921, 'amt'], ['C', 1920, 'amt']] },
      // The fee account is open (Q100): marked "to confirm" wherever it shows.
      { id: 'D3', when: { type: ['Omkostninger'], dir: 'out' }, mode: 'A', feeToConfirm: true, lines: [['D', 7700, 'amt'], ['C', 1920, 'amt']] },
      { id: 'D4', when: { dir: 'out', else: true }, mode: 'H', suggest: [8179, 7798, 2400], lines: [['C', 1920, 'amt']] },
      { id: 'D5', when: { dir: 'in', else: true }, mode: 'H', suggest: [8050, 2000, 2020], lines: [['D', 1920, 'amt']] },
    ],
  };
  const RULE = Object.fromEntries(RULES.dnb.map((r) => [r.id, r]));
  const BANK = 1920;

  const cents = (n) => Math.round(Number(n) * 100 + 1e-7);
  const money = (c) => c / 100;

  function normalize(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z]+/g, ' ')
      .trim();
  }
  const tokens = (text) => { const n = normalize(text); return n ? n.split(' ') : []; };

  function lev(a, b) {
    const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const keep = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = keep;
      }
    }
    return prev[b.length];
  }

  function buildAliases(rows) {
    return (rows || []).map((r) => ({ code: String(r.code || '').trim(), tokens: tokens(r.alias) }))
      .filter((a) => a.code && a.tokens.length);
  }
  function aliasesFromMembers(members) {
    return buildAliases((members || []).map((m) => ({ code: m.investorCode, alias: m.displayName })));
  }

  // Aliases tab: header row has "code" and "alias"; rows with either blank are skipped.
  function parseAliases(rows) {
    const h = (rows || []).findIndex((r) => (r || []).some((c) => String(c).trim().toLowerCase() === 'alias'));
    if (h < 0) return [];
    const head = rows[h].map((c) => String(c == null ? '' : c).trim().toLowerCase());
    const iCode = head.indexOf('code'), iAlias = head.indexOf('alias');
    if (iCode < 0) return [];
    const out = [];
    for (let r = h + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const code = String(row[iCode] == null ? '' : row[iCode]).trim();
      const alias = String(row[iAlias] == null ? '' : row[iAlias]).trim();
      if (code && alias) out.push({ code, alias });
    }
    return out;
  }

  // exact: every alias token is a token of the text. fuzzy: each alias token
  // is within one edit of a text token (tokens of 4+ letters only). Two
  // different members at the same level make it unknown rather than a guess.
  function matchMember(text, aliases) {
    const t = tokens(text);
    if (!t.length) return null;
    const set = new Set(t);
    let best = null, tie = false;
    for (const a of aliases || []) {
      let kind = null;
      if (a.tokens.every((x) => set.has(x))) kind = 'exact';
      else if (a.tokens.every((x) => set.has(x) || (x.length >= 4 && t.some((y) => y.length >= 4 && lev(x, y) <= 1)))) kind = 'fuzzy';
      if (!kind) continue;
      const score = (kind === 'exact' ? 100 : 0) + a.tokens.length;
      if (!best || score > best.score) { best = { code: a.code, kind, score }; tie = false; }
      else if (score === best.score && a.code !== best.code) tie = true;
    }
    return best && !tie ? { code: best.code, kind: best.kind } : null;
  }

  function isNordnet(text) {
    return tokens(text).some((t) => t.length >= 5 && (t.includes('nordnet') || lev(t, 'nordnet') <= 2));
  }

  const typeIs = (type, list) => list.some((x) => normalize(x) === normalize(type));

  function lineSet(rule, amount) {
    return rule.lines.map(([side, account]) => ({ side, account, amount }));
  }

  function classify(row, aliases) {
    const inn = Number(row.inn) || 0, ut = Number(row.ut) || 0;
    const out = { rule: null, mode: 'H', lines: [], member: null, suggest: [], reason: null, feeToConfirm: false, flags: [], dir: null, amount: 0 };
    const dir = inn > 0 ? 'in' : (ut > 0 ? 'out' : null);
    if (!dir) return { ...out, reason: 'noAmount' };
    const amount = money(cents(dir === 'in' ? inn : ut));
    Object.assign(out, { dir, amount });
    const give = (rule, extra) => Object.assign(out, { rule: rule.id, mode: rule.mode, lines: lineSet(rule, amount), suggest: rule.suggest || [] }, extra);

    if (dir === 'in') {
      if (typeIs(row.type, RULE.D1.when.type)) {
        const m = matchMember(row.text, aliases);
        if (!m) return Object.assign(out, { rule: 'D1', mode: 'H', reason: 'unknownPayer' });
        return give(RULE.D1, { mode: m.kind === 'exact' ? 'A' : 'R', member: m.code, flags: m.kind === 'exact' ? [] : ['review'] });
      }
      return Object.assign(out, { rule: 'D5', mode: 'H', suggest: RULE.D5.suggest, reason: 'otherIn' });
    }
    if (typeIs(row.type, RULE.D2.when.type) && isNordnet(row.text)) return give(RULE.D2);
    if (typeIs(row.type, RULE.D3.when.type)) return give(RULE.D3, { feeToConfirm: true, flags: ['feeToConfirm'] });
    return Object.assign(out, { rule: 'D4', mode: 'H', suggest: RULE.D4.suggest, reason: 'otherOut' });
  }

  function run(rows, aliases) {
    const bilag = [], unclassified = [];
    for (const row of rows || []) {
      const c = classify(row, aliases);
      if (c.lines.length) {
        bilag.push({ rule: c.rule, mode: c.mode, date: row.date, text: row.text, lines: c.lines, member: c.member, flags: c.flags, amount: c.amount });
      } else {
        unclassified.push({ row, rule: c.rule, reason: c.reason, suggest: c.suggest });
      }
    }
    return { bilag, unclassified };
  }

  // ─── Rules against the books ────────────────────────────────────────────
  // Each bank line is paired with one line on 1920 in the ledger (same date,
  // same cents, same direction), each ledger line used once. A line "goes to
  // the same account" when our single counter account equals the books'.
  function compareWithBooks(rows, hb, aliases) {
    const list = rows || [];
    const groups = { unknownPayer: [], fee: [], other: [] };
    if (!hb || !hb.length) return { total: list.length, same: 0, groups, booksOnly: [], noLedger: true };

    const byBilag = new Map();
    for (const l of hb) {
      if (!byBilag.has(l.bilagsnr)) byBilag.set(l.bilagsnr, []);
      byBilag.get(l.bilagsnr).push(l);
    }
    const entries = [];
    for (const [nr, lines] of byBilag) {
      const counters = [...new Set(lines.filter((l) => l.kontonr !== BANK).map((l) => l.kontonr))];
      for (const l of lines) {
        if (l.kontonr !== BANK) continue;
        const dir = l.debet ? 'in' : 'out';
        // The real ledger writes credits as negative numbers; compare amounts only.
        const amt = cents(Math.abs(l.debet || l.kredit || 0));
        entries.push({ nr, date: l.date, dir, amt, counters, key: `${l.date}|${dir}|${amt}`, used: false });
      }
    }
    const classified = list.map((row) => {
      const c = classify(row, aliases);
      const our = c.lines.length ? String(c.lines.find((x) => x.account !== BANK).account) : null;
      return { row, c, our, key: c.dir ? `${row.date}|${c.dir}|${cents(c.amount)}` : null, hit: null };
    });
    const take = (item, wantOur) => {
      const e = entries.find((x) => !x.used && x.key === item.key && (!wantOur || (x.counters.length === 1 && String(x.counters[0]) === item.our)));
      if (e) { e.used = true; item.hit = e; }
    };
    classified.filter((i) => i.key && i.our).forEach((i) => take(i, true));
    classified.filter((i) => i.key && !i.hit).forEach((i) => take(i, false));

    let same = 0;
    for (const i of classified) {
      const books = i.hit ? i.hit.counters.join(', ') : 'none';
      if (i.our && i.hit && i.hit.counters.length === 1 && String(i.hit.counters[0]) === i.our) { same += 1; continue; }
      const item = {
        date: i.row.date, text: i.row.text, amount: i.c.amount,
        ours: i.our || (i.c.suggest.length ? i.c.suggest.join(', ') : 'none'),
        books, bilagsnr: i.hit ? i.hit.nr : null,
      };
      if (i.c.reason === 'unknownPayer') { item.ours = 'none'; groups.unknownPayer.push(item); }
      else if (i.c.rule === 'D3' && i.hit) groups.fee.push(item);
      else groups.other.push(item);
    }
    const booksOnly = entries.filter((e) => !e.used)
      .map((e) => ({ date: e.date, bilagsnr: e.nr, amount: money(e.amt), dir: e.dir, books: e.counters.join(', ') }));
    return { total: list.length, same, groups, booksOnly, noLedger: false };
  }

  window.BankRules = { RULES, normalize, buildAliases, aliasesFromMembers, parseAliases, matchMember, isNordnet, classify, run, compareWithBooks };
})();
