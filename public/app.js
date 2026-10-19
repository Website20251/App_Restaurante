// Utilidades compartidas por todas las pantallas.
const App = {
  state: null,
  listeners: [],
  online: false,

  async api(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && url !== "/api/login") { location.href = "/login.html"; return new Promise(() => {}); }
    if (!r.ok) {
      const err = new Error(data.error || "Error de red");
      err.status = r.status;
      throw err;
    }
    return data;
  },

  // Usuario con sesión iniciada (null si no hay; en ese caso redirige al login).
  me: null,
  loadMe() {
    return App._me || (App._me = fetch("/api/me").then(async r => {
      if (!r.ok) { location.href = "/login.html"; return new Promise(() => {}); }
      App.me = await r.json(); return App.me;
    }));
  },
  async logout() { try { await fetch("/api/logout", { method: "POST" }); } catch {} location.href = "/login.html"; },

  // Conexión en tiempo real; se reconecta sola. Exige sesión y, si toca, cambio de contraseña.
  async connect(onState) {
    if (onState) App.listeners.push(onState);
    const me = await App.loadMe();
    if (me.mustChange) await App.changePassword(true);
    const es = new EventSource("/api/events");
    es.addEventListener("state", e => {
      const prev = App.state;
      App.state = JSON.parse(e.data);
      App.skew = App.state.serverTime - Date.now();
      App.listeners.forEach(fn => fn(App.state, prev));
    });
    es.onopen = () => App.setOnline(true);
    es.onerror = () => {
      App.setOnline(false);
      // Si la sesión caducó o un administrador la cerró, volver al login.
      fetch("/api/me").then(r => { if (r.status === 401) location.href = "/login.html"; }).catch(() => {});
    };
  },
  setOnline(v) {
    App.online = v;
    const d = document.getElementById('conn');
    if (d) { d.classList.toggle('on', v); d.title = v ? 'Conectado' : 'Sin conexión, reintentando…'; }
  },
  skew: 0,
  nowMs() { return Date.now() + App.skew; },

  money(n) { return (App.state?.config.currency || '$') + Number(n).toFixed(2); },
  total(order) { return order.items.reduce((s, i) => s + i.price * i.qty, 0); },
  mmss(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  },
  hhmm(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); },
  esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },

  toast(msg, type = '') {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.append(box); }
    const t = document.createElement('div');
    t.className = 'toast ' + type; t.textContent = msg;
    box.append(t);
    setTimeout(() => t.remove(), type === 'alert' ? 6000 : 3200);
  },

  // Sonido de aviso (sin archivos): requiere un primer clic del usuario en la página.
  beep(kind = 'new') {
    try {
      const ctx = App._ac || (App._ac = new (window.AudioContext || window.webkitAudioContext)());
      const seq = kind === 'new' ? [880, 1175, 880] : [660, 880];
      seq.forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.type = 'sine';
        g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
        g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.18 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.17);
      });
    } catch {}
  },

  // Reemplazo de window.prompt (no existe en la app de escritorio). Devuelve el texto/valor elegido o null si se cancela.
  // opts: { title, text, value, placeholder, label, type, options: [[valor, etiqueta], ...], okLabel, multiline }
  ask(opts) {
    return new Promise(res => {
      const bg = document.createElement('div');
      bg.className = 'modal-bg';
      const field = opts.options
        ? `<select id="askIn">${opts.options.map(([v, l]) => `<option value="${App.esc(v)}" ${v === opts.value ? 'selected' : ''}>${App.esc(l)}</option>`).join('')}</select>`
        : opts.multiline
          ? `<textarea id="askIn" rows="3" placeholder="${App.esc(opts.placeholder || '')}">${App.esc(opts.value || '')}</textarea>`
          : `<input id="askIn" type="${opts.type || 'text'}" autocomplete="off" placeholder="${App.esc(opts.placeholder || '')}" value="${App.esc(opts.value ?? '')}">`;
      bg.innerHTML = `<div class="modal"><h3>${App.esc(opts.title || '')}</h3>${opts.text ? `<p class="muted">${App.esc(opts.text)}</p>` : ''}
        ${opts.label ? `<label>${App.esc(opts.label)}</label>` : '<div style="height:10px"></div>'}${field}
        <div class="row"><button class="btn" id="askNo">Cancelar</button><button class="btn primary" id="askOk">${App.esc(opts.okLabel || 'Aceptar')}</button></div></div>`;
      document.body.append(bg);
      const inp = bg.querySelector('#askIn');
      const done = v => { bg.remove(); res(v); };
      bg.querySelector('#askOk').onclick = () => done(inp.value);
      bg.querySelector('#askNo').onclick = () => done(null);
      bg.onmousedown = e => { if (e.target === bg) done(null); };
      inp.onkeydown = e => { if (e.key === 'Enter' && !opts.multiline) done(inp.value); if (e.key === 'Escape') done(null); };
      inp.focus(); if (inp.select && !opts.options) inp.select();
    });
  },

  confirm(title, text, okLabel = 'Aceptar') {
    return new Promise(res => {
      const bg = document.createElement('div');
      bg.className = 'modal-bg';
      bg.innerHTML = `<div class="modal"><h3>${App.esc(title)}</h3><p class="muted">${App.esc(text)}</p>
        <div class="row"><button class="btn" data-r="0">Cancelar</button><button class="btn primary" data-r="1">${App.esc(okLabel)}</button></div></div>`;
      bg.onclick = e => { const b = e.target.closest('[data-r]'); if (b || e.target === bg) { bg.remove(); res(b?.dataset.r === '1'); } };
      document.body.append(bg);
    });
  },

  // Ventana para cambiar la contraseña. forced=true: obligatoria (primer ingreso o clave restablecida).
  changePassword(forced = false) {
    return new Promise(res => {
      const bg = document.createElement("div");
      bg.className = "modal-bg";
      bg.innerHTML = `<div class="modal"><h3>🔑 ${forced ? "Crea tu contraseña" : "Cambiar contraseña"}</h3>
        <p class="muted">${forced ? "Es tu primer ingreso (o un administrador restableció tu clave). Elige una contraseña personal." : "Mínimo 4 caracteres."}</p>
        <label>Contraseña actual</label><input id="pw0" type="password" autocomplete="current-password">
        <label>Nueva contraseña</label><input id="pw1" type="password" autocomplete="new-password">
        <label>Repite la nueva</label><input id="pw2" type="password" autocomplete="new-password">
        <p id="pwErr" style="color:var(--danger);min-height:20px;margin-top:6px"></p>
        <div class="row">${forced ? '<button class="btn" id="pwOut">Salir</button>' : '<button class="btn" id="pwNo">Cancelar</button>'}<button class="btn primary" id="pwOk">Guardar</button></div></div>`;
      document.body.append(bg);
      const q = id => bg.querySelector("#" + id), err = t => q("pwErr").textContent = t;
      const go = async () => {
        if (q("pw1").value !== q("pw2").value) return err("Las contraseñas nuevas no coinciden");
        try {
          await App.api("POST", "/api/me/password", { current: q("pw0").value, password: q("pw1").value });
          bg.remove(); if (App.me) App.me.mustChange = false; App.toast("Contraseña actualizada", "ok"); res(true);
        } catch (e) { err(e.message); }
      };
      q("pwOk").onclick = go;
      bg.onkeydown = e => { if (e.key === "Enter") go(); };
      if (q("pwNo")) q("pwNo").onclick = () => { bg.remove(); res(false); };
      if (q("pwOut")) q("pwOut").onclick = () => App.logout();
      q("pw0").focus();
    });
  },

  // Pide la contraseña de un administrador para autorizar una acción (devuelve el texto o null).
  askApproval(text) {
    return new Promise(res => {
      const bg = document.createElement("div");
      bg.className = "modal-bg";
      bg.innerHTML = `<div class="modal"><h3>🔒 Autorización del administrador</h3><p class="muted">${App.esc(text)}</p>
        <input id="apw" type="password" autocomplete="off" placeholder="Contraseña del administrador" style="margin-top:12px">
        <div class="row"><button class="btn" id="apNo">Cancelar</button><button class="btn primary" id="apOk">Autorizar</button></div></div>`;
      document.body.append(bg);
      const inp = bg.querySelector("#apw");
      const done = v => { bg.remove(); res(v); };
      bg.querySelector("#apOk").onclick = () => done(inp.value || null);
      bg.querySelector("#apNo").onclick = () => done(null);
      inp.onkeydown = e => { if (e.key === "Enter") done(inp.value || null); };
      inp.focus();
    });
  },

  topbar(title, extra = '') {
    const el = document.createElement('div');
    el.className = 'topbar no-print';
    el.innerHTML = `<div class="brand"><a href="/">🍽️ <span id="rname">Restaurante</span></a></div>
      <span class="muted">· ${title}</span><div class="sp"></div>${extra}
      <span id="user" class="muted"></span><button class="btn sm" id="pwBtn" title="Cambiar mi contraseña">🔑</button><button class="btn sm" id="outBtn">Salir</button>
      <span class="clock" id="clock"></span><span class="dot" id="conn" title="Sin conexión"></span>`;
    el.querySelector("#pwBtn").onclick = () => App.changePassword(false);
    el.querySelector("#outBtn").onclick = () => App.logout();
    App.loadMe().then(u => {
      el.querySelector("#user").textContent = "👤 " + u.name;
      // Quien no es administrador no tiene portal: el nombre del local deja de ser un enlace.
      if (u.role !== "admin") { const a = el.querySelector(".brand a"); a.outerHTML = `<span>${a.innerHTML}</span>`; }
    });
    document.body.prepend(el);
    const tick = () => { document.getElementById('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    tick(); setInterval(tick, 15000);
    App.listeners.push(s => { document.getElementById('rname').textContent = s.config.name; document.title = `${title} · ${s.config.name}`; });
  },

  // Estado agregado de una mesa a partir de sus pedidos activos.
  tableInfo(n) {
    const orders = (App.state?.orders || []).filter(o => o.table === n && !o.paid && !o.cancelled);
    const items = orders.flatMap(o => o.items);
    return {
      orders, occupied: orders.length > 0,
      ready: items.some(i => i.status === 'listo'),
      total: orders.reduce((s, o) => s + App.total(o), 0),
    };
  },
};
