/**
 * Manual security→investor overrides for cases the Excel "Dim-values" sheet
 * doesn't cover (name variants, rights offerings, spinoffs, missing rows).
 * Each value is an array of { code, weight }.
 *
 * If you discover a missing one, add it here and re-run the import.
 */

const MANUAL_ATTRIBUTION = {
  // Case/spelling variants
  'BEWi': [{ code: 'HF', weight: 1.0 }],
  'HelloFresh SE': [{ code: 'JC', weight: 1.0 }],

  // Scibase Holding family — HH owns Scibase
  'NEXSTIM OYJ  APPLICATION': [{ code: 'HH', weight: 1.0 }],
  'Ansökan Scibase Holding': [{ code: 'HH', weight: 1.0 }],
  'Scibase Holding AB BTA': [{ code: 'HH', weight: 1.0 }],

  // Seafire family — HS owns Seafire
  'Seafire AB TR': [{ code: 'HS', weight: 1.0 }],
  'SEAFIRE TR SELL': [{ code: 'HS', weight: 1.0 }],
  'Seafire AB BTA': [{ code: 'HS', weight: 1.0 }],

  // Kongsberg Maritime came from Kongsberg Gruppen spinoff — HH owns Kongsberg
  'KONGSBERG MARITIME ASA': [{ code: 'HH', weight: 1.0 }],

  // TODO: Confirm with the team — placeholder attributions below.
  // Until confirmed these will appear in their "owner"'s portfolio, easy to fix.
  'Equinor': [{ code: 'HH', weight: 1.0 }],
  'Inission B': [{ code: 'HS', weight: 1.0 }],
  'Smartoptics Group': [{ code: 'HF', weight: 1.0 }],
};

module.exports = { MANUAL_ATTRIBUTION };
