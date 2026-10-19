// Sistema de pedidos para restaurante: mesero -> cocina/barra -> caja.
// Tiempo real mediante Server-Sent Events. Usuarios con contraseña y roles.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.RESTAURANTE_DATA || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archivo');
const BACKUP_KEEP = 14;        // copias diarias que se conservan
const ARCHIVE_AFTER_DAYS = 60; // pedidos cobrados/cancelados más antiguos pasan al archivo
const PUBLIC = path.join(__dirname, 'public');

const ROLES = ['admin', 'mesero', 'cocina', 'barra', 'caja'];
const SESSION_MS = 16 * 3600 * 1000; // la sesión se renueva con el uso
const TEMP_PASSWORD = '1234';        // contraseña temporal: obliga a cambiarla al primer ingreso

// ---------- Base de datos (JSON con escritura atómica) ----------
function seed() {
  const c = (id, name) => ({ id, name });
  const i = (id, name, category, price, station, stock = null) => ({ id, name, category, price, station, stock, available: true });
  return {
    config: { name: 'Mi Restaurante', currency: '$', tables: 12, taxPercent: 0, taxIncluded: false, seq: 100, mergeBar: false, countryCode: '', waiterCharges: false, dayStartHour: 4, maxDiscountNoAuth: 10, loginList: true },
    categories: [c('ent', 'Entradas'), c('fue', 'Platos fuertes'), c('beb', 'Bebidas'), c('pos', 'Postres')],
    menu: [
      i('m1', 'Ensalada César', 'ent', 8.5, 'cocina'),
      i('m2', 'Sopa del día', 'ent', 6, 'cocina'),
      i('m3', 'Nachos con queso', 'ent', 9, 'cocina'),
      i('m4', 'Hamburguesa clásica', 'fue', 13.5, 'cocina'),
      i('m5', 'Pollo a la parrilla', 'fue', 15, 'cocina'),
      i('m6', 'Pasta Alfredo', 'fue', 14, 'cocina'),
      i('m7', 'Lomo saltado', 'fue', 17, 'cocina'),
      i('m8', 'Gaseosa', 'beb', 2.5, 'directo', 24),
      i('m9', 'Limonada natural', 'beb', 3.5, 'barra'),
      i('m10', 'Cerveza', 'beb', 4, 'directo', 24),
      i('m11', 'Café americano', 'beb', 2.8, 'barra'),
      i('m12', 'Cheesecake', 'pos', 6.5, 'cocina'),
      i('m13', 'Helado (2 bolas)', 'pos', 4.5, 'cocina'),
    ],
    orders: [],
    users: [],
    sessions: {},
    stockLog: [],
    payQr: {},
  };
}

let db, sessions = {};
const BACKUP_RE = /^db-\d{4}-\d{2}-\d{2}\.json$/;
function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch {
    // Si el archivo existe pero está dañado, se intenta con la última copia diaria antes de empezar de cero.
    db = null;
    if (fs.existsSync(DB_FILE)) {
      try {
        const last = fs.readdirSync(BACKUP_DIR).filter(f => BACKUP_RE.test(f)).sort().pop();
        if (last) { db = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, last), 'utf8')); console.error('db.json dañado: se restauró', last); }
      } catch {}
      if (!db) { try { fs.copyFileSync(DB_FILE, DB_FILE + '.danado-' + Date.now()); } catch {} }
    }
    if (!db) db = seed();
  }
  try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { sessions = {}; }
  migrate();
  saveNow(); saveSessionsNow();
  maintenance();
}

// Adapta bases de datos de versiones anteriores (que tenían un PIN único y una lista de meseros).
function migrate() {
  if (db.sessions) { Object.assign(sessions, db.sessions); delete db.sessions; } // versiones anteriores guardaban las sesiones en db.json
  const defaults = { taxIncluded: false, dayStartHour: 4, maxDiscountNoAuth: 10, loginList: true };
  for (const [k, v] of Object.entries(defaults)) if (!(k in db.config)) db.config[k] = v;
  db.stockLog = db.stockLog || [];
  db.payQr = db.payQr || {};
  if (!db.users || !db.users.length) {
    db.users = [];
    const adminPass = db.config.pin ? String(db.config.pin) : TEMP_PASSWORD;
    addUser('Administrador', 'admin', adminPass, true);
    (db.staff || ['Carlos', 'María', 'Luis']).forEach(n => addUser(n, 'mesero', TEMP_PASSWORD, true));
    addUser('Cocina', 'cocina', TEMP_PASSWORD, true);
    addUser('Barra', 'barra', TEMP_PASSWORD, true);
    addUser('Caja', 'caja', TEMP_PASSWORD, true);
  }
  delete db.config.pin; delete db.staff;
  const t = now();
  for (const [k, s] of Object.entries(sessions)) if (s.exp < t) delete sessions[k];
}

let saveTimer = null;
function saveNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 150); }
// Las sesiones van en su propio archivo para no reescribir toda la base de datos cada vez que se renuevan.
let sessTimer = null;
function saveSessionsNow() {
  try { const tmp = SESSIONS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(sessions)); fs.renameSync(tmp, SESSIONS_FILE); } catch (e) { console.error(e); }
}
function saveSessions() { clearTimeout(sessTimer); sessTimer = setTimeout(saveSessionsNow, 500); }
// Guarda todo lo pendiente de inmediato (se usa al cerrar la aplicación).
function flush() { clearTimeout(saveTimer); clearTimeout(sessTimer); if (db) { saveNow(); saveSessionsNow(); } }

// Mantenimiento diario: copia de respaldo y archivo de pedidos antiguos.
const ymd = d => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
function maintenance() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const today = path.join(BACKUP_DIR, 'db-' + ymd(Date.now()) + '.json');
    if (!fs.existsSync(today)) fs.copyFileSync(DB_FILE, today);
    const all = fs.readdirSync(BACKUP_DIR).filter(f => BACKUP_RE.test(f)).sort();
    all.slice(0, Math.max(0, all.length - BACKUP_KEEP)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  } catch (e) { console.error('Respaldo:', e.message); }
  try {
    const limit = Date.now() - ARCHIVE_AFTER_DAYS * 86400000;
    const old = db.orders.filter(o => (o.paid || o.cancelled) && (o.paidAt || o.createdAt) < limit);
    if (!old.length) return;
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const byMonth = {};
    for (const o of old) (byMonth[ymd(o.paidAt || o.createdAt).slice(0, 7)] ||= []).push(o);
    for (const [month, list] of Object.entries(byMonth)) {
      const f = path.join(ARCHIVE_DIR, 'pedidos-' + month + '.json');
      let cur = []; try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      const ids = new Set(cur.map(o => o.id));
      fs.writeFileSync(f + '.tmp', JSON.stringify(cur.concat(list.filter(o => !ids.has(o.id))), null, 1));
      fs.renameSync(f + '.tmp', f);
    }
    const gone = new Set(old.map(o => o.id));
    db.orders = db.orders.filter(o => !gone.has(o.id));
    saveNow();
  } catch (e) { console.error('Archivo:', e.message); }
}

// ---------- Utilidades ----------
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const now = () => Date.now();
// Inicio del día de trabajo: un turno que pasa de medianoche cuenta como un solo día (config.dayStartHour).
const dayStart = (ts = Date.now()) => {
  const d = new Date(ts);
  d.setHours(Math.max(0, Math.min(12, Number(db.config.dayStartHour) || 0)), 0, 0, 0);
  if (d.getTime() > ts) d.setDate(d.getDate() - 1);
  return d.getTime();
};
const startOfToday = () => dayStart();
const round2 = n => Math.round(n * 100) / 100;

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg, code = 400) => { throw new HttpError(code, msg); };

// ---------- Usuarios, contraseñas y sesiones ----------
function hashPass(pass, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pass), salt, 32).toString('hex') };
}
function checkPass(user, pass) {
  const { hash } = hashPass(pass, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}
function addUser(name, role, pass, mustChange = true) {
  const u = { id: uid(), name, role, active: true, mustChange, ...hashPass(pass) };
  db.users.push(u);
  return u;
}
const publicUser = u => ({ id: u.id, name: u.name, role: u.role, active: u.active, mustChange: !!u.mustChange });
const activeAdmins = () => db.users.filter(u => u.role === 'admin' && u.active);

function checkNewPassword(p, current) {
  p = String(p || '');
  if (p.length < 4) bad('La contraseña debe tener al menos 4 caracteres');
  if (p.length > 64) bad('La contraseña es demasiado larga');
  if (p === TEMP_PASSWORD) bad('Elige una contraseña distinta a la temporal');
  if (current !== undefined && p === current) bad('La nueva contraseña debe ser distinta a la actual');
}

function cookieToken(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function sessionUser(req) {
  const tok = cookieToken(req);
  const s = tok && sessions[tok];
  if (!s) return null;
  const t = now();
  const u = db.users.find(x => x.id === s.userId);
  if (s.exp < t || !u || !u.active) { delete sessions[tok]; saveSessions(); return null; }
  if (s.exp - t < SESSION_MS - 600000) { s.exp = t + SESSION_MS; saveSessions(); } // renueva cada 10 min de uso
  return u;
}
function login(res, user) {
  const tok = crypto.randomBytes(32).toString('hex');
  sessions[tok] = { userId: user.id, exp: now() + SESSION_MS };
  saveSessions();
  res.setHeader('Set-Cookie', `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`);
}
function dropSessions(userId) {
  for (const [k, s] of Object.entries(sessions)) if (s.userId === userId) delete sessions[k];
  saveSessions();
  for (const [res, uid_] of clients) if (uid_ === userId) { res.end(); clients.delete(res); }
}

// Freno a fuerza bruta: 5 intentos fallidos por IP + usuario → espera de 60 s.
const fails = new Map();
function throttle(key) {
  const f = fails.get(key);
  if (f && f.until > now()) bad(`Demasiados intentos. Espera ${Math.ceil((f.until - now()) / 1000)} s`, 429);
}
function failed(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = now() + 60000; f.n = 0; }
  fails.set(key, f);
}

// ---------- Permisos ----------
// Qué pantallas puede abrir cada rol (el administrador puede todas).
function pageAllowed(user, pathname, query) {
  if (user.role === 'admin') return true;
  if (pathname === '/mesero.html') return user.role === 'mesero';
  if (pathname === '/caja.html') return user.role === 'caja' || (user.role === 'mesero' && !!db.config.waiterCharges);
  if (pathname === '/cocina.html') return user.role === (query.get('e') === 'barra' ? 'barra' : 'cocina');
  return false; // admin.html, conectar.html y cualquier otra
}
const homeFor = u => ({ admin: '/', mesero: '/mesero.html', cocina: '/cocina.html?e=cocina', barra: '/cocina.html?e=barra', caja: '/caja.html' }[u.role]);

function need(user, ...roles) {
  if (user.role !== 'admin' && !roles.includes(user.role)) bad('No tienes permiso para esta acción', 403);
}

// Cobrar: caja y administrador; los meseros solo si el local lo permite (config.waiterCharges).
function needCharge(user) {
  if (!(user.role === 'admin' || user.role === 'caja' || (user.role === 'mesero' && db.config.waiterCharges))) bad('No tienes permiso para cobrar', 403);
}
const PAY_KINDS = ['yape', 'plin'];

// ---------- Estado y tiempo real (SSE) ----------
function publicState() {
  const recent = now() - 12 * 3600 * 1000;
  return {
    config: db.config,
    categories: db.categories,
    menu: db.menu,
    // Datos para mostrar al cliente (el QR en sí se pide aparte, solo a quien puede cobrar).
    payInfo: Object.fromEntries(PAY_KINDS.map(k => { const q = db.payQr[k] || {}; return [k, { qr: !!q.img, v: q.v || 0, phone: q.phone || '', holder: q.holder || '' }]; })),
    orders: db.orders.filter(o => !o.paid && !o.cancelled || o.createdAt > recent),
    serverTime: now(),
  };
}
const clients = new Map(); // res -> userId
function broadcast() {
  const payload = `event: state\ndata: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients.keys()) res.write(payload);
}
function changed() { save(); broadcast(); }

// ---------- Lógica ----------
// Si cocina y barra son la misma persona (config.mergeBar), los productos de barra se despachan desde la cocina.
const effStation = m => (m.station === 'barra' && db.config.mergeBar) ? 'cocina' : m.station;

// Cambia el stock de un producto y lo anota. Al llegar a 0 queda agotado; al reponer vuelve a estar disponible.
function logStock(m, after, by, reason) {
  const before = m.stock;
  m.stock = Math.max(0, after);
  if (m.stock === 0) m.available = false;
  else if (before === 0) m.available = true;
  db.stockLog.push({ t: now(), itemId: m.id, name: m.name, before, after: m.stock, by, reason });
  if (db.stockLog.length > 5000) db.stockLog.splice(0, db.stockLog.length - 5000);
}

function createOrder(body, user) {
  const table = parseInt(body.table, 10);
  if (!table || table < 1 || table > db.config.tables) bad('Mesa inválida');
  if (!Array.isArray(body.items) || !body.items.length) bad('El pedido está vacío');
  const items = [], asked = {};
  const t = now();
  for (const it of body.items) {
    const m = db.menu.find(x => x.id === it.itemId);
    if (!m) bad('Producto no existe');
    if (!m.available) bad(`"${m.name}" está agotado`, 409);
    const qty = Math.max(1, Math.min(50, parseInt(it.qty, 10) || 1));
    asked[m.id] = (asked[m.id] || 0) + qty;
    if (m.stock != null && asked[m.id] > m.stock) bad(`"${m.name}": solo quedan ${m.stock}`, 409);
    const item = {
      id: uid(), itemId: m.id, name: m.name, price: m.price, qty,
      note: String(it.note || '').slice(0, 140), station: effStation(m), kind: m.station, status: 'pendiente',
    };
    // Bebidas de fábrica: las toma el mesero. No generan comanda; quedan anotadas como entregadas.
    if (m.station === 'directo') Object.assign(item, { status: 'entregado', startedAt: t, readyAt: t, deliveredAt: t, takenBy: user.name });
    items.push(item);
  }
  // Descuenta stock (solo productos con control de stock) y deja el registro.
  for (const [id, q] of Object.entries(asked)) {
    const m = db.menu.find(x => x.id === id);
    if (m.stock == null) continue;
    logStock(m, m.stock - q, user.name, 'pedido');
  }
  db.config.seq += 1;
  const order = {
    id: uid(), num: db.config.seq, table, waiter: user.name, waiterId: user.id, items,
    createdAt: now(), cancelled: false, paid: false,
    note: String(body.note || '').slice(0, 200),
  };
  db.orders.push(order);
  return order;
}

// Exige la contraseña de un administrador activo (con freno de intentos). Devuelve el administrador que autorizó.
function approve(user, ip, password) {
  const key = ip + '|ap|' + user.id;
  throttle(key);
  const admin = password ? activeAdmins().find(a => checkPass(a, password)) : null;
  if (!admin) {
    if (password) failed(key);
    bad(password ? 'Contraseña del administrador incorrecta' : 'Requiere autorización del administrador', 403);
  }
  return admin;
}

// Lo tomado de la nevera vuelve al stock al cancelar o quitar.
function returnStock(it, user, reason) {
  const m = it.station === 'directo' && db.menu.find(x => x.id === it.itemId);
  if (m && m.stock != null) logStock(m, m.stock + it.qty, user.name, reason);
}

function findOrder(id) { return db.orders.find(o => o.id === id) || bad('Pedido no encontrado', 404); }

function setStationStatus(order, station, status) {
  const valid = ['pendiente', 'preparando', 'listo'];
  if (!valid.includes(status)) bad('Estado inválido');
  const t = now();
  for (const it of order.items) {
    if (it.station !== station || it.status === 'entregado') continue;
    it.status = status;
    if (status === 'preparando') it.startedAt = it.startedAt || t;
    if (status === 'listo') { it.startedAt = it.startedAt || t; it.readyAt = t; }
  }
}

function tableBill(table) {
  const orders = db.orders.filter(o => o.table === table && !o.paid && !o.cancelled);
  const subtotal = round2(orders.reduce((s, o) => s + o.items.reduce((a, i) => a + i.price * i.qty, 0), 0));
  return { orders, subtotal };
}

// Pedidos del archivo (más antiguos) que caen en el rango, por si el reporte llega más atrás de los 60 días en db.json.
function archived(from, to) {
  const out = [];
  try {
    for (const f of fs.readdirSync(ARCHIVE_DIR)) {
      const m = /^pedidos-(\d{4})-(\d{2})\.json$/.exec(f);
      if (!m) continue;
      const a = new Date(+m[1], +m[2] - 1, 1).getTime(), b = new Date(+m[1], +m[2], 1).getTime();
      if (b < from - 86400000 || a > to + 86400000) continue;
      out.push(...JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8')));
    }
  } catch {}
  return out;
}
const allOrders = (from, to) => from < now() - (ARCHIVE_AFTER_DAYS - 2) * 86400000 ? db.orders.concat(archived(from, to)) : db.orders;

// Rango del reporte: ?from=YYYY-MM-DD&to=YYYY-MM-DD, o ?days=N (el día de hoy cuenta desde la hora de corte).
function rangeOf(url) {
  const day = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3], Number(db.config.dayStartHour) || 0).getTime() : null; };
  const f = day(url.searchParams.get('from')), t = day(url.searchParams.get('to'));
  if (f != null) return { from: f, to: (t != null ? t : f) + 86400000 };
  const days = Math.min(366, parseInt(url.searchParams.get('days'), 10) || 1);
  return { from: dayStart() - (days - 1) * 86400000, to: Infinity };
}

function report(from, to = Infinity) {
  const orders = allOrders(from, to);
  const paid = orders.filter(o => o.paid && o.paidAt >= from && o.paidAt < to);
  const sales = round2(paid.reduce((s, o) => s + (o.total || 0), 0));
  const tips = round2(paid.reduce((s, o) => s + (o.tip || 0), 0));
  const byMethod = {}, top = {}, byWaiter = {};
  let prepSum = 0, prepN = 0, discounts = 0;
  for (const o of paid) {
    // Un cobro dividido reparte el total entre sus métodos.
    if (o.payments && o.payments.length) for (const x of o.payments) byMethod[x.method] = round2((byMethod[x.method] || 0) + x.amount);
    else byMethod[o.method] = round2((byMethod[o.method] || 0) + (o.total || 0));
    if (o.bill) discounts = round2(discounts + (o.bill.discount || 0));
    byWaiter[o.waiter] = round2((byWaiter[o.waiter] || 0) + o.items.reduce((a, i) => a + i.price * i.qty, 0));
    for (const i of o.items) {
      top[i.name] = (top[i.name] || 0) + i.qty;
      if (i.readyAt) { prepSum += i.readyAt - o.createdAt; prepN++; }
    }
  }
  const sorted = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]);
  return {
    sales, tips, discounts, tickets: new Set(paid.map(o => o.paidRef)).size, orders: paid.length,
    avgPrepMin: prepN ? round2(prepSum / prepN / 60000) : 0,
    byMethod, top: sorted(top).slice(0, 8), byWaiter: sorted(byWaiter),
    cancelled: orders.filter(o => o.cancelled && o.createdAt >= from && o.createdAt < to).length,
    from, to: to === Infinity ? now() : to - 1,
  };
}

// Una fila por cuenta cobrada, para abrir en Excel.
function reportCsv(from, to) {
  const groups = new Map();
  for (const o of allOrders(from, to)) if (o.paid && o.paidAt >= from && o.paidAt < to) (groups.get(o.paidRef) || groups.set(o.paidRef, []).get(o.paidRef)).push(o);
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['Fecha', 'Hora', 'Mesa', 'Mesero', 'Cajero', 'Productos', 'Subtotal', 'Descuento', 'Motivo descuento', 'Autorizó', 'Impuesto', 'Propina', 'Total', 'Método', 'Detalle pago', 'N° operación']];
  for (const os of [...groups.values()].sort((a, b) => a[0].paidAt - b[0].paidAt)) {
    const f = os.find(o => o.bill) || os[0], b = f.bill || {}, d = new Date(os[0].paidAt);
    const lines = os.flatMap(o => o.items.map(i => `${i.qty}x ${i.name}`)).join('; ');
    const subtotal = b.subtotal ?? round2(os.reduce((s, o) => s + o.items.reduce((a, i) => a + i.price * i.qty, 0), 0));
    rows.push([ymd(d), d.toTimeString().slice(0, 5), os[0].table, os[0].waiter, os[0].cashier || '', lines, subtotal, b.discount || 0, b.discountReason || '', b.approvedBy || '', b.tax || 0,
      round2(os.reduce((s, o) => s + (o.tip || 0), 0)), round2(os.reduce((s, o) => s + (o.total || 0), 0)), os[0].method,
      (f.payments || []).map(x => `${x.method}: ${x.amount}`).join('; '), f.opRef || '']);
  }
  return '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n');
}

// ---------- Red local (para conectar celulares/tablets) ----------
// Prioriza las redes domésticas típicas (192.168.x, 10.x, 172.16-31.x) y deja al final adaptadores virtuales.
function lanIps() {
  const rank = ip => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  return Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
    (list || []).filter(n => n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.')).map(n => ({ name, ip: n.address })))
    .sort((a, b) => rank(a.ip) - rank(b.ip));
}

// ---------- Rutas API ----------
async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  const body = ['POST', 'PUT', 'PATCH'].includes(m) ? await readJson(req) : {};
  const ip = req.socket.remoteAddress;
  let mt;

  // --- Públicas: lista de usuarios para elegir y login ---
  // Con config.loginList desactivado no se muestra quién tiene cuenta: hay que escribir el nombre.
  if (m === 'GET' && p === '/api/login-users') {
    if (db.config.loginList === false) return send(res, 200, { hidden: true, users: [] });
    return send(res, 200, { hidden: false, users: db.users.filter(u => u.active).map(u => ({ id: u.id, name: u.name, role: u.role })) });
  }
  if (m === 'POST' && p === '/api/login') {
    const byName = body.name ? String(body.name).trim().toLowerCase() : null;
    const found = byName ? db.users.find(x => x.active && x.name.toLowerCase() === byName) : db.users.find(x => x.id === body.userId && x.active);
    const key = ip + '|' + (found ? found.id : 'x|' + (byName || body.userId));
    throttle(key);
    const u = found;
    if (!u || !checkPass(u, body.password || '')) { failed(key); bad('Contraseña incorrecta', 401); }
    fails.delete(key);
    login(res, u);
    return send(res, 200, { ...publicUser(u), home: homeFor(u) });
  }

  // --- Desde aquí hace falta sesión ---
  const user = sessionUser(req);
  if (!user) bad('Sesión no iniciada', 401);

  if (m === 'GET' && p === '/api/me') return send(res, 200, { ...publicUser(user), home: homeFor(user) });
  if (m === 'POST' && p === '/api/logout') {
    delete sessions[cookieToken(req)]; saveSessions();
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/me/password') {
    const key = ip + '|pw|' + user.id;
    throttle(key);
    if (!checkPass(user, body.current || '')) { failed(key); bad('La contraseña actual es incorrecta', 403); }
    checkNewPassword(body.password, body.current);
    Object.assign(user, hashPass(body.password), { mustChange: false });
    save();
    return send(res, 200, { ok: true });
  }
  if (user.mustChange) bad('Debes cambiar tu contraseña antes de continuar', 403);

  if (m === 'GET' && p === '/api/state') return send(res, 200, publicState());

  // --- Pedidos ---
  if (m === 'POST' && p === '/api/orders') {
    need(user, 'mesero');
    const r = createOrder(body, user); changed(); return send(res, 201, r);
  }
  if ((mt = p.match(/^\/api\/orders\/(\w+)\/station$/)) && m === 'POST') {
    if (!['cocina', 'barra'].includes(body.station)) bad('Estación inválida');
    need(user, body.station); // cocina solo toca "cocina"; barra solo "barra"
    const o = findOrder(mt[1]);
    setStationStatus(o, body.station, body.status);
    changed(); return send(res, 200, o);
  }
  if ((mt = p.match(/^\/api\/orders\/(\w+)\/deliver$/)) && m === 'POST') {
    need(user, 'mesero');
    const o = findOrder(mt[1]);
    const t = now();
    for (const it of o.items) if (it.status === 'listo') { it.status = 'entregado'; it.deliveredAt = t; it.deliveredBy = user.name; }
    changed(); return send(res, 200, o);
  }
  if ((mt = p.match(/^\/api\/orders\/(\w+)\/cancel$/)) && m === 'POST') {
    need(user, 'mesero', 'caja');
    const o = findOrder(mt[1]);
    if (o.paid) bad('El pedido ya fue pagado', 409);
    // Sin autorización solo se puede cancelar un pedido propio que la cocina aún no tocó.
    const free = user.role === 'admin' ||
      (o.items.filter(i => i.station !== 'directo').every(i => i.status === 'pendiente') && (user.role === 'caja' || o.waiterId === user.id));
    if (!free) approve(user, ip, body.approverPassword);
    for (const it of o.items) returnStock(it, user, 'pedido cancelado #' + o.num);
    o.cancelled = true; o.cancelReason = String(body.reason || '').slice(0, 140); o.cancelledBy = user.name;
    changed(); return send(res, 200, o);
  }
  // Quitar un solo producto de un pedido ya enviado (mismas reglas de autorización que cancelar).
  if ((mt = p.match(/^\/api\/orders\/(\w+)\/items\/(\w+)\/remove$/)) && m === 'POST') {
    need(user, 'mesero', 'caja');
    const o = findOrder(mt[1]);
    if (o.paid || o.cancelled) bad('El pedido ya está cerrado', 409);
    const it = o.items.find(x => x.id === mt[2]) || bad('Producto no encontrado en el pedido', 404);
    const free = user.role === 'admin' || ((it.station === 'directo' || it.status === 'pendiente') && (user.role === 'caja' || o.waiterId === user.id));
    if (!free) approve(user, ip, body.approverPassword);
    returnStock(it, user, 'producto quitado del pedido #' + o.num);
    o.items = o.items.filter(x => x !== it);
    (o.removed ||= []).push({ name: it.name, qty: it.qty, by: user.name, at: now(), reason: String(body.reason || '').slice(0, 140) });
    if (!o.items.length) { o.cancelled = true; o.cancelReason = 'Sin productos'; o.cancelledBy = user.name; }
    changed(); return send(res, 200, o);
  }

  // --- Caja ---
  if ((mt = p.match(/^\/api\/tables\/(\d+)\/pay$/)) && m === 'POST') {
    needCharge(user);
    const { orders, subtotal } = tableBill(parseInt(mt[1], 10));
    if (!orders.length) bad('La mesa no tiene cuenta pendiente', 409);
    // Los descuentos solo los da caja o el administrador, no un mesero que cobra.
    const discPct = user.role === 'mesero' ? 0 : Math.min(100, Math.max(0, Number(body.discountPercent) || 0));
    // Hasta cierto porcentaje (config.maxDiscountNoAuth) caja decide sola; por encima necesita la clave de un administrador.
    let approvedBy = null;
    if (discPct > 0 && user.role !== 'admin' && discPct > (Number(db.config.maxDiscountNoAuth) || 0)) approvedBy = approve(user, ip, body.approverPassword).name;
    const discount = round2(subtotal * discPct / 100);
    const base = round2(subtotal - discount), pct = db.config.taxPercent || 0;
    // Con precios que ya incluyen impuesto, este solo se informa (se extrae del total); si no, se suma encima.
    const tax = db.config.taxIncluded ? round2(base * pct / (100 + pct)) : round2(base * pct / 100);
    const tip = Math.max(0, round2(Number(body.tip) || 0));
    const total = round2(db.config.taxIncluded ? base + tip : base + tax + tip);
    const METHODS = ['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia'];
    // Pago dividido: lista [{ method, amount }] que debe sumar exactamente el total.
    let payments;
    if (Array.isArray(body.payments) && body.payments.length) {
      payments = body.payments.map(x => ({ method: METHODS.includes(x.method) ? x.method : 'efectivo', amount: round2(Number(x.amount) || 0) })).filter(x => x.amount > 0);
      if (Math.abs(round2(payments.reduce((s, x) => s + x.amount, 0)) - total) > 0.01) bad('Los pagos no suman el total de la cuenta', 400);
    } else {
      payments = [{ method: METHODS.includes(body.method) ? body.method : 'efectivo', amount: total }];
    }
    const method = payments.length > 1 ? 'mixto' : payments[0].method;
    const ref = uid(), t = now();
    // El total se asigna al primer pedido del grupo; el resto queda en 0 para no duplicar ventas.
    orders.forEach((o, idx) => {
      o.paid = true; o.paidAt = t; o.method = method; o.paidRef = ref; o.cashier = user.name;
      o.total = idx === 0 ? total : 0; o.tip = idx === 0 ? tip : 0;
      if (idx === 0) {
        o.bill = { subtotal, discount, tax, taxIncluded: !!db.config.taxIncluded };
        o.payments = payments;
        if (discount) { o.bill.discountPct = discPct; o.bill.discountReason = String(body.discountReason || '').slice(0, 100); if (approvedBy) o.bill.approvedBy = approvedBy; }
        if (body.opRef) o.opRef = String(body.opRef).slice(0, 40);
      }
    });
    changed();
    return send(res, 200, { total, subtotal, discount, tax, taxIncluded: !!db.config.taxIncluded, tip, method, payments, ref, orders: orders.length });
  }

  // Cobros de hoy, para reimprimir o reenviar un ticket.
  if (m === 'GET' && p === '/api/receipts') {
    needCharge(user);
    const from = startOfToday(), groups = new Map();
    for (const o of db.orders) {
      if (!o.paid || o.paidAt < from) continue;
      if (user.role === 'mesero' && o.cashier !== user.name) continue;
      if (!groups.has(o.paidRef)) groups.set(o.paidRef, []);
      groups.get(o.paidRef).push(o);
    }
    const out = [];
    for (const [ref, os] of groups) {
      const lines = os.flatMap(o => o.items.map(i => ({ qty: i.qty, name: i.name, price: i.price })));
      const subtotal = round2(lines.reduce((s, l) => s + l.price * l.qty, 0));
      const total = round2(os.reduce((s, o) => s + (o.total || 0), 0)), tip = round2(os.reduce((s, o) => s + (o.tip || 0), 0));
      const withBill = os.find(o => o.bill);
      let discount, tax;
      if (withBill) ({ discount, tax } = withBill.bill);
      else { const d = round2(subtotal - (total - tip)); discount = Math.max(0, d); tax = Math.max(0, -d); } // cobros anteriores a esta versión
      const first = withBill || os[0];
      out.push({ ref, table: os[0].table, paidAt: os[0].paidAt, lines, subtotal, discount, tax, taxIncluded: !!(withBill && withBill.bill.taxIncluded), tip, total, method: os[0].method, payments: first.payments || null, cashier: os[0].cashier || '' });
    }
    out.sort((a, b) => b.paidAt - a.paidAt);
    return send(res, 200, out.slice(0, 15));
  }

  // QR de Yape / Plin: lo ve quien puede cobrar.
  if ((mt = p.match(/^\/api\/pay-qr\/(yape|plin)$/)) && m === 'GET') {
    needCharge(user);
    const q = db.payQr[mt[1]];
    const img = q && q.img && /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(q.img);
    if (!img) bad('Sin QR', 404);
    res.writeHead(200, { 'Content-Type': img[1], 'Cache-Control': 'private, max-age=3600' });
    return res.end(Buffer.from(img[2], 'base64'));
  }

  // --- Menú ---
  if (m === 'POST' && p === '/api/menu') {
    need(user);
    const it = sanitizeItem(body);
    it.id = 'm' + uid(); it.available = it.stock !== 0; db.menu.push(it);
    if (it.stock != null) db.stockLog.push({ t: now(), itemId: it.id, name: it.name, before: null, after: it.stock, by: user.name, reason: 'producto nuevo' });
    changed(); return send(res, 201, it);
  }
  if ((mt = p.match(/^\/api\/menu\/(\w+)$/))) {
    const it = db.menu.find(x => x.id === mt[1]) || bad('Producto no encontrado', 404);
    if (m === 'PATCH') {
      const keys = Object.keys(body);
      if (keys.length === 1 && keys[0] === 'available') need(user, it.station === 'directo' ? 'mesero' : effStation(it)); // cada rol agota solo lo suyo
      else need(user);
      if ('available' in body) it.available = !!body.available;
      if (keys.some(k => k !== 'available')) {
        const before = it.stock, prevStation = it.station;
        const clean = sanitizeItem({ ...it, ...body });
        const { stock, ...rest } = clean;
        Object.assign(it, rest);
        if ('stock' in body || clean.station !== 'directo') {
          if (stock === null) it.stock = null;
          else if (stock !== before) logStock(it, stock, user.name, 'ajuste del administrador');
        }
        // Si pasa a "de fábrica", lo que ya está pedido y sin empezar deja de ir a cocina/barra:
        // queda anotado como tomado por el mesero del pedido (y descuenta stock si se controla).
        if (prevStation !== 'directo' && it.station === 'directo') {
          const t = now();
          for (const o of db.orders) {
            if (o.paid || o.cancelled) continue;
            for (const li of o.items) {
              if (li.itemId !== it.id || li.status !== 'pendiente') continue;
              Object.assign(li, { station: 'directo', kind: 'directo', status: 'entregado', startedAt: t, readyAt: t, deliveredAt: t, takenBy: o.waiter });
              if (it.stock != null) logStock(it, it.stock - li.qty, o.waiter, 'pedido #' + o.num + ' (pasó a de fábrica)');
            }
          }
        }
      }
      changed(); return send(res, 200, it);
    }
    if (m === 'DELETE') {
      need(user);
      db.menu = db.menu.filter(x => x.id !== it.id);
      changed(); return send(res, 200, { ok: true });
    }
  }

  // --- Solo administrador ---
  need(user);

  if (m === 'GET' && p === '/api/network') return send(res, 200, { port: Number(PORT), ips: lanIps() });
  if (m === 'GET' && p === '/api/qr') {
    const text = url.searchParams.get('text') || '';
    if (!/^https?:\/\/[\w.:\/?=&-]{1,200}$/.test(text)) bad('Texto inválido');
    const svg = await require('qrcode').toString(text, { type: 'svg', margin: 1, width: 320 });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    return res.end(svg);
  }

  if ((mt = p.match(/^\/api\/pay-qr\/(yape|plin)$/)) && (m === 'PUT' || m === 'DELETE')) {
    const k = mt[1];
    if (m === 'DELETE') { delete db.payQr[k]; changed(); return send(res, 200, { ok: true }); }
    const q = db.payQr[k] || (db.payQr[k] = {});
    if (body.image) {
      if (typeof body.image !== 'string' || body.image.length > 2000000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(body.image)) bad('Imagen inválida (usa PNG, JPG o WEBP de hasta 1.5 MB)');
      q.img = body.image; q.v = now();
    }
    if ('phone' in body) q.phone = String(body.phone || '').replace(/[^\d+ -]/g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20);
    if ('holder' in body) q.holder = String(body.holder || '').slice(0, 60);
    changed(); return send(res, 200, { ok: true });
  }

  if (m === 'PUT' && p === '/api/config') {
    const c = db.config;
    if (body.name) c.name = String(body.name).slice(0, 60);
    if (body.currency) c.currency = String(body.currency).slice(0, 4);
    if (body.tables) c.tables = Math.max(1, Math.min(100, parseInt(body.tables, 10) || c.tables));
    if ('taxPercent' in body) c.taxPercent = Math.max(0, Math.min(50, Number(body.taxPercent) || 0));
    if ('waiterCharges' in body) c.waiterCharges = !!body.waiterCharges;
    if ('taxIncluded' in body) c.taxIncluded = !!body.taxIncluded;
    if ('loginList' in body) c.loginList = !!body.loginList;
    if ('dayStartHour' in body) c.dayStartHour = Math.max(0, Math.min(12, parseInt(body.dayStartHour, 10) || 0));
    if ('maxDiscountNoAuth' in body) c.maxDiscountNoAuth = Math.max(0, Math.min(100, Number(body.maxDiscountNoAuth) || 0));
    if ('countryCode' in body) c.countryCode = String(body.countryCode).replace(/\D/g, '').slice(0, 4);
    if ('mergeBar' in body && !!body.mergeBar !== !!c.mergeBar) {
      c.mergeBar = !!body.mergeBar;
      // Los pedidos abiertos también se reacomodan: lo que aún no se empezó a preparar cambia de pantalla.
      for (const o of db.orders) {
        if (o.paid || o.cancelled) continue;
        for (const it of o.items) {
          if (it.status !== 'pendiente' || it.station === 'directo') continue;
          if (c.mergeBar && it.station === 'barra') { it.kind = it.kind || 'barra'; it.station = 'cocina'; }
          else if (!c.mergeBar && it.kind === 'barra') it.station = 'barra';
        }
      }
    }
    changed(); return send(res, 200, publicState().config);
  }
  if (m === 'GET' && p === '/api/registry') {
    const days = parseInt(url.searchParams.get('days'), 10) || 1;
    const from = startOfToday() - (days - 1) * 86400000;
    const rows = [], totals = {};
    for (const o of db.orders) {
      if (o.createdAt < from) continue;
      for (const i of o.items) {
        if (i.station !== 'directo') continue;
        rows.push({ t: o.createdAt, table: o.table, num: o.num, waiter: i.takenBy || o.waiter, name: i.name, qty: i.qty, cancelled: o.cancelled });
        if (!o.cancelled) totals[i.name] = (totals[i.name] || 0) + i.qty;
      }
    }
    rows.sort((a, b) => b.t - a.t);
    return send(res, 200, {
      rows, totals: Object.entries(totals).sort((a, b) => b[1] - a[1]),
      stock: db.menu.filter(x => x.station === 'directo').map(x => ({ id: x.id, name: x.name, stock: x.stock, available: x.available })),
      movements: db.stockLog.filter(x => x.t >= from).slice(-200).reverse(),
    });
  }
  if (m === 'GET' && p === '/api/report') {
    const r = rangeOf(url);
    return send(res, 200, report(r.from, r.to));
  }
  if (m === 'GET' && p === '/api/report.csv') {
    const r = rangeOf(url);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="ventas-${ymd(r.from)}.csv"`, 'Cache-Control': 'no-store' });
    return res.end(reportCsv(r.from, r.to));
  }

  // Categorías del menú
  if (m === 'POST' && p === '/api/categories') {
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) bad('Falta el nombre');
    if (db.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) bad('Ya existe una categoría con ese nombre', 409);
    const c = { id: 'c' + uid(), name }; db.categories.push(c);
    changed(); return send(res, 201, c);
  }
  if ((mt = p.match(/^\/api\/categories\/(\w+)$/))) {
    const c = db.categories.find(x => x.id === mt[1]) || bad('Categoría no encontrada', 404);
    if (m === 'PATCH') {
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) bad('Falta el nombre');
      if (db.categories.some(x => x.id !== c.id && x.name.toLowerCase() === name.toLowerCase())) bad('Ya existe una categoría con ese nombre', 409);
      c.name = name; changed(); return send(res, 200, c);
    }
    if (m === 'DELETE') {
      if (db.menu.some(x => x.category === c.id)) bad('La categoría tiene productos: muévelos o bórralos primero', 409);
      db.categories = db.categories.filter(x => x !== c);
      changed(); return send(res, 200, { ok: true });
    }
  }

  // Usuarios
  if (m === 'GET' && p === '/api/users') return send(res, 200, db.users.map(publicUser));
  if (m === 'POST' && p === '/api/users') {
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) bad('Falta el nombre');
    if (!ROLES.includes(body.role)) bad('Rol inválido');
    if (db.users.some(u => u.name.toLowerCase() === name.toLowerCase())) bad('Ya existe un usuario con ese nombre', 409);
    checkNewPassword(body.password);
    const u = addUser(name, body.role, body.password, true);
    save(); return send(res, 201, publicUser(u));
  }
  if ((mt = p.match(/^\/api\/users\/(\w+)$/))) {
    const u = db.users.find(x => x.id === mt[1]) || bad('Usuario no encontrado', 404);
    const lastAdmin = u.role === 'admin' && u.active && activeAdmins().length === 1;
    if (m === 'PATCH') {
      if (body.name !== undefined) {
        const name = String(body.name).trim().slice(0, 40);
        if (!name) bad('Falta el nombre');
        if (db.users.some(x => x.id !== u.id && x.name.toLowerCase() === name.toLowerCase())) bad('Ya existe un usuario con ese nombre', 409);
        u.name = name;
      }
      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) bad('Rol inválido');
        if (lastAdmin && body.role !== 'admin') bad('Debe quedar al menos un administrador activo', 409);
        u.role = body.role;
      }
      if (body.active !== undefined) {
        if (lastAdmin && !body.active) bad('Debe quedar al menos un administrador activo', 409);
        u.active = !!body.active;
      }
      if (body.password) { checkNewPassword(body.password); Object.assign(u, hashPass(body.password), { mustChange: true }); }
      if (!u.active || body.password || body.role !== undefined) dropSessions(u.id); // obliga a volver a entrar
      save(); broadcast(); return send(res, 200, publicUser(u));
    }
    if (m === 'DELETE') {
      if (u.id === user.id) bad('No puedes borrar tu propio usuario', 409);
      if (lastAdmin) bad('Debe quedar al menos un administrador activo', 409);
      dropSessions(u.id);
      db.users = db.users.filter(x => x.id !== u.id);
      save(); return send(res, 200, { ok: true });
    }
  }

  bad('Ruta no encontrada', 404);
}

function sanitizeItem(b) {
  const name = String(b.name || '').trim().slice(0, 60);
  const price = Number(b.price);
  if (!name) bad('Falta el nombre');
  if (!(price >= 0)) bad('Precio inválido');
  if (!db.categories.some(c => c.id === b.category)) bad('Categoría inválida');
  if (!['cocina', 'barra', 'directo'].includes(b.station)) bad('Estación inválida');
  // Stock: solo para productos "directo" (de fábrica). Vacío = sin control.
  let stock = null;
  if (b.station === 'directo' && b.stock !== null && b.stock !== undefined && b.stock !== '') {
    stock = parseInt(b.stock, 10);
    if (!(stock >= 0)) bad('Stock inválido');
  }
  return { name, price: round2(price), category: b.category, station: b.station, stock };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 3e6) { req.destroy(); reject(new HttpError(413, 'Demasiado grande')); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new HttpError(400, 'JSON inválido')); } });
  });
}
function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

// ---------- Archivos estáticos con control de acceso ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
const PUBLIC_FILES = new Set(['/login.html', '/style.css', '/app.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']);
function redirect(res, to) { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); }

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Prohibido' });

  if (!PUBLIC_FILES.has(rel)) {
    const user = sessionUser(req);
    if (!user) return redirect(res, '/login.html');
    // Pantalla que no le corresponde a su rol: se le devuelve a la suya.
    if (path.extname(file) === '.html' && !pageAllowed(user, rel, url.searchParams)) return redirect(res, homeFor(user));
  }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'No encontrado' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- Servidor ----------
load();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/events') {
      const user = sessionUser(req);
      if (!user || user.mustChange) return send(res, 401, { error: 'Sesión no iniciada' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
      clients.set(res, user.id);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Error interno' });
  }
});
setInterval(() => { for (const r of clients.keys()) r.write(': ping\n\n'); }, 25000); // mantiene viva la conexión
setInterval(() => { // limpia intentos fallidos vencidos y sesiones caducadas
  const t = now();
  for (const [k, f] of fails) if (f.until < t && f.n === 0) fails.delete(k);
  for (const [k, s] of Object.entries(sessions)) if (s.exp < t) delete sessions[k];
}, 600000).unref();
setInterval(maintenance, 6 * 3600 * 1000).unref(); // respaldo diario y archivo de pedidos viejos

server.on('error', e => {
  const msg = e.code === 'EADDRINUSE'
    ? `El puerto ${PORT} ya está en uso por otro programa (o hay otra copia del sistema abierta). Ciérralo e inténtalo de nuevo.`
    : 'No se pudo iniciar el servidor: ' + e.message;
  console.error(msg);
  try { require('electron').dialog.showErrorBox('Restaurante', msg); require('electron').app.exit(1); } catch { process.exit(1); }
});
server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log(`\n  Sistema de restaurante en marcha\n  Local:  http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  Red:    http://${ip}:${PORT}   <- úsalo en celulares/tablets/pantalla de cocina`));
  console.log('');
});
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('exit', flush);
module.exports = { flush }; // la app de escritorio lo llama antes de cerrar
