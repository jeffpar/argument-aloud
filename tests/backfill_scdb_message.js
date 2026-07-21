// One-off backfill: populate scdb_message on every case that already has
// scdb_corrections set, using the cached SCDB table (scdb/cache/scdb.json).
// Mirrors _scdbBuildMessage()/_scdbApplyXUpdate()'s message logic in
// scripts/update_cases.js exactly, but touches ONLY the scdb_message field —
// it does not re-run vote/usCite/etc. reconciliation.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { reorderCase } from '../scripts/schema.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TERMS_DIR = path.join(REPO_ROOT, 'courts/ussc/terms');
const SCDB_CACHE_PATH = path.join(REPO_ROOT, 'scdb/cache/scdb.json');

const _SCDB_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function _scdbNormalizeDate(s) {
    s = (s || '').trim();
    if (!s) return '';
    if (_SCDB_ISO_RE.test(s)) return s;
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    return s;
}

function _scdbDateList(val) {
    if (Array.isArray(val)) return val.map(v => _scdbNormalizeDate(String(v))).filter(Boolean);
    if (typeof val === 'string' && val.trim()) return val.split(',').map(p => _scdbNormalizeDate(p)).filter(Boolean);
    return [];
}

function _scdbContainsDate(ourValue, scdbDate) {
    const target = _scdbNormalizeDate(scdbDate);
    if (!target) return true;
    return _scdbDateList(ourValue).includes(target);
}

function _scdbBuildMessage(c, row) {
    const categories = new Set(
        String(c.scdb_corrections || '').split(',').map(s => s.trim()).filter(Boolean)
    );
    const messages = [];

    if (categories.has('argument')) {
        const scdbArg = _scdbNormalizeDate(row.dateArgument || '');
        if (scdbArg && !_scdbContainsDate(c.argument, scdbArg)) {
            messages.push(`SCDB argument date (${scdbArg}) incorrect`);
        }
        if (String(c.argument || '').includes(',')) {
            messages.push('SCDB argument dates incomplete');
        }
    }
    if (categories.has('reargument')) {
        const scdbRe = _scdbNormalizeDate(row.dateRearg || row.datreRearg || '');
        if (scdbRe && !_scdbContainsDate(c.reargument, scdbRe)) {
            messages.push(`SCDB reargument date (${scdbRe}) incorrect`);
        }
        if (String(c.reargument || '').includes(',')) {
            messages.push('SCDB reargument dates incomplete');
        }
    }
    if (categories.has('decision')) {
        const scdbDec = _scdbNormalizeDate(row.dateDecision || '');
        const ourDec  = _scdbNormalizeDate(c.decision || '');
        if (scdbDec && ourDec && scdbDec !== ourDec) {
            messages.push(`SCDB decision date (${scdbDec}) incorrect`);
        }
    }

    return messages.join('; ');
}

const scdb = JSON.parse(fs.readFileSync(SCDB_CACHE_PATH, 'utf8'));

let filesChanged = 0, casesChanged = 0, noRow = 0;

for (const term of fs.readdirSync(TERMS_DIR)) {
    const casesPath = path.join(TERMS_DIR, term, 'cases.json');
    if (!fs.existsSync(casesPath)) continue;
    let cases;
    try { cases = JSON.parse(fs.readFileSync(casesPath, 'utf8')); } catch { continue; }
    if (!Array.isArray(cases)) continue;

    let fileChanged = false;
    for (const c of cases) {
        if (!c.scdb_corrections) continue;
        const row = scdb[c.id];
        if (!row) { noRow++; continue; }

        const newMessage = _scdbBuildMessage(c, row);
        const changed = newMessage
            ? c.scdb_message !== newMessage
            : c.scdb_message !== undefined;
        if (!changed) continue;

        if (newMessage) c.scdb_message = newMessage;
        else delete c.scdb_message;

        const reordered = reorderCase(c);
        for (const k of Object.keys(c)) delete c[k];
        Object.assign(c, reordered);

        fileChanged = true;
        casesChanged++;
    }

    if (fileChanged) {
        fs.writeFileSync(casesPath, JSON.stringify(cases, null, 2) + '\n');
        filesChanged++;
    }
}

console.log(`Updated ${casesChanged} case(s) across ${filesChanged} file(s).`);
if (noRow) console.log(`${noRow} case(s) with scdb_corrections had no matching SCDB cache row (skipped).`);
