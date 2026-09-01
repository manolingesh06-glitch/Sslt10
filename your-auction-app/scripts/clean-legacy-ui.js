const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appPath = path.join(root, 'public', 'js', 'app.js');
const indexPath = path.join(root, 'public', 'index.html');

let app = fs.readFileSync(appPath, 'utf8');
app = app.replace(/^let PLAYERS_DATA = .*?;\n\nlet TEAMS = \[.*?\];/s, 'let PLAYERS_DATA = [];\nlet TEAMS = [];');
app = app.replace(/const CREDENTIALS = \{.*?\};\n\nlet PLAYERS =/s, "const CREDENTIALS = { host:{password:''}, teams:{} };\n\nlet PLAYERS =");
app = app.replace(/if\(Array\.isArray\(cfg\.teams\) && cfg\.teams\.length >= 2\) TEAMS = cfg\.teams;/, 'if(Array.isArray(cfg.teams)) TEAMS = cfg.teams;');
app = app.replace(/if\(Array\.isArray\(cfg\.players\) && cfg\.players\.length > 0\) PLAYERS_DATA = cfg\.players;/, 'if(Array.isArray(cfg.players)) PLAYERS_DATA = cfg.players;');
app = app.replace(/continuing with default SPL dataset/g, 'continuing with empty SSLT10 dataset');
app = app.replace(/spl-s3-session/g, 'sslt10-session').replace(/spl-s3-chatSender/g, 'sslt10-chatSender');
app = app.replace(/SPL Season 3/g, 'SSLT10').replace(/SPL SEASON 3/g, 'SSLT10').replace(/SPL Auction/g, 'SSLT10 Auction');
fs.writeFileSync(appPath, app);

let html = fs.readFileSync(indexPath, 'utf8');
const adminStart = html.indexOf('<!-- ============================================================\n     ADMIN PANEL');
const mainStart = html.indexOf('<div class="wrap hidden" id="mainApp">');
if(adminStart >= 0 && mainStart > adminStart) html = html.slice(0, adminStart) + html.slice(mainStart);
html = html.replace(/<script src="\/js\/admin\.js"><\/script>\n?/g, '');
html = html.replace(/SPL Season 3/g, 'SSLT10').replace(/SPL SEASON 3/g, 'SSLT10').replace(/SPL Auction/g, 'SSLT10 Auction');
if (!html.includes('/js/security-bridge.js')) html = html.replace('<script src="/js/app.js"></script>', '<script src="/js/app.js"></script>\n<script src="/js/security-bridge.js"></script>\n<script src="/js/host-console.js"></script>');
fs.writeFileSync(indexPath, html);
console.log('Legacy UI cleanup complete.');
