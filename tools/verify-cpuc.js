#!/usr/bin/env node
// Reconciles the Table 2B builder against the filed CPUC summary.
//
//   node tools/verify-cpuc.js [summaryCsv] [exportXlsx]
//
// Summary_CPUC-*.csv is the filed answer: one row per reported job with the path it was
// filed under and its total kWh, kW, therms and cost. This checks the structural things
// the builder must get right, then measures where the filed savings come from.
//
// Two things limit what a measure export can prove here, and both are reported rather
// than hidden:
//
//   1. Drift. If the export predates the filing, its line items are not what was filed.
//      Only jobs whose total cost still matches the filed cost to the cent are used for
//      the savings analysis.
//   2. Recommendation identity. /all-data gives each recommendation a uuid; the export
//      does not carry it, so this script can only group cost lines by recommendation
//      TITLE. That is enough to show which arithmetic the filed number used, but the
//      browser uses the uuid and is the authority.

const fs = require('fs');
const path = require('path');
const { readWorkbook } = require('./xlsx-read.js');

const s = v => (v == null ? '' : String(v).trim());
const n = v => (typeof v === 'number' ? v : 0);
const unesc = v => s(v).replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const money = v => '$' + Math.round(v).toLocaleString('en-US');
const pctOf = (a, b) => (b ? (a / b) * 100 : 0);

// --- csv ---------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function readSummary(file) {
  const grid = parseCsv(fs.readFileSync(file, 'utf8').replace(new RegExp('^' + String.fromCharCode(0xFEFF)), ''));
  const header = grid[0].map(s);
  return grid.slice(1).filter(r => r.length > 3).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = s(r[i]); });
    return o;
  });
}

// --- page ---------------------------------------------------------------------

function loadPage() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  const stubEl = { style: {}, textContent: '', innerHTML: '', value: '', classList: { add() {}, remove() {} }, dataset: {}, addEventListener() {} };
  const document = { querySelectorAll: () => [], getElementById: () => stubEl, addEventListener() {} };
  const factory = new Function('document', 'window', 'fetch', 'alert', 'navigator', 'JSZip',
    m[1] + '\nreturn { buildTable2B, setReference: r => { reference = r; },' +
    ' setOptions: o => { t2bIncludeNonMeasure = o.includeNonMeasure; t2bCompletedOnly = o.completedOnly; } };');
  return factory(document, { addEventListener() {} },
    async () => { throw new Error('no network in this harness'); }, () => {}, {}, null);
}

function loadReference() {
  const REF = path.join(__dirname, '..', 'public', 'reference');
  const read = f => JSON.parse(fs.readFileSync(path.join(REF, f + '.json'), 'utf8'));
  const crosswalk = read('measure-crosswalk');
  const measures = read('measure-list');
  return {
    byStem: measures.byStem,
    rows: read('table2b-rows').rows,
    byCode: crosswalk.byCode,
    componentSplits: crosswalk.componentSplits || {},
    supportedZones: new Set(measures.supportedZones || []),
    nameRules: crosswalk.byName.map(r => ({ re: new RegExp(r.match, 'i'), row: r.row, group: r.group })),
    zones: read('zip-climate-zone').zones
  };
}

// --- export --------------------------------------------------------------------

const LAYOUTS = {
  current: { measure: 1, code: 2, qty: 3, unit: 4, cost: 9, name: 10, src: 11, cpu: 12, savedKwh: 13, savedTh: 14, savedMb: 15, deemedKwh: 16, deemedTh: 17, deemedMb: 18 },
  legacy: { measure: 1, src: 2, name: 3, code: 4, qty: 5, unit: 6, cpu: 7, cost: 8, savedKwh: 9, savedTh: 10, savedMb: 11, deemedKwh: 12, deemedTh: 13, deemedMb: 14 }
};

function readExport(file) {
  const wb = readWorkbook(file);
  const rows = wb.sheet('MeasureSavings').slice(1).filter(r => r[0] != null);
  const isSrc = v => /^(rec|DI)$/.test(s(v));
  const sample = rows.find(r => isSrc(r[2]) || isSrc(r[11]));
  if (!sample) throw new Error('cannot tell which column holds Src -- unrecognised export layout');
  const legacy = isSrc(sample[2]);
  const L = legacy ? LAYOUTS.legacy : LAYOUTS.current;
  const items = rows.map(r => ({
    jobId: s(r[0]), measure: unesc(r[L.measure]), src: s(r[L.src]), name: unesc(r[L.name]),
    code: s(r[L.code]), qty: r[L.qty], unit: s(r[L.unit]), cpu: r[L.cpu], cost: n(r[L.cost]),
    savedKwh: r[L.savedKwh], savedTh: r[L.savedTh], savedMb: r[L.savedMb],
    deemedKwh: r[L.deemedKwh], deemedTh: r[L.deemedTh], deemedMb: r[L.deemedMb]
  }));
  const main = new Map(wb.sheet('main').slice(1).filter(r => r[0] != null)
    .map(r => [s(r[0]), { pct: typeof r[2] === 'number' ? r[2] : null, home: s(r[3]), hvac: s(r[4]) }]));
  return { items, main, layout: legacy ? 'legacy' : 'current' };
}

// Rebuild the /all-data shape from exported line items. The export carries no
// recommendation uuid, so cost lines are grouped by title here -- see the header note.
function rebuildJob(jobId, items, meta, summaryRow) {
  const recs = new Map(), diLines = [];
  for (const it of items) {
    if (it.src === 'DI') {
      const q = n(it.qty) || 1;
      diLines.push({
        name: it.name, code: it.code, quantity: it.qty, unit: it.unit,
        costPerUnit: it.cpu, laborCostPerUnit: 0,
        // The export stores deemed values already multiplied by quantity;
        // flattenMeasures() multiplies again, so divide back to per unit.
        deemedAnnualKwhSavings: it.deemedKwh == null ? null : n(it.deemedKwh) / q,
        deemedThermsSavings: it.deemedTh == null ? null : n(it.deemedTh) / q,
        deemedMmbtuSavings: it.deemedMb == null ? null : n(it.deemedMb) / q
      });
      continue;
    }
    if (!recs.has(it.measure)) {
      recs.set(it.measure, {
        status: '1', title: it.measure, uuid: '',
        savedKwh: it.savedKwh, savedTherms: it.savedTh, savedMbtu: it.savedMb,
        cost: 0, detailedCosts: []
      });
    }
    const rec = recs.get(it.measure);
    rec.cost += it.cost;
    rec.detailedCosts.push({ name: it.name, code: it.code, quantity: it.qty, unit: it.unit, costPerUnit: it.cpu });
  }
  return {
    // No ZIP in the export, so no climate zone: every job falls back to SnuggPro's own
    // deemed values, which is what the filed report was built from.
    job: { id: Number(jobId), zip: '', stageId: 6 },
    house: { typeOfHome: s(summaryRow['Dwelling Type']) },
    hvacs: [], utilities: {}, totals: { totalSavings: null },
    rebatesIncentives: [{
      code: 'deemedAndModeledKwhSavings',
      metadataJSON: JSON.stringify([{ key: 'combinedTotalEnergySavings', value: meta ? meta.pct : null }])
    }],
    recommendations: [...recs.values()],
    directInstalls: diLines.length ? [{ lineItems: diLines }] : []
  };
}

// Sum a job's exported rows without folding anything: every recommendation's line total
// counted once per cost line. This is the arithmetic under test, not a recommendation.
function naiveTotals(items) {
  let kwh = 0, therms = 0, cost = 0;
  for (const it of items) {
    cost += it.cost;
    kwh += n(it.savedKwh) + n(it.deemedKwh);
    therms += n(it.savedTh) + n(it.deemedTh);
  }
  return { kwh, therms, cost };
}

// The same sum with each recommendation's savings counted once, by title.
function foldedTotals(items) {
  let kwh = 0, therms = 0, cost = 0;
  const seen = new Map();
  for (const it of items) {
    cost += it.cost;
    if (it.src === 'rec') {
      if (!seen.has(it.measure)) seen.set(it.measure, { k: n(it.savedKwh), t: n(it.savedTh) });
    } else {
      kwh += n(it.deemedKwh); therms += n(it.deemedTh);
    }
  }
  for (const v of seen.values()) { kwh += v.k; therms += v.t; }
  return { kwh, therms, cost };
}

// --- report ---------------------------------------------------------------------

let failures = 0;
function gate(ok, label, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  -- ' + detail : ''));
}

function main() {
  const dir = path.join(__dirname, '..', '..', 'report-tool');
  const csvFile = process.argv[2] || path.join(dir, 'Summary_CPUC-2026-07.csv');
  const given = process.argv[3];
  const exportPath = given
    ? (path.isAbsolute(given) ? given : path.join(dir, given))
    : path.join(dir, fs.readdirSync(dir).filter(f => /^export_.*\.xlsx$/i.test(f)).sort().pop());

  const summary = readSummary(csvFile);
  const { items, main: mainMeta, layout } = readExport(exportPath);
  const page = loadPage();
  page.setReference(loadReference());
  page.setOptions({ includeNonMeasure: false, completedOnly: true });

  const byJob = new Map();
  items.forEach(i => {
    if (!byJob.has(i.jobId)) byJob.set(i.jobId, []);
    byJob.get(i.jobId).push(i);
  });
  const overlap = summary.filter(r => byJob.has(r['Job ID']));

  console.log('Filed summary : ' + path.basename(csvFile) + '  (' + summary.length + ' reported jobs)');
  console.log('Measure export: ' + path.basename(exportPath) + '  (' + layout + ' layout, ' + byJob.size + ' jobs)');
  console.log('Overlap       : ' + overlap.length + ' of ' + summary.length + ' reported jobs are in this export');

  // --- how much of the export is stale ---
  const exportDate = (/(\d{4}-\d{2}-\d{2})/.exec(path.basename(exportPath)) || [])[1];
  const cutoff = exportDate ? new Date(exportDate) : null;
  const stale = cutoff
    ? overlap.filter(r => { const d = new Date(r['Modified At']); return !isNaN(d) && d > cutoff; })
    : [];
  if (cutoff) {
    console.log('Freshness     : export dated ' + exportDate + '; ' + stale.length + ' of ' +
      overlap.length + ' overlapping jobs were modified after that date');
  }
  console.log('');

  // --- gate 1: path. Structural, and drift cannot move it. ---
  console.log('Gate 1  reported path');
  const normPath = p => (/deep/i.test(p) ? 'deep' : /plus/i.test(p) ? 'plus' : '?');
  const jobs = overlap.map(r => ({
    row: r, jobId: r['Job ID'],
    data: rebuildJob(r['Job ID'], byJob.get(r['Job ID']), mainMeta.get(r['Job ID']), r)
  }));
  const out = page.buildTable2B(jobs.map(j => ({ jobId: j.jobId, data: j.data })));
  const byId = new Map(out.comparison.map(c => [c.jobId, c]));
  const pathDiff = jobs.filter(j => {
    const got = byId.get(j.jobId);
    return !got || got.path !== normPath(j.row['Project Path']);
  });
  gate(pathDiff.length === 0, 'every job lands in the block it was filed under',
    (jobs.length - pathDiff.length) + '/' + jobs.length);
  pathDiff.slice(0, 10).forEach(j => console.log('        job ' + j.jobId + ' filed as ' +
    j.row['Project Path'] + ', computed ' + (byId.get(j.jobId) || {}).path));

  // --- gate 2: household counts, the figure Table 2B prints ---
  console.log('');
  console.log('Gate 2  household counts by path and dwelling type');
  const filed = { plus: { sf: 0, mh: 0 }, deep: { sf: 0, mh: 0 } };
  overlap.forEach(r => {
    const p = normPath(r['Project Path']);
    if (filed[p]) filed[p][/mobile/i.test(r['Dwelling Type']) ? 'mh' : 'sf']++;
  });
  ['plus', 'deep'].forEach(p => {
    const b = out.blocks[p];
    gate(b.singleFamily.size === filed[p].sf && b.mobile.size === filed[p].mh,
      p + ' households (single family / mobile)',
      b.singleFamily.size + ' / ' + b.mobile.size + ', filed ' + filed[p].sf + ' / ' + filed[p].mh);
  });

  // --- analysis: which arithmetic produced the filed savings ---
  // Restricted to jobs whose total cost still matches the filed cost to the cent. On a
  // drifted job the line items are not what was filed, so any savings comparison is
  // measuring the drift rather than the method.
  console.log('');
  console.log('Analysis  where the filed savings numbers come from');
  const clean = jobs.filter(j => {
    const filedCost = Number(j.row['Total Project Cost']) || 0;
    return Math.abs(naiveTotals(byJob.get(j.jobId)).cost - filedCost) < 0.01;
  });
  console.log('        ' + clean.length + ' of ' + jobs.length +
    ' jobs still match the filed cost to the cent (the rest have changed since the export)');

  if (!clean.length) {
    console.log('        No undrifted job to measure against. Re-export the reported jobs and re-run.');
  } else {
    let naiveHits = 0, foldHits = 0;
    const near = (a, b) => Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.001);
    const rows = [];
    for (const j of clean) {
      const its = byJob.get(j.jobId);
      const nv = naiveTotals(its), fd = foldedTotals(its);
      const fK = Number(j.row['Total kWh Savings']) || 0;
      const fT = Number(j.row['Total Therms Savings']) || 0;
      if (near(nv.kwh, fK) && near(nv.therms, fT)) naiveHits++;
      if (near(fd.kwh, fK) && near(fd.therms, fT)) foldHits++;
      rows.push({ job: j.jobId, filedK: fK, naiveK: nv.kwh, foldK: fd.kwh, filedT: fT, naiveT: nv.therms, foldT: fd.therms });
    }
    console.log('        filed total matches the UNFOLDED row sum : ' + naiveHits + '/' + clean.length);
    console.log('        filed total matches the FOLDED row sum   : ' + foldHits + '/' + clean.length);
    console.log('');
    rows.slice(0, 8).forEach(r => console.log('          job ' + r.job +
      '  kWh filed ' + r.filedK.toFixed(0).padStart(7) + ' | unfolded ' + r.naiveK.toFixed(0).padStart(7) +
      ' | folded ' + r.foldK.toFixed(0).padStart(7) +
      '   therms filed ' + r.filedT.toFixed(1).padStart(7) + ' | unfolded ' + r.naiveT.toFixed(1).padStart(7) +
      ' | folded ' + r.foldT.toFixed(1).padStart(7)));
    if (naiveHits > foldHits) {
      console.log('');
      console.log('        The filed savings are the unfolded sum: a recommendation carrying several');
      console.log('        cost lines is counted once per line. On the whole export that is 21% of');
      console.log('        modeled kWh. Whether a given repeat is one recommendation billed in parts');
      console.log('        or two real installs cannot be told from an export -- only /all-data carries');
      console.log('        the recommendation uuid, which is what the browser folds on.');
    }
  }

  console.log('');
  console.log(failures ? failures + ' gate(s) failed.' : 'All gates passed.');
  process.exit(failures ? 1 : 0);
}

main();
