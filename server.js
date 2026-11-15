// Disparador de mensagens via Evolution API
// Fila lenta e aleatória (sem cron): um envio por vez, intervalo sorteado entre min e max,
// só dentro do horário configurado e respeitando limite diário.

const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===== CONFIG (variáveis de ambiente) =====
const PORT = process.env.PORT || 3000;
const EVO_URL = (process.env.EVOLUTION_URL || '').replace(/\/$/, '');
const EVO_KEY = process.env.EVOLUTION_APIKEY || '';
const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE || '';
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASSWORD || '';
const APP_NAME = process.env.APP_NAME || 'Disparo Cartões NFC';
const TZ = 'America/Sao_Paulo';

const DATA_DIR = path.join(__dirname, 'data');
const UP_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(UP_DIR, { recursive: true });

// ===== BANCO (arquivo JSON) =====
const DEFAULT_SETTINGS = {
  minDelay: 60,      // segundos entre um envio e outro (mínimo)
  maxDelay: 180,     // segundos (máximo)
  typingMin: 4,      // segundos "digitando..." antes de enviar
  typingMax: 10,
  startHour: 9,      // só envia a partir dessa hora
  endHour: 18,       // e para antes dessa hora
  dailyLimit: 50,    // máximo de envios por dia
  workdays: [1, 2, 3, 4, 5, 6] // 0=dom ... 6=sáb
};

let db = { settings: { ...DEFAULT_SETTINGS }, daily: { date: '', count: 0 }, campaigns: [], log: [] };
try {
  const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db = { ...db, ...saved, settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) } };
} catch (_) {}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

function log(msg) {
  db.log.unshift({ at: new Date().toISOString(), msg });
  db.log = db.log.slice(0, 300);
  console.log(new Date().toISOString(), msg);
}

// ===== UTIL =====
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + Number(a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function nowSP() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(new Date());
  const g = t => (parts.find(p => p.type === t) || {}).value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) % 24, weekday: wd };
}

function normalizeNumber(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  return null;
}

// {Oi|Olá|E aí} vira uma opção sorteada; {nome} vira o nome do contato
function renderMessage(tpl, contact) {
  let out = tpl.replace(/\{nome\}/gi, contact.name || '');
  let guard = 0;
  while (/\{[^{}]*\|[^{}]*\}/.test(out) && guard++ < 50) {
    out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opts) => pick(opts.split('|')));
  }
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

async function evo(method, p, body) {
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) throw new Error('Evolution não configurada (variáveis de ambiente)');
  const r = await fetch(EVO_URL + p, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: EVO_KEY },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  let json; try { json = JSON.parse(txt); } catch (_) { json = txt; }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(typeof json === 'string' ? json : JSON.stringify(json)).slice(0, 300)}`);
  return json;
}

// ===== ENVIO =====
async function checkNumber(number) {
  const res = await evo('POST', `/chat/whatsappNumbers/${EVO_INSTANCE}`, { numbers: [number] });
  const info = Array.isArray(res) ? res[0] : null;
  if (!info || !info.exists) return null;
  return (info.jid || '').split('@')[0] || number;
}

async function sendMessage(camp, number, text) {
  const s = db.settings;
  const typing = rand(s.typingMin, s.typingMax) * 1000;
  if (camp.image) {
    const media = fs.readFileSync(path.join(UP_DIR, camp.image.file)).toString('base64');
    return evo('POST', `/message/sendMedia/${EVO_INSTANCE}`, {
      number, mediatype: 'image', mimetype: camp.image.mime, fileName: camp.image.name,
      caption: text, media, delay: typing
    });
  }
  return evo('POST', `/message/sendText/${EVO_INSTANCE}`, { number, text, delay: typing });
}

async function processContact(camp, ct) {
  ct.attempts = (ct.attempts || 0) + 1;
  const jidNumber = await checkNumber(ct.number);
  if (!jidNumber) {
    ct.status = 'invalid'; ct.at = new Date().toISOString();
    log(`[${camp.name}] ${ct.name || ''} ${ct.number}: não tem WhatsApp, pulado`);
    return 'invalid';
  }
  const text = renderMessage(camp.message, ct);
  try {
    await sendMessage(camp, jidNumber, text);
    ct.status = 'sent'; ct.at = new Date().toISOString(); delete ct.error;
    db.daily.count++; camp.failStreak = 0;
    log(`[${camp.name}] enviado para ${ct.name || ''} ${ct.number} (${db.daily.count}/${db.settings.dailyLimit} hoje)`);
    return 'sent';
  } catch (e) {
    ct.error = e.message;
    ct.status = ct.attempts >= 2 ? 'failed' : 'pending';
    camp.failStreak = (camp.failStreak || 0) + 1;
    log(`[${camp.name}] ERRO ${ct.number}: ${e.message}`);
    if (camp.failStreak >= 3) {
      camp.status = 'paused';
      log(`[${camp.name}] PAUSADA automaticamente: 3 falhas seguidas. Verifique a conexão do WhatsApp.`);
    }
    return 'error';
  }
}

// ===== WORKER (loop com setTimeout, sem cron) =====
let timer = null;
let nextAt = null;
let busy = false;
let workerInfo = 'Parado';

function schedule(ms) {
  clearTimeout(timer);
  nextAt = Date.now() + ms;
  timer = setTimeout(tick, ms);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const camp = db.campaigns.find(c => c.status === 'running');
    if (!camp) { nextAt = null; workerInfo = 'Parado'; return; }

    const s = db.settings;
    const n = nowSP();
    if (db.daily.date !== n.date) db.daily = { date: n.date, count: 0 };

    if (!s.workdays.includes(n.weekday) || n.hour < s.startHour || n.hour >= s.endHour) {
      workerInfo = `Fora do horário (${s.startHour}h–${s.endHour}h). Aguardando...`;
      return schedule(5 * 60 * 1000);
    }
    if (db.daily.count >= s.dailyLimit) {
      workerInfo = `Limite diário atingido (${s.dailyLimit}). Continua amanhã.`;
      return schedule(15 * 60 * 1000);
    }

    const ct = camp.contacts.find(c => c.status === 'pending');
    if (!ct) {
      camp.status = 'done'; camp.finishedAt = new Date().toISOString();
      log(`[${camp.name}] campanha concluída`);
      workerInfo = 'Campanha concluída';
      return schedule(2000);
    }

    workerInfo = `Enviando para ${ct.name || ct.number}...`;
    const result = await processContact(camp, ct);
    if (camp.status !== 'running') { workerInfo = 'Pausado'; nextAt = null; return; }
    if (!camp.contacts.some(c => c.status === 'pending')) return schedule(2000);

    const minD = camp.minDelay || s.minDelay, maxD = camp.maxDelay || s.maxDelay;
    const wait = result === 'invalid' ? rand(5, 15) : rand(minD, Math.max(minD, maxD));
    workerInfo = `Próximo envio em ~${Math.round(wait / 60 * 10) / 10} min`;
    return schedule(wait * 1000);
  } catch (e) {
    log('Erro no worker: ' + e.message);
    workerInfo = 'Erro, tentando de novo em 1 min';
    schedule(60 * 1000);
  } finally {
    busy = false;
    save();
  }
}

// ===== LEITURA DA PLANILHA =====
function parseList(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  if (!rows.length) return [];

  const header = rows[0].map(h => String(h).toLowerCase());
  const body = rows.slice(1);
  const width = Math.max(...rows.map(r => r.length));

  // coluna do número: header com "numero/whats/telefone/celular" ou a que mais tem números válidos
  let numCol = header.findIndex(h => /n[uú]mero|whats|telefone|celular|fone/.test(h));
  if (numCol < 0) {
    let best = -1, bestCount = 0;
    for (let c = 0; c < width; c++) {
      const count = body.filter(r => normalizeNumber(r[c])).length;
      if (count > bestCount) { best = c; bestCount = count; }
    }
    numCol = best;
  }
  const nameCol = header.findIndex(h => /nome|name|empresa|estabelecimento/.test(h));

  const seen = new Set();
  const out = [];
  for (const r of body) {
    const number = normalizeNumber(r[numCol]);
    if (!number || seen.has(number)) continue;
    seen.add(number);
    out.push({ number, name: nameCol >= 0 ? String(r[nameCol]).trim() : '', status: 'pending' });
  }
  return out;
}

// ===== APP =====
const app = express();
app.use(express.json());

// senha do painel (Basic Auth)
app.use((req, res, next) => {
  const h = req.headers.authorization || '';
  const decoded = Buffer.from(h.split(' ')[1] || '', 'base64').toString();
  const i = decoded.indexOf(':');
  const u = decoded.slice(0, i), p = decoded.slice(i + 1);
  if (PANEL_PASS && u === PANEL_USER && p === PANEL_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Disparador"').status(401).send('Acesso restrito');
});

app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function summary(c) {
  const count = st => c.contacts.filter(x => x.status === st).length;
  return {
    id: c.id, name: c.name, status: c.status, createdAt: c.createdAt, finishedAt: c.finishedAt,
    message: c.message, image: c.image ? c.image.name : null, imageUrl: c.image ? `/api/campaigns/${c.id}/image` : null,
    minDelay: c.minDelay, maxDelay: c.maxDelay,
    total: c.contacts.length, pending: count('pending'), sent: count('sent'),
    failed: count('failed'), invalid: count('invalid'), skipped: c.skipped || 0
  };
}

app.get('/api/state', (req, res) => {
  const n = nowSP();
  if (db.daily.date !== n.date) db.daily = { date: n.date, count: 0 };
  res.json({
    appName: APP_NAME, settings: db.settings, daily: db.daily, workerInfo, nextAt,
    campaigns: db.campaigns.map(summary).reverse(),
    log: db.log.slice(0, 100)
  });
});

app.get('/api/connection', async (req, res) => {
  try {
    const r = await evo('GET', `/instance/connectionState/${EVO_INSTANCE}`);
    res.json({ ok: true, state: (r.instance && r.instance.state) || r.state || 'desconhecido' });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  const s = db.settings;
  const num = (v, def) => (v === undefined || v === '' || isNaN(Number(v)) ? def : Number(v));
  s.minDelay = Math.max(5, num(b.minDelay, s.minDelay));
  s.maxDelay = Math.max(s.minDelay, num(b.maxDelay, s.maxDelay));
  s.typingMin = Math.max(1, num(b.typingMin, s.typingMin));
  s.typingMax = Math.max(s.typingMin, num(b.typingMax, s.typingMax));
  s.startHour = Math.min(23, Math.max(0, num(b.startHour, s.startHour)));
  s.endHour = Math.min(24, Math.max(s.startHour + 1, num(b.endHour, s.endHour)));
  s.dailyLimit = Math.max(1, num(b.dailyLimit, s.dailyLimit));
  if (Array.isArray(b.workdays)) s.workdays = b.workdays.map(Number).filter(d => d >= 0 && d <= 6);
  save();
  res.json({ ok: true, settings: s });
});

app.post('/api/campaigns', upload.fields([{ name: 'list', maxCount: 1 }, { name: 'image', maxCount: 1 }]), (req, res) => {
  try {
    const name = (req.body.name || '').trim() || 'Campanha';
    const message = (req.body.message || '').trim();
    const listFile = req.files && req.files.list && req.files.list[0];
    if (!message) return res.status(400).json({ error: 'Escreva a mensagem' });
    if (!listFile) return res.status(400).json({ error: 'Envie a planilha' });

    let contacts = parseList(listFile.buffer);
    let skipped = 0;
    if (req.body.skipPrevious === 'true') {
      const already = new Set();
      db.campaigns.forEach(c => c.contacts.forEach(x => { if (x.status === 'sent') already.add(x.number); }));
      const before = contacts.length;
      contacts = contacts.filter(x => !already.has(x.number));
      skipped = before - contacts.length;
    }
    if (!contacts.length) return res.status(400).json({ error: 'Nenhum número válido na planilha' });

    let image = null;
    const img = req.files && req.files.image && req.files.image[0];
    if (img) {
      const ext = (path.extname(img.originalname) || '.jpg').toLowerCase();
      const file = crypto.randomUUID() + ext;
      fs.writeFileSync(path.join(UP_DIR, file), img.buffer);
      image = { file, name: img.originalname, mime: img.mimetype || 'image/jpeg' };
    }

    const minDelay = Math.max(5, Number(req.body.minDelay) || db.settings.minDelay);
    const maxDelay = Math.max(minDelay, Number(req.body.maxDelay) || db.settings.maxDelay);
    const camp = {
      id: crypto.randomUUID(), name, message, image, contacts, skipped, minDelay, maxDelay,
      status: 'draft', createdAt: new Date().toISOString(), failStreak: 0
    };
    db.campaigns.push(camp);
    log(`[${name}] criada com ${contacts.length} contatos${skipped ? ` (${skipped} pulados por já terem recebido)` : ''}`);
    save();
    res.json({ ok: true, campaign: summary(camp) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function findCamp(req, res) {
  const c = db.campaigns.find(x => x.id === req.params.id);
  if (!c) res.status(404).json({ error: 'Campanha não encontrada' });
  return c;
}

app.post('/api/campaigns/:id/start', (req, res) => {
  const c = findCamp(req, res); if (!c) return;
  db.campaigns.forEach(x => { if (x.status === 'running' && x.id !== c.id) x.status = 'paused'; });
  c.contacts.forEach(x => { if (x.status === 'failed') { x.status = 'pending'; x.attempts = 0; } });
  c.status = 'running'; c.failStreak = 0;
  log(`[${c.name}] iniciada`);
  save();
  schedule(3000);
  res.json({ ok: true });
});

app.post('/api/campaigns/:id/pause', (req, res) => {
  const c = findCamp(req, res); if (!c) return;
  if (c.status === 'running') { c.status = 'paused'; log(`[${c.name}] pausada`); }
  save();
  res.json({ ok: true });
});

app.post('/api/campaigns/:id/delete', (req, res) => {
  const c = findCamp(req, res); if (!c) return;
  if (c.image) { try { fs.unlinkSync(path.join(UP_DIR, c.image.file)); } catch (_) {} }
  db.campaigns = db.campaigns.filter(x => x.id !== c.id);
  log(`[${c.name}] excluída`);
  save();
  res.json({ ok: true });
});

// envia agora para um número de teste (não conta no limite nem na fila)
app.post('/api/campaigns/:id/test', async (req, res) => {
  const c = findCamp(req, res); if (!c) return;
  const number = normalizeNumber(req.body.number);
  if (!number) return res.status(400).json({ error: 'Número inválido' });
  try {
    const jid = await checkNumber(number);
    if (!jid) return res.status(400).json({ error: 'Esse número não tem WhatsApp' });
    await sendMessage(c, jid, renderMessage(c.message, { name: 'Teste' }));
    log(`[${c.name}] teste enviado para ${number}`);
    save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// prévia da planilha antes de criar a campanha
app.post('/api/preview', upload.single('list'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Envie a planilha' });
    let contacts = parseList(req.file.buffer);
    const already = new Set();
    db.campaigns.forEach(c => c.contacts.forEach(x => { if (x.status === 'sent') already.add(x.number); }));
    const alreadySent = contacts.filter(x => already.has(x.number)).length;
    res.json({ ok: true, total: contacts.length, alreadySent, sample: contacts.slice(0, 8) });
  } catch (e) { res.status(400).json({ error: 'Não consegui ler a planilha: ' + e.message }); }
});

app.get('/api/campaigns/:id/contacts', (req, res) => {
  const c = findCamp(req, res); if (!c) return;
  res.json({ contacts: c.contacts });
});

app.get('/api/campaigns/:id/image', (req, res) => {
  const c = findCamp(req, res); if (!c) return;
  if (!c.image) return res.status(404).end();
  res.type(c.image.mime).sendFile(path.join(UP_DIR, c.image.file));
});

// muda o intervalo de uma campanha (vale a partir do próximo envio)
app.post('/api/campaigns/:id/interval', (req, res) => {
  const c = findCamp(req, res); if (!c) return;
  const min = Math.max(5, Number(req.body.minDelay) || c.minDelay);
  const max = Math.max(min, Number(req.body.maxDelay) || c.maxDelay);
  c.minDelay = min; c.maxDelay = max;
  log(`[${c.name}] intervalo alterado para ${min}–${max} s`);
  save();
  res.json({ ok: true });
});

app.get('/api/campaigns/:id/export', (req, res) => {
  const c = findCamp(req, res); if (!c) return;
  const lines = ['nome;numero;status;quando;erro'];
  c.contacts.forEach(x => lines.push([x.name, x.number, x.status, x.at || '', (x.error || '').replace(/;/g, ',')].join(';')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${c.name.replace(/[^\w-]+/g, '_')}.csv"`);
  res.send('﻿' + lines.join('\n'));
});

app.listen(PORT, () => {
  console.log(`Disparador rodando na porta ${PORT}`);
  if (db.campaigns.some(c => c.status === 'running')) {
    log('Servidor reiniciado: retomando campanha em andamento');
    schedule(10 * 1000);
  }
});
