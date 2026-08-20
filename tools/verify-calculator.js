#!/usr/bin/env node
// Checks the Table 2B savings math in public/index.html against the worked example
// already saved in DeemedSavingsCalculator-WH_Template_202512.xlsx.
//
//   node tools/verify-calculator.js [calculatorFile]
//
// The spreadsheet ships with twelve months of billing data, six measures, and Excel's
// own cached results. Those cached numbers are the oracle: if the page's usage total,
// per-measure BTU and savings percentage do not reproduce them, the page is wrong.
//
// This loads the real page script rather than a copy of the formulas, so the test
// cannot drift away from what the browser runs.

const fs = require('fs');
const path = require('path');
const { readWorkbook } = require('./xlsx-read.js');

// --- load the page script with just enough browser around it to evaluate ---------

function loadPage() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('no inline <script> block in public/index.html');
  const stubEl = { style: {}, textContent: '', innerHTML: '', value: '', classList: { add() {}, remove() {} }, dataset: {}, addEventListener() {} };
  const document = { querySelectorAll: () => [], getElementById: () => stubEl, addEventListener() {} };
  const win = { addEventListener() {} };
  const exported = [
    'BTU_PER_KWH', 'BTU_PER_THERM', 'codeStem', 'normName', 'lookupVariant',
    'usageTotals', 'recalcSavingsPct', 'savingsBand', 'resolvePath', 'climateZoneFor',
    'foldRecommendations', 'mergeSystemHalves', 'systemHalf'
  ];
  const factory = new Function('document', 'window', 'fetch', 'alert', 'navigator', 'JSZip',
    m[1] + '\nreturn {' + exported.join(',') + ', setReference: r => { reference = r; }};');
  return factory(document, win, async () => { throw new Error('no network in this harness'); },
    () => {}, { clipboard: null }, null);
}

// --- read the calculator's worked example ---------------------------------------

function readCalculator(file) {
  const grid = readWorkbook(file).sheet('Sheet1');
  const cell = (row, col) => (grid[row - 1] || [])[col - 1];
  const months = [];
  for (let r = 5; r <= 16; r++) months.push({ kwh: cell(r, 3) || 0, therms: cell(r, 5) || 0 });
  const measures = [];
  for (let r = 5; r <= 22; r++) {
    const reportingCode = cell(r, 10);
    if (!reportingCode) continue;
    measures.push({
      row: r,
      reportingCode: String(reportingCode).trim(),
      snuggProCode: String(cell(r, 11) || '').trim(),
      kwh: Number(cell(r, 14)) || 0,
      kw: Number(cell(r, 15)) || 0,
      therms: Number(cell(r, 16)) || 0,
      qty: Number(cell(r, 17)) || 0,
      btu: Number(cell(r, 18)) || 0
    });
  }
  return {
    months, measures,
    usageBtu: Number(cell(22, 3)),      // C22, annual BTU used
    savedBtu: Number(cell(21, 3)),      // C21, deemed BTU saved
    savingsPct: Number(cell(23, 3))     // C23, the answer the sheet reports
  };
}

// --- checks ---------------------------------------------------------------------

let failures = 0;
function check(label, actual, expected, tolerance) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failures++;
  const fmt = v => (Math.abs(v) >= 1000 ? v.toFixed(3) : v.toPrecision(10));
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label.padEnd(42) +
    (ok ? fmt(actual) : 'got ' + fmt(actual) + ', sheet says ' + fmt(expected)));
}

function main() {
  const file = process.argv[2] ||
    path.join(__dirname, '..', '..', 'report-tool', 'DeemedSavingsCalculator-WH_Template_202512.xlsx');
  const page = loadPage();
  const sheet = readCalculator(file);
  const measureList = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'reference', 'measure-list.json'), 'utf8'));

  console.log('Calculator : ' + path.basename(file));
  console.log('Sheet says : ' + (sheet.savingsPct * 100).toFixed(4) + '% savings' +
    '  (' + sheet.savedBtu.toFixed(0) + ' BTU saved / ' + sheet.usageBtu.toFixed(0) + ' BTU used)');
  console.log('');

  // --- 1: the usage denominator, straight through the page's own usageTotals() ---
  // Shaped like the /all-data utilities block the page actually reads: a start date
  // plus numbered end dates and bills, one entry per month.
  console.log('Gate 1  annual usage BTU');
  const utilities = { electricBillUnits: 'kWh', fuelBillUnits: 'Therms', startElectricDate1: '2025-01-01', startFuelDate1: '2025-01-01' };
  sheet.months.forEach((m, i) => {
    const month = String(i + 2).padStart(2, '0');
    const date = i === 11 ? '2026-01-01' : '2025-' + month + '-01';
    utilities['endElectricDate' + (i + 1)] = date;
    utilities['endElectricBill' + (i + 1)] = m.kwh;
    utilities['endFuelDate' + (i + 1)] = date;
    utilities['endFuelBill' + (i + 1)] = m.therms;
  });
  const usage = page.usageTotals({ utilities });
  check('kWh over 12 months', usage.kwh, sheet.months.reduce((a, m) => a + m.kwh, 0), 1e-6);
  check('therms over 12 months', usage.therms, sheet.months.reduce((a, m) => a + m.therms, 0), 1e-6);
  check('annual BTU used (C22)', usage.btu, sheet.usageBtu, 0.01);

  // --- 2: the percentage, given the sheet's own per-measure deemed values ---
  // This isolates the arithmetic from the lookup: same inputs as the sheet, so the
  // answer must be the sheet's answer.
  console.log('');
  console.log('Gate 2  savings percentage on the sheet\'s own deemed values');
  const asItems = sheet.measures.map(m => ({
    czKwh: m.kwh * m.qty, czTh: m.therms * m.qty, czKw: m.kw * m.qty
  }));
  const savedBtu = asItems.reduce((a, i) => a + i.czKwh * page.BTU_PER_KWH + i.czTh * page.BTU_PER_THERM, 0);
  check('deemed BTU saved (C21)', savedBtu, sheet.savedBtu, 0.01);
  const pct = page.recalcSavingsPct(asItems, usage);
  check('savings percentage (C23)', pct, sheet.savingsPct * 100, 1e-9);
  console.log('        path from this percentage: ' + page.savingsBand(pct));

  // --- 3: the page's own lookup, per measure, at the zone the code names ---
  // Where the sheet and the page disagree the difference is reported, not hidden: the
  // sheet's XLOOKUP matches on Snugg Pro Code, which is climate-zone agnostic, so it
  // returns whichever row comes first in the list rather than the job's zone.
  console.log('');
  console.log('Gate 3  page lookup against the sheet, measure by measure');
  page.setReference({ byStem: measureList.byStem });
  let agree = 0, differ = 0;
  for (const m of sheet.measures) {
    const zone = /-(CZ\d\d)$/.exec(m.reportingCode);
    const czKey = zone ? zone[1] : '';
    // The reporting code names the HVAC type the row was written for, so the harness
    // can ask the same question the browser asks with classifyHvac(data).
    const hvac = (/-(r[A-Za-z]{4})-/.exec(m.reportingCode) || [, ''])[1];
    const entry = measureList.byStem[page.codeStem(m.snuggProCode || m.reportingCode)];
    const v = page.lookupVariant(entry, czKey, hvac, '').variant;
    const label = (m.reportingCode + (hvac ? '' : '')).padEnd(30);
    if (!v) {
      // No catalog entry is correct for test-in and mitigation lines, which the sheet
      // also scores at zero.
      const zeroInSheet = m.kwh === 0 && m.therms === 0;
      console.log('  ' + (zeroInSheet ? 'PASS' : 'FAIL') + '  ' + label + 'no catalog entry; sheet also has ' +
        (zeroInSheet ? 'zero savings' : m.kwh + ' kWh / ' + m.therms + ' therms'));
      if (!zeroInSheet) failures++;
      continue;
    }
    const same = Math.abs(v.kwh - m.kwh) < 1e-6 && Math.abs(v.th - m.therms) < 1e-6;
    if (same) { agree++; console.log('  PASS  ' + label + 'matches: ' + v.kwh + ' kWh / ' + v.th + ' therms'); }
    else {
      differ++;
      console.log('  DIFF  ' + label + 'page reads ' + czKey + ': ' + v.kwh + ' kWh / ' + v.th +
        ' therms; sheet used ' + m.kwh + ' kWh / ' + m.therms + ' therms');
    }
  }
  console.log('        ' + agree + ' measures agree, ' + differ + ' differ');
  if (differ) {
    console.log('        A difference here is expected and is the point of the tool: the sheet');
    console.log('        looks measures up by Snugg Pro Code, which carries no climate zone, so');
    console.log('        it takes the first row in the list. The page uses the job\'s own zone.');
  }

  console.log('');
  console.log(failures ? failures + ' check(s) failed.' : 'All checks passed.');
  process.exit(failures ? 1 : 0);
}

main();
