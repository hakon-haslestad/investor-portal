const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/transactions', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT trade_date, settle_date, type, security, isin, qty, price,
              amount_nok, currency, fee, running_balance, transaction_text
       FROM transactions
       ORDER BY trade_date DESC, id DESC`
    )
    .all();
  res.json({ rows });
});

module.exports = router;
