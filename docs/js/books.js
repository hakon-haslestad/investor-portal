// Calculated books: the company's accounts worked out from the raw data in the
// portfolio sheet (DNB_raw, Rådata fra nordnet, StockPrices) instead of read
// from a separate accounting workbook. This file starts with the one thing raw
// data cannot give: the "Accounting inputs" tab (opening balance, manual
// decisions, the accountant's year-end entries). Pure; no DOM, no network.

(function () {
  const { numOrNull, excelDateToISO } = window.Parsers;

  const INPUTS_TAB = 'Accounting inputs';
  const KINDS = ['IB', 'DECIDE', 'SPLIT', 'REALISE', 'ENTRY', 'PRICE'];

  // NS 4102 accounts are four digits, 1000-8999.
  function isAccount(n) { return Number.isInteger(n) && n >= 1000 && n <= 8999; }

  // Sheet numbers may arrive as numbers or as Norwegian text ("1 000,50").
  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (v == null || v === '') return null;
    return numOrNull(String(v).replace(/[\s ]/g, '').replace(',', '.'));
  }
  // 01.03.2031 as well as the formats excelDateToISO knows.
  function date(v) {
    const m = typeof v === 'string' && v.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const iso = excelDateToISO(v);
    return iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
  }

  // Rows: column A is the kind, then the kind's own columns, last a free note.
  //   IB       account, amount              opening balance, first calculated year
  //   DECIDE   date, amount, account        a bank line the rules cannot decide
  //   SPLIT    security, share (0-1), parent, cost   parent's cost moved to a
  //            spin-off: share of the parent's cost, or a typed cost instead
  //   REALISE  security, year, (no)         realise what is left at 31.12 of
  //            that year (a worthless holding); "no" keeps that year's
  //            redemption unrealised instead (redemptions are realised by default)
  //   ENTRY    year, account, debet, kredit the accountant's year-end entries
  //   PRICE    security, year, price        the 31.12 price per share in NOK the
  //            books use, in place of StockPrices
  // A row that does not make sense is reported, never used half-way.
  function parseInputs(rows) {
    const out = { ib: new Map(), decide: [], split: [], realise: [], entries: [], prices: [], problems: [] };
    (rows || []).forEach((row, i) => {
      const kind = String((row || [])[0] == null ? '' : row[0]).trim().toUpperCase();
      if (!kind || kind.startsWith('#') || kind === 'KIND') return;
      const r = row.slice(1);
      const at = i + 1;
      const bad = (reason) => out.problems.push({ row: at, kind, reason });
      if (!KINDS.includes(kind)) {
        // A title row (one text cell, nothing else) is not a mistake.
        if (r.every((c) => c == null || c === '')) return;
        return bad(`row ${at}: unknown kind "${kind}" (use ${KINDS.join(', ')})`);
      }
      if (kind === 'IB') {
        const account = num(r[0]), amount = num(r[1]);
        if (!isAccount(account)) return bad(`row ${at}: ${r[0]} is not an account (NS 4102, 1000-8999)`);
        if (amount == null) return bad(`row ${at}: IB ${account} has no amount`);
        out.ib.set(account, (out.ib.get(account) || 0) + amount);
      } else if (kind === 'DECIDE') {
        const d = date(r[0]), amount = num(r[1]), account = num(r[2]);
        if (!d) return bad(`row ${at}: DECIDE needs a date (2031-03-01 or 01.03.2031)`);
        if (amount == null) return bad(`row ${at}: DECIDE ${d} has no amount`);
        if (!isAccount(account)) return bad(`row ${at}: ${r[2]} is not an account (NS 4102, 1000-8999)`);
        out.decide.push({ date: d, amount: Math.abs(amount), account, note: r[4] || r[3] || '' });
      } else if (kind === 'SPLIT') {
        const security = String(r[0] == null ? '' : r[0]).trim(), share = num(r[1]), cost = num(r[3]);
        const parent = String(r[2] == null ? '' : r[2]).trim();
        if (!security) return bad(`row ${at}: SPLIT needs a security`);
        if (cost == null && (share == null || share <= 0 || share >= 1)) return bad(`row ${at}: SPLIT share must be between 0 and 1, e.g. 0.25 (or give a cost)`);
        if (cost != null && cost < 0) return bad(`row ${at}: SPLIT cost cannot be negative`);
        out.split.push({ security, share: cost != null ? null : share, cost, parent: parent || null });
      } else if (kind === 'REALISE') {
        const security = String(r[0] == null ? '' : r[0]).trim(), year = num(r[1]);
        const keep = /^(no|nei|keep)$/i.test(String(r[2] == null ? '' : r[2]).trim());
        if (!security) return bad(`row ${at}: REALISE needs a security`);
        if (!Number.isInteger(year)) return bad(`row ${at}: REALISE ${security} needs a year`);
        out.realise.push({ security, year, keep });
      } else if (kind === 'PRICE') {
        const security = String(r[0] == null ? '' : r[0]).trim(), year = num(r[1]), price = num(r[2]);
        if (!security) return bad(`row ${at}: PRICE needs a security`);
        if (!Number.isInteger(year)) return bad(`row ${at}: PRICE ${security} needs a year`);
        if (price == null || price < 0) return bad(`row ${at}: PRICE ${security} ${year} needs a price per share (NOK)`);
        out.prices.push({ security, year, price });
      } else if (kind === 'ENTRY') {
        const year = num(r[0]), account = num(r[1]), debet = num(r[2]) || 0, kredit = num(r[3]) || 0;
        if (!Number.isInteger(year)) return bad(`row ${at}: ENTRY needs a year`);
        if (!isAccount(account)) return bad(`row ${at}: ${r[1]} is not an account (NS 4102, 1000-8999)`);
        if (!debet && !kredit) return bad(`row ${at}: ENTRY ${account} has neither debet nor kredit`);
        out.entries.push({ row: at, year, account, debet: Math.abs(debet), kredit: Math.abs(kredit), note: r[4] || '' });
      }
    });
    // Each year's entries must balance, or the trial balance cannot.
    const byYear = new Map();
    for (const e of out.entries) byYear.set(e.year, (byYear.get(e.year) || 0) + e.debet - e.kredit);
    for (const [year, diff] of byYear) {
      if (Math.abs(diff) >= 0.005) {
        out.problems.push({ row: null, kind: 'ENTRY', reason: `ENTRY rows for ${year} do not balance (debet - kredit = ${Math.round(diff * 100) / 100})` });
        out.entries = out.entries.filter((e) => e.year !== year);
      }
    }
    return out;
  }

  // Nordnet rows for the year checks, taken from the portfolio sheet's
  // "Rådata fra nordnet" (already loaded by Store) instead of a copy in a
  // second sheet. Same shape as Accounting.parseNordnetRaw.
  function nordnetFromTransactions(transactions) {
    return (transactions || []).map((t) => {
      const date = t.bookDate || t.tradeDate || null;
      return { year: date ? Number(date.slice(0, 4)) : null, date, type: t.type || '', security: t.security || null, qty: t.qty, amount: t.amount };
    }).filter((r) => r.year);
  }

  // ─── C2: bank vouchers of one year (the "Bank YY" tab) ──────────────────
  // Every DNB line of the year gets a number BA1, BA2, ... in bank-date order
  // (ties in file order), booked or not, so a number never moves when a
  // decision is added later. This matches the books' 2024 numbering on all
  // lines. A DECIDE input (same date, same amount) books the line to its
  // account and wins over a rule; otherwise the bank rules decide. Lines
  // neither can decide are listed with a ready-to-paste DECIDE row.
  const BANK = 1920;
  const cents = (n) => Math.round(Math.abs(Number(n) || 0) * 100);
  function voucherLines(lines) {
    return lines.map((l) => ({ account: l.account, debet: l.side === 'D' ? l.amount : 0, kredit: l.side === 'C' ? l.amount : 0 }));
  }

  function bankYear(dnbRows, aliases, inputs, year) {
    const R = window.BankRules;
    const rows = (dnbRows || []).filter((r) => r.year === year)
      .map((r, i) => ({ r, i })).sort((a, b) => (a.r.date || '').localeCompare(b.r.date || '') || a.i - b.i).map((x) => x.r);
    const decisions = ((inputs && inputs.decide) || []).filter((d) => d.date && d.date.slice(0, 4) === String(year)).map((d) => ({ ...d, used: false }));
    const vouchers = [], open = [];
    rows.forEach((row, n) => {
      const bilagsnr = `BA${n + 1}`;
      const c = R.classify(row, aliases);
      const amount = c.amount || Math.abs(Number(row.inn) || Number(row.ut) || 0);
      const d = c.dir && decisions.find((x) => !x.used && x.date === row.date && cents(x.amount) === cents(amount));
      let lines = null, source = 'rule';
      if (d) {
        d.used = true; source = 'manual';
        lines = c.dir === 'in'
          ? [{ side: 'D', account: BANK, amount }, { side: 'C', account: d.account, amount }]
          : [{ side: 'D', account: d.account, amount }, { side: 'C', account: BANK, amount }];
      } else if (c.lines.length) {
        lines = c.lines;
      }
      if (lines) {
        vouchers.push({ bilagsnr, date: row.date, text: row.text, rule: d ? 'DECIDE' : c.rule, source, member: d ? null : c.member,
          flags: d ? [] : (c.flags || []), amount, lines: voucherLines(lines), note: d ? d.note : '' });
      } else {
        const suggest = c.suggest || [];
        open.push({ bilagsnr, date: row.date, text: row.text, amount, dir: c.dir, reason: c.reason, suggest,
          paste: ['DECIDE', row.date, amount, suggest[0] || '', '', row.text || ''] });
      }
    });
    return { year, vouchers, open, unusedDecisions: decisions.filter((d) => !d.used) };
  }

  // ─── C3: Nordnet per year (the "Nordnet YY" tab) ────────────────────────
  // Lots per security replayed from Rådata fra nordnet up to 31.12, FIFO as
  // the books (or average cost for comparison). Cost of a buy is the cash
  // paid (fees included), proceeds of a sale the cash received. Swaps carry
  // cost and the oldest lot date; rights come in at zero cost; a spin-off
  // takes its cost from the parent through a SPLIT input, otherwise Nordnet's
  // Kjøpsverdi is used and flagged. A redemption is realised; a REALISE input
  // writes the rest of a position off at 31.12 of its year. Every row the
  // replay cannot place is a flag, never dropped silently.
  const SWAP_OUT = ['BYTTE UTTAK VP', 'BYTTE UTTAK VERDIPAPIR', 'SPLITT UTTAK VP'];
  const SWAP_IN = ['BYTTE INNLEGG VP', 'BYTE INLÄGG VP', 'SPLITT INNLEGG VP'];
  const SPINOFF = ['UTSKILLING FISJON IN', 'UTBYTTE INNLEGG VP'];
  const REDEEM = ['INNLØSN. UTTAK VP'];
  const RIGHTS_IN = ['TILDELING INNLEGG RE'];
  const RIGHTS_OUT = ['EMISJON UTTAK VP', 'SLETTING UTTAK VP', 'TEGNING UTTAK RETTER'];
  const AT_BROKER_VALUE = ['INNLEGG OVERFØRING', 'EMISJON INNLEGG VP'];
  const DIVIDEND = ['UTBYTTE', 'KUPONGSKATT'];
  const CASH_ONLY = ['INNSKUDD', 'DEBETRENTE', 'DEBETRENTE KORR', 'UTBYTTE', 'KUPONGSKATT', 'PLATTFORMAVGIFT',
    'UTTAK INTERNET', 'INNL. VP LIKVID', 'TEGNING LIKVID', 'TILBAKEBETALING'];
  const EPS = 1e-6;
  const r2 = (n) => Math.round(n * 100) / 100;

  function nordnetYear(transactions, priceAt, inputs, year, opts = {}) {
    const method = opts.method === 'avg' ? 'avg' : 'fifo';
    const nok = (t) => (window.Ledger ? window.Ledger.amountNok(t) : Number(t.amount) || 0);
    const end = `${year}-12-31`, ys = String(year);
    const lots = new Map();                       // security -> [{ qty, cost, date }]
    const events = [], flags = [];
    const held = (k) => (lots.get(k) || []).reduce((a, l) => a + l.qty, 0);
    const costOf = (k) => (lots.get(k) || []).reduce((a, l) => a + l.cost, 0);
    const add = (k, qty, cost, date) => { if (!lots.has(k)) lots.set(k, []); lots.get(k).push({ qty, cost, date }); };
    function take(k, qty, date, why) {
      const have = held(k);
      if (qty > have + EPS) { flags.push(`${date} ${why}: ${qty} of ${nameOf(k)} removed but only ${r2(have)} held`); qty = have; }
      const list = lots.get(k) || [];
      if (qty <= 0) return { cost: 0, removed: [] };
      if (method === 'avg') {
        const frac = qty / have, removed = list.map((l) => ({ qty: l.qty * frac, cost: l.cost * frac, date: l.date }));
        list.forEach((l) => { l.qty -= l.qty * frac; l.cost -= l.cost * frac; });
        lots.set(k, list.filter((l) => l.qty > EPS));
        return { cost: removed.reduce((a, l) => a + l.cost, 0), removed };
      }
      list.sort((a, b) => a.date.localeCompare(b.date));
      let need = qty, cost = 0; const removed = [], left = [];
      for (const l of list) {
        if (need <= EPS) { left.push(l); continue; }
        if (l.qty <= need + EPS) { cost += l.cost; need -= l.qty; removed.push({ ...l }); continue; }
        const part = l.cost * (need / l.qty);
        cost += part; removed.push({ qty: need, cost: part, date: l.date });
        left.push({ qty: l.qty - need, cost: l.cost - part, date: l.date }); need = 0;
      }
      lots.set(k, left);
      return { cost, removed };
    }

    // Nordnet exports newest first: same-day rows go in Id order, else file order.
    const byId = (a, b) => {
      const x = Number(a.t.nordnetId), y = Number(b.t.nordnetId);
      return Number.isFinite(x) && Number.isFinite(y) && x !== y ? x - y : a.i - b.i;
    };
    // Lots are kept per ISIN (a name can change without a swap row); rows and
    // inputs use the latest name. An input may name a security or its ISIN.
    // A name means what it meant up to 31.12 of this year (a later swap can
    // reuse it for a new ISIN); a name first seen later falls back to that.
    const names = new Map(), keyOfName = new Map(), laterKey = new Map();
    for (const t of transactions || []) {
      const k = t.isin || t.security;
      if (!k || !t.security) continue;
      if ((t.bookDate || t.tradeDate || '') > end) { laterKey.set(String(t.security).toLowerCase(), k); continue; }
      names.set(k, t.security); keyOfName.set(String(t.security).toLowerCase(), k);
    }
    const keyOf = (name) => (name == null ? null : keyOfName.get(String(name).toLowerCase()) || laterKey.get(String(name).toLowerCase()) || name);
    const nameOf = (k) => names.get(k) || k;
    const staleBefore = `${year}-12-24`;   // a year-end close older than a week is flagged
    const typedPrice = new Map(((inputs && inputs.prices) || []).filter((x) => x.year === year).map((x) => [keyOf(x.security), x.price]));
    const splits = ((inputs && inputs.split) || []).map((s) => ({ ...s, key: keyOf(s.security), parentKey: keyOf(s.parent), used: false }));
    const sorted = (transactions || []).map((t, i) => ({ t, i, d: t.bookDate || t.tradeDate || '' }))
      .filter((x) => x.d && x.d <= end)
      .sort((a, b) => a.d.localeCompare(b.d)
        || (SWAP_IN.includes(a.t.type) || SPINOFF.includes(a.t.type) ? 1 : 0) - (SWAP_IN.includes(b.t.type) || SPINOFF.includes(b.t.type) ? 1 : 0)
        || byId(a, b));
    const kept = new Set(((inputs && inputs.realise) || []).filter((x) => x.keep).map((x) => `${keyOf(x.security)}|${x.year}`));
    // Swap-outs waiting for their swap-in. Several can happen on one day (an
    // ISIN change for two holdings); a pair marked by Ledger.annotateConversionPairs
    // (_convId) is matched exactly, otherwise the oldest waiting one.
    const swaps = [];
    const dividends = new Map(), cash = { movement: 0, deposits: 0, withdrawals: 0, interest: 0, fees: 0, dividends: 0 };
    const totals = { bought: 0, sold: 0 };
    for (const { t, d } of sorted) {
      const ty = String(t.type || '').trim().toUpperCase(), k = t.isin || t.security || '';
      const qty = Math.abs(Number(t.qty) || 0), amount = nok(t), inYear = d.slice(0, 4) === ys;
      if (inYear) {
        cash.movement += amount;
        if (ty === 'INNSKUDD') cash.deposits += amount;
        else if (ty === 'UTTAK INTERNET') cash.withdrawals += amount;
        else if (ty.startsWith('DEBETRENTE')) cash.interest += amount;
        else if (ty === 'PLATTFORMAVGIFT') cash.fees += amount;
        else if (DIVIDEND.includes(ty)) { cash.dividends += amount; dividends.set(k, (dividends.get(k) || 0) + amount); }
      }
      if (ty === 'KJØPT' || (ty === 'TEGNING INNLEGG VP' && amount)) {
        add(k, qty, -amount, d);
        if (inYear) totals.bought += -amount;
      } else if (ty === 'SALG') {
        const { cost } = take(k, qty, d, 'SALG');
        events.push({ id: t.nordnetId, date: d, security: k, qty, proceeds: amount, cost, gain: amount - cost, kind: 'SALG' });
        if (inYear) totals.sold += amount;
      } else if (SWAP_OUT.includes(ty)) {
        const { cost, removed } = take(k, qty, d, ty);
        if (qty && !removed.length) { flags.push(`${d} ${ty}: nothing to move for ${nameOf(k)}`); continue; }
        swaps.push({ cost, removed, conv: t._convId, from: k });
      } else if (SWAP_IN.includes(ty)) {
        let at = t._convId != null ? swaps.findIndex((x) => x.conv === t._convId) : -1;
        if (at < 0) at = swaps.findIndex((x) => x.conv == null || t._convId == null);
        if (at < 0) at = swaps.length ? 0 : -1;
        if (at < 0) {
          const kv = Number(t.purchaseValue) || 0;
          if (kv) { flags.push(`${d} ${ty}: no swap-out for ${nameOf(k)}; Nordnet's Kjøpsverdi ${r2(kv)} used (check it)`); add(k, qty, kv, d); }
          else flags.push(`${d} ${ty}: no swap-out before ${nameOf(k)} (skipped; a double booking?)`);
          continue;
        }
        const out = swaps.splice(at, 1)[0];
        const first = out.removed.reduce((a, l) => (l.date < a ? l.date : a), d);
        add(k, qty, out.cost, first);
      } else if (RIGHTS_IN.includes(ty) || ty === 'TEGNING INNLEGG VP') {
        add(k, qty, 0, d);
      } else if (RIGHTS_OUT.includes(ty)) {
        take(k, qty, d, ty);
      } else if (SPINOFF.includes(ty)) {
        const s = splits.find((x) => !x.used && x.key === k);
        if (s && s.parent) {
          s.used = true;
          const total = costOf(s.parentKey), cost = s.cost != null ? Math.min(s.cost, total) : total * s.share;
          if (!total) flags.push(`${d} ${ty} ${nameOf(k)}: SPLIT parent ${s.parent} has no cost on that date`);
          const frac = total ? cost / total : 0;
          for (const l of lots.get(s.parentKey) || []) l.cost -= l.cost * frac;
          add(k, qty, cost, d);
        } else {
          const kv = Number(t.purchaseValue) || 0;
          flags.push(s
            ? `${d} ${ty} ${nameOf(k)}: the SPLIT row has no parent; Nordnet's Kjøpsverdi ${r2(kv)} used`
            : `${d} ${ty} ${nameOf(k)}: no SPLIT row; Nordnet's Kjøpsverdi ${r2(kv)} used and the parent's cost not reduced (add SPLIT ${nameOf(k)}, share, parent)`);
          add(k, qty, kv, d);
        }
      } else if (REDEEM.includes(ty)) {
        if (kept.has(`${k}|${d.slice(0, 4)}`)) continue;   // REALISE ... no: the holding stays, unrealised
        const { cost } = take(k, qty, d, ty);
        if (Math.abs(amount) > EPS || Math.abs(cost) > EPS) events.push({ id: t.nordnetId, date: d, security: k, qty, proceeds: amount, cost, gain: amount - cost, kind: 'INNLØSN' });
      } else if (AT_BROKER_VALUE.includes(ty)) {
        add(k, qty, Number(t.purchaseValue) || 0, d);
      } else if (!CASH_ONLY.includes(ty)) {
        flags.push(`${d} unknown Nordnet type ${ty || '(blank)'} (${nameOf(k) || 'no security'})`);
      }
    }
    for (const x of swaps) flags.push(`a swap-out of ${nameOf(x.from)} (${r2(x.cost)} in cost) has no swap-in before 31.12.${year}`);
    // A PRICE row for a security with no lots at 31.12 (a typo in the name) does nothing; say so.
    for (const x of ((inputs && inputs.prices) || []).filter((p) => p.year === year)) {
      if (!(held(keyOf(x.security)) > EPS)) flags.push(`PRICE ${x.security} ${year}: nothing of that security is held on 31.12 (a typo? use the ISIN)`);
    }
    // A SPLIT for a later year's spin-off is fine; one that matches no spin-off at all is a typo.
    const spunOff = new Set((transactions || []).filter((t) => SPINOFF.includes(String(t.type || '').trim().toUpperCase())).map((t) => t.isin || t.security));
    for (const s of splits) if (!s.used && !spunOff.has(s.key)) flags.push(`SPLIT ${s.security}: no spin-off of that security in Rådata fra nordnet`);
    for (const x of ((inputs && inputs.realise) || []).filter((x) => x.year === year && !x.keep)) {
      const k = keyOf(x.security), qty = held(k);
      if (qty <= EPS) {
        if (!events.some((e) => e.security === k && e.date.slice(0, 4) === ys)) flags.push(`REALISE ${x.security} ${year}: nothing held on 31.12`);
        continue;
      }
      const { cost } = take(k, qty, end, 'REALISE');
      events.push({ date: end, security: k, qty, proceeds: 0, cost, gain: -cost, kind: 'REALISE' });
    }

    const keys = new Set([...lots.keys()].filter((k) => held(k) > EPS));
    events.filter((e) => e.date.slice(0, 4) === ys).forEach((e) => keys.add(e.security));
    dividends.forEach((_, k) => k && keys.add(k));
    const rows = [...keys].map((k) => ({ k, security: nameOf(k) })).sort((a, b) => a.security.localeCompare(b.security)).map(({ k, security }) => {
      const qty = held(k), kost = qty > EPS ? costOf(k) : 0;
      let mv = 0, price = null;
      if (qty > EPS) {
        // priceAt may give a number or { nok, date, source } (Portfolio.yearEndPrice).
        const typed = typedPrice.get(k);
        const market = priceAt ? priceAt(security, k) : null;
        const got = typed != null ? { nok: typed, date: null, source: 'PRICE row' } : market;
        // A dotted decimal in a Norwegian-locale sheet turns into a date (25.7 ->
        // 25 July), which arrives as a day number near 46 000. Say so.
        if (typed != null) {
          const close = market == null ? null : Number(typeof market === 'object' ? market.nok : market);
          const looksLikeDate = Number.isInteger(typed) && typed >= 36000 && typed <= 73000;
          if (close > 0 && (typed > close * 3 || typed < close / 3)) {
            flags.push(`PRICE for ${security} ${year} is ${typed}, far from the close ${r2(close)}${looksLikeDate ? ' (a date? type the decimal with a comma)' : ''}: check the cell`);
          } else if (!(close > 0) && looksLikeDate) {
            flags.push(`PRICE for ${security} ${year} is ${typed}, which looks like a date: type the decimal with a comma, e.g. 25,7`);
          }
        }
        const px = got == null ? null : (typeof got === 'object' ? got : { nok: got, date: null, source: null });
        if (px == null || px.nok == null || !Number.isFinite(Number(px.nok))) { mv = null; flags.push(`price missing for ${security} on 31.12.${year} (${r2(qty)} held): add a PRICE row`); }
        else {
          mv = qty * Number(px.nok); price = px;
          if (px.date && px.date < staleBefore) flags.push(`price for ${security} is from ${px.date}${px.source === 'last own trade' ? ' (the last own trade; no market close)' : ''}, not the last week of ${year}: check it or add a PRICE row`);
        }
      }
      const realised = events.filter((e) => e.security === k && e.date.slice(0, 4) === ys).reduce((a, e) => a + e.gain, 0);
      return { security, isin: k !== security ? k : null, qty: r2(qty), kostpris: r2(kost), markedsverdi: mv == null ? null : r2(mv), urealisert: mv == null ? null : r2(mv - kost),
        realisert: r2(realised), utbytte: r2(dividends.get(k) || 0),
        pris: price ? Math.round(Number(price.nok) * 1e6) / 1e6 : null, prisDato: price ? price.date : null, prisKilde: price ? price.source : null };
    });
    Object.keys(cash).forEach((k) => { cash[k] = r2(cash[k]); });
    Object.keys(totals).forEach((k) => { totals[k] = r2(totals[k]); });
    return { year, method, rows, events: events.filter((e) => e.date.slice(0, 4) === ys).map((e) => ({ ...e, security: nameOf(e.security) })), cash, totals, flags };
  }

  // ─── C4: ledger and trial balance (the "HB, YY" and "SB, YY" tabs) ──────
  // HB = the bank vouchers (C2) + one Nordnet voucher per row of the year
  // (NN1, NN2, ...) + the year-end revaluation (GLV) + the ENTRY inputs (GLM).
  // SB = IB + the year's movement; balance accounts carry their IB, result
  // accounts start at zero. UB is before the result transfer, as in the books'
  // SB; the transfer (result to 2050, held on 8960) goes into next year's IB.
  // Debet +, kredit − in SB; HB lines carry magnitudes in debet / kredit.
  const ACCOUNTS = {
    1070: 'Utsatt skattefordel', 1810: 'Markedsbaserte aksjer, kostpris', 1811: 'Verdiøkning markedsbaserte aksjer',
    1812: 'Verdireduksjon markedsbaserte aksjer', 1820: 'Andre aksjer', 1920: 'Bankinnskudd', 1921: 'Bankinnskudd, megler',
    2000: 'Aksjekapital', 2020: 'Overkurs', 2050: 'Annen egenkapital', 2080: 'Udekket tap', 2120: 'Utsatt skatt',
    2250: 'Gjeld til eiere', 2390: 'Annen langsiktig gjeld', 2400: 'Leverandørgjeld', 2500: 'Betalbar skatt',
    7700: 'Styremøter', 7790: 'Annen kostnad', 7798: 'Annen kostnad, gebyrer', 8050: 'Annen renteinntekt',
    8070: 'Annen finansinntekt', 8071: 'Aksjeutbytte', 8078: 'Gevinst ved realisasjon av aksjer',
    8080: 'Verdiøkning markedsbaserte finansielle omløpsmidler', 8100: 'Verdireduksjon markedsbaserte finansielle omløpsmidler',
    8150: 'Annen rentekostnad', 8170: 'Annen finanskostnad', 8178: 'Tap ved realisasjon av aksjer', 8179: 'Annen finanskostnad, megler',
    8300: 'Betalbar skatt', 8320: 'Endring utsatt skatt', 8920: 'Avsatt utbytte', 8960: 'Overføringer annen egenkapital', 8990: 'Udekket tap',
  };
  const isBalance = (a) => a < 3000;

  // One year. `ib`: Map account -> opening balance (balance accounts).
  function ledgerYear({ dnb, aliases, transactions, priceAt, inputs, year, ib }) {
    const bank = bankYear(dnb, aliases, inputs, year);
    const nn = nordnetYear(transactions, priceAt, inputs, year);
    const end = `${year}-12-31`, ys = String(year);
    const hb = [], bal = new Map(), flags = [...nn.flags];
    const post = (bilagsnr, date, account, amount, comment, source) => {
      if (Math.abs(amount) < 0.005) return;
      hb.push({ kontonr: account, kontonavn: ACCOUNTS[account] || '', bilagsnr, date, kommentar: comment,
        debet: amount > 0 ? r2(amount) : 0, kredit: amount < 0 ? r2(-amount) : 0, source });
      bal.set(account, (bal.get(account) || 0) + amount);
    };
    for (const v of bank.vouchers) for (const l of v.lines) post(v.bilagsnr, v.date, l.account, (l.debet || 0) - (l.kredit || 0), v.text || '', v.source);
    if (bank.open.length) flags.push(`${bank.open.length} bank line${bank.open.length === 1 ? '' : 's'} not booked (add DECIDE rows); 1920 is short by them`);

    // Nordnet: deposits are booked from the bank side (DNB → 1921). A deposit
    // after the last DNB line is booked provisionally against 1920 and flagged.
    const nok = (t) => (window.Ledger ? window.Ledger.amountNok(t) : Number(t.amount) || 0);
    const dnbLast = (dnb || []).reduce((m, r) => (r.date && r.date > m ? r.date : m), '');
    const ev = new Map(nn.events.filter((e) => e.id != null).map((e) => [String(e.id), e]));
    const rows = (transactions || []).map((t, i) => ({ t, i, d: t.bookDate || t.tradeDate || '' })).filter((x) => x.d.slice(0, 4) === ys)
      .sort((a, b) => a.d.localeCompare(b.d) || (Number(a.t.nordnetId) - Number(b.t.nordnetId)) || a.i - b.i);
    let n = 0, provisional = 0;
    for (const { t, d } of rows) {
      const ty = String(t.type || '').trim().toUpperCase(), a = nok(t), bil = `NN${++n}`, sec = t.security || '';
      if (ty === 'INNSKUDD') {
        if (dnbLast && d > dnbLast) { post(bil, d, 1921, a, 'deposit, no DNB line yet', 'provisional'); post(bil, d, 1920, -a, 'deposit, no DNB line yet', 'provisional'); provisional += a; }
      } else if (ty === 'UTBYTTE') { post(bil, d, 1921, a, `dividend ${sec}`, 'rule'); post(bil, d, 8071, -a, `dividend ${sec}`, 'rule'); }
      else if (ty === 'KUPONGSKATT') { post(bil, d, 8071, -a, `withholding ${sec}`, 'rule'); post(bil, d, 1921, a, `withholding ${sec}`, 'rule'); }
      else if (ty.startsWith('DEBETRENTE')) { post(bil, d, 8150, -a, 'interest', 'rule'); post(bil, d, 1921, a, 'interest', 'rule'); }
      else if (ty === 'PLATTFORMAVGIFT') { post(bil, d, 8179, -a, 'platform fee', 'rule'); post(bil, d, 1921, a, 'platform fee', 'rule'); }
      else if (ty === 'KJØPT' || ty === 'TEGNING INNLEGG VP') { post(bil, d, 1810, -a, `bought ${sec}`, 'rule'); post(bil, d, 1921, a, `bought ${sec}`, 'rule'); }
      else if (ty === 'SALG' || REDEEM.includes(ty)) {
        const e = ev.get(String(t.nordnetId));
        if (!e) {
          if (ty === 'SALG') flags.push(`${d} sale of ${sec} has no cost from the lots`);
          else if (Math.abs(a) >= 0.005) flags.push(`${d} redemption of ${sec} is kept unrealised (REALISE … no) but paid ${r2(a)}: book the money with ENTRY rows`);
          continue;
        }
        const what = ty === 'SALG' ? `sold ${sec}` : `redeemed ${sec}`;
        post(bil, d, 1921, e.proceeds, what, 'rule'); post(bil, d, 1810, -e.cost, what, 'rule');
        post(bil, d, e.gain >= 0 ? 8078 : 8178, -e.gain, what, 'rule');
      } else if (ty === 'TILBAKEBETALING' || ty === 'UTTAK INTERNET') {
        flags.push(`${d} ${ty} ${sec}: no rule yet, book it with an ENTRY row`);
      }
      // NO_POSTING types move only securities (or a cash leg the books leave
      // out); unknown types are already flagged by the Nordnet replay.
    }
    // REALISE write-offs at 31.12.
    for (const e of nn.events.filter((x) => x.kind === 'REALISE')) {
      post('GLR', end, 1810, -e.cost, `written off ${e.security}`, 'manual'); post('GLR', end, 8178, e.cost, `written off ${e.security}`, 'manual');
    }
    // Revaluation at 31.12: gross unrealised gains on 1811/8080, losses on 1812/8100.
    let gains = 0, losses = 0;
    for (const r of nn.rows) { if (r.urealisert > 0) gains += r.urealisert; else if (r.urealisert < 0) losses += r.urealisert; }
    const ibOf = (a) => (ib && ib.get(a)) || 0;
    post('GLV', end, 1811, gains - ibOf(1811), 'revaluation, gains', 'rule'); post('GLV', end, 8080, -(gains - ibOf(1811)), 'revaluation, gains', 'rule');
    post('GLV', end, 1812, losses - ibOf(1812), 'revaluation, losses', 'rule'); post('GLV', end, 8100, -(losses - ibOf(1812)), 'revaluation, losses', 'rule');
    for (const e of ((inputs && inputs.entries) || []).filter((x) => x.year === year)) post(`GLM${e.row}`, end, e.account, e.debet - e.kredit, e.note || 'year-end entry', 'manual');

    const accounts = [...new Set([...(ib ? ib.keys() : []), ...bal.keys()])].filter((a) => isBalance(a) ? Math.abs(ibOf(a)) >= 0.005 || bal.has(a) : bal.has(a)).sort((a, b) => a - b);
    const sb = accounts.map((a) => {
      const o = isBalance(a) ? ibOf(a) : 0;
      return { kontonr: a, kontonavn: ACCOUNTS[a] || '', ib: r2(o), ub: r2(o + (bal.get(a) || 0)) };
    });
    for (const a of accounts) if (!ACCOUNTS[a]) flags.push(`account ${a} has no name in the built-in list`);
    const result = r2(sb.filter((r) => !isBalance(r.kontonr)).reduce((s, r) => s + r.ub, 0));
    const ibNext = new Map(sb.filter((r) => isBalance(r.kontonr)).map((r) => [r.kontonr, r.ub]));
    ibNext.set(2050, r2((ibNext.get(2050) || 0) + result));
    const debet = hb.reduce((s, l) => s + l.debet, 0), kredit = hb.reduce((s, l) => s + l.kredit, 0);
    if (Math.abs(debet - kredit) >= 0.01) flags.push(`HB ${year} does not balance (debet - kredit = ${r2(debet - kredit)})`);
    return { year, hb, sb, result, ibNext, bank, nordnet: nn, provisional: r2(provisional), flags };
  }

  // Every year from `firstYear` (IB from the IB inputs) to `lastYear`, each
  // opening with the year before's UB plus its result transfer.
  function calculatedYears({ dnb, aliases, transactions, prices, inputs, firstYear, lastYear }) {
    const out = [];
    let ib = new Map((inputs && inputs.ib) || []);
    for (let y = firstYear; y <= lastYear; y++) {
      const r = ledgerYear({ dnb, aliases, transactions, priceAt: prices ? prices(y) : null, inputs, year: y, ib });
      out.push(r); ib = r.ibNext;
    }
    return out;
  }

  window.Books = { INPUTS_TAB, KINDS, ACCOUNTS, isAccount, parseInputs, nordnetFromTransactions, bankYear, nordnetYear, ledgerYear, calculatedYears };
})();
