// Minimal read-only XLSX reader — no dependencies.
//
// An .xlsx is a ZIP of XML parts. The repo deliberately carries no bundler and no
// runtime dependencies, and these reference workbooks are read once, by hand, when a
// source list is revised — so the ZIP + sheet-XML parsing here is cheaper than adding
// a package to every install, including the USB setup-portable path.
//
// Scope: stored (method 0) and deflated (method 8) entries, no ZIP64, no encryption.
// That covers every workbook Excel writes at these sizes.

const fs = require('fs');
const zlib = require('zlib');

// --- ZIP ---------------------------------------------------------------------

function readZip(buf) {
  // EOCD is last, but a trailing comment can push it back up to 64KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method   = buf.readUInt16LE(p + 10);
    const compLen  = buf.readUInt32LE(p + 20);
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen   = buf.readUInt16LE(p + 32);
    const localAt  = buf.readUInt32LE(p + 42);
    const name     = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compLen, localAt });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

// The central directory's name/extra lengths describe the CD entry, not the local
// header — the local header carries its own, and they routinely differ.
function readEntry(buf, entry) {
  const { method, compLen, localAt } = entry;
  if (buf.readUInt32LE(localAt) !== 0x04034b50) throw new Error('bad local file header');
  const nameLen  = buf.readUInt16LE(localAt + 26);
  const extraLen = buf.readUInt16LE(localAt + 28);
  const start = localAt + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + compLen);
  if (method === 0) return raw;
  if (method === 8) return zlib.inflateRawSync(raw);
  throw new Error('unsupported zip compression method ' + method);
}

// --- XML ---------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: String.fromCharCode(39) };

function decode(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

// A shared string is one <si>, but rich text splits it across several <t> runs —
// concatenate them or every styled cell loses everything after its first run.
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const si = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = si.exec(xml))) {
    const body = m[1] || '';
    let text = '';
    const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = t.exec(body))) text += tm[1];
    out.push(decode(text));
  }
  return out;
}

function colToIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

// Rows come back as sparse arrays of string | number | boolean | null, by column.
function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const attrs = rm[1] !== undefined ? rm[1] : rm[3];
    const body = rm[2] || '';
    const rNum = /\br="(\d+)"/.exec(attrs);
    const rowIdx = rNum ? Number(rNum[1]) - 1 : rows.length;
    const cells = [];

    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm, auto = 0;
    while ((cm = cellRe.exec(body))) {
      const cAttrs = cm[1] !== undefined ? cm[1] : cm[3];
      const cBody = cm[2] || '';
      const ref = /\br="([A-Z]+)\d+"/.exec(cAttrs);
      const idx = ref ? colToIndex(ref[1]) : auto;
      auto = idx + 1;

      const type = (/\bt="([^"]+)"/.exec(cAttrs) || [, 'n'])[1];
      let value = null;
      if (type === 'inlineStr') {
        let text = '';
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let tm;
        while ((tm = t.exec(cBody))) text += tm[1];
        value = decode(text);
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cBody);
        if (v) {
          const raw = decode(v[1]);
          if (type === 's') value = shared[Number(raw)] !== undefined ? shared[Number(raw)] : '';
          else if (type === 'str' || type === 'e') value = raw;
          else if (type === 'b') value = raw === '1';
          else { const n = Number(raw); value = Number.isNaN(n) ? raw : n; }
        }
      }
      cells[idx] = value;
    }
    rows[rowIdx] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

// --- public API --------------------------------------------------------------

function readWorkbook(filePath) {
  const buf = fs.readFileSync(filePath);
  const zip = readZip(buf);
  const part = name => (zip.has(name) ? readEntry(buf, zip.get(name)).toString('utf8') : null);

  const shared = parseSharedStrings(part('xl/sharedStrings.xml'));

  // Sheet name -> part path goes through workbook.xml's r:id and the workbook rels;
  // sheet order in workbook.xml does NOT track the sheetN.xml numbering.
  const rels = new Map();
  const relsXml = part('xl/_rels/workbook.xml.rels') || '';
  const relRe = /<Relationship\b[^>]*\/>/g;
  let r;
  while ((r = relRe.exec(relsXml))) {
    const id = (/Id="([^"]+)"/.exec(r[0]) || [])[1];
    const target = (/Target="([^"]+)"/.exec(r[0]) || [])[1];
    if (id && target) rels.set(id, 'xl/' + target.replace(/^\.\//, '').replace(/^\/xl\//, ''));
  }

  const sheets = new Map();
  const wbXml = part('xl/workbook.xml') || '';
  const shRe = /<sheet\b[^>]*\/>/g;
  let s;
  while ((s = shRe.exec(wbXml))) {
    const name = decode((/name="([^"]*)"/.exec(s[0]) || [])[1] || '');
    const rid = (/r:id="([^"]+)"/.exec(s[0]) || [])[1];
    const path = rels.get(rid);
    if (name && path) sheets.set(name, path);
  }

  return {
    sheetNames: [...sheets.keys()],
    sheet(name) {
      const path = sheets.get(name);
      if (!path) throw new Error('sheet "' + name + '" not found in ' + filePath + ' (have: ' + [...sheets.keys()].join(', ') + ')');
      const xml = part(path);
      if (xml === null) throw new Error('sheet part ' + path + ' missing from ' + filePath);
      return parseSheet(xml, shared);
    }
  };
}

module.exports = { readWorkbook };
