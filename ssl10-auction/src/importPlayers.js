// Outputs objects shaped EXACTLY like your existing PLAYERS_DATA entries:
//   {"Auction #": 1, "Original S.No": 1, "SET": "MARQUEE",
//    "PLAYER NAME": "Virat Kohli", "BASE PRICE": "2C", "CAP/UNCAP": "Capped"}
// so loadAdminConfig() can drop this straight into PLAYERS_DATA with zero
// changes needed to baseToCr(), renderPlayer(), etc. — they already know
// how to read "2C"/"75L"-style BASE PRICE strings.

const XLSX = require('xlsx');

const NAME_ALIASES = ['player name', 'name', 'player'];
const PRICE_ALIASES = ['base price', 'base bid', 'baseprice', 'price', 'base'];
const SET_ALIASES = ['set', 'category', 'role', 'type'];
const CAP_ALIASES = ['cap/uncap', 'cap', 'capped'];

function norm(h){ return String(h).trim().toLowerCase(); }
function findField(row, aliases){
  const keys = Object.keys(row);
  for(const alias of aliases){
    const match = keys.find(k => norm(k) === alias);
    if(match) return row[match];
  }
  return undefined;
}

// Accepts whatever the source file already uses (2C / 2Cr / 75L / bare
// number) and normalizes to the "2C"/"75L" shorthand your baseToCr()
// already parses — so no numeric conversion logic needs duplicating here.
function normalizePrice(raw){
  if(raw === undefined || raw === null || raw === '') return null;
  if(typeof raw === 'number'){
    return raw >= 1 ? `${raw}C` : `${Math.round(raw*100)}L`;
  }
  let s = String(raw).trim().toUpperCase().replace(/\s+/g,'');
  if(s.endsWith('CR')) s = s.slice(0,-1); // "2CR" -> "2C"
  if(!s.endsWith('C') && !s.endsWith('L')){
    const n = parseFloat(s);
    if(Number.isNaN(n)) return null;
    s = n >= 1 ? `${n}C` : `${Math.round(n*100)}L`;
  }
  return s;
}

function parsePlayerFile(buffer){
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  const players = [];
  const errors = [];

  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const name = findField(row, NAME_ALIASES);
    const priceRaw = findField(row, PRICE_ALIASES);
    const set = findField(row, SET_ALIASES) || 'GENERAL';
    const cap = findField(row, CAP_ALIASES) || 'Capped';

    if(!name || String(name).trim() === ''){
      errors.push({ row: rowNum, error: 'Missing player name' });
      return;
    }
    const price = normalizePrice(priceRaw);
    if(!price){
      errors.push({ row: rowNum, error: `Invalid base price for "${name}"` });
      return;
    }

    players.push({
      'Auction #': players.length + 1,
      'Original S.No': players.length + 1,
      'SET': String(set).trim().toUpperCase(),
      'PLAYER NAME': String(name).trim(),
      'BASE PRICE': price,
      'CAP/UNCAP': String(cap).trim(),
    });
  });

  return { players, errors, totalRows: rows.length };
}

module.exports = { parsePlayerFile };
