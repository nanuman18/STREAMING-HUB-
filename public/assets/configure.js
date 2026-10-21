(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const state = { options: null, status: null, platforms: [], enabled: new Set(), encoded: '' };

  // ------------------------------------------------------------ utilidades

  const b64url = {
    encode(str) {
      const bytes = new TextEncoder().encode(str);
      let bin = '';
      bytes.forEach((b) => { bin += String.fromCharCode(b); });
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    decode(s) {
      const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
      const bin = atob(pad);
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    },
  };

  const fmtDate = (ms) => ms ? new Date(ms).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : 'nunca';
  const fmtNum = (n) => (n ?? 0).toLocaleString('es-ES');
  const ago = (ms) => {
    if (!ms) return 'nunca';
    const h = (Date.now() - ms) / 3_600_000;
    if (h < 1) return `hace ${Math.max(1, Math.round(h * 60))} min`;
    if (h < 48) return `hace ${Math.round(h)} h`;
    return `hace ${Math.round(h / 24)} días`;
  };

  /** Lee la configuración del enlace /{config}/configure (al pulsar «Configurar» desde Stremio). */
  function configFromUrl() {
    const m = location.pathname.match(/^\/([A-Za-z0-9_-]{2,})\/configure\/?$/);
    if (!m) return null;
    try {
      const e = JSON.parse(b64url.decode(m[1]));
      return { platforms: e.p, types: e.t, region: e.r, language: e.l, sort: e.s, layout: e.g };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------- render

  function counts(key) {
    const region = $('#region').value;
    const r = state.status?.regions.find((x) => x.region === region);
    if (!r) return '';
    const movie = r.catalogs.find((c) => c.platform === key && c.type === 'movie');
    const series = r.catalogs.find((c) => c.platform === key && c.type === 'series');
    if (!movie && !series) return 'Sin datos todavía';
    return `${fmtNum(movie?.visible)} películas · ${fmtNum(series?.visible)} series`;
  }

  function renderPlatforms() {
    const list = $('#platforms');
    list.textContent = '';
    state.platforms.forEach((p, i) => {
      const on = state.enabled.has(p.key);
      const li = document.createElement('li');
      li.className = 'platform' + (on ? '' : ' off');
      li.draggable = true;
      li.dataset.key = p.key;
      li.innerHTML = `
        <span class="grip" aria-hidden="true">⋮⋮</span>
        <span class="name"></span>
        <span class="move">
          <button type="button" class="icon-btn up" aria-label="Subir">↑</button>
          <button type="button" class="icon-btn down" aria-label="Bajar">↓</button>
        </span>
        <label class="switch"><input type="checkbox"><span class="track"></span></label>`;
      const name = li.querySelector('.name');
      name.textContent = p.name;
      const c = document.createElement('span');
      c.className = 'counts';
      c.textContent = counts(p.key);
      name.appendChild(c);
      const cb = li.querySelector('input');
      cb.checked = on;
      cb.setAttribute('aria-label', `Mostrar ${p.name}`);
      cb.addEventListener('change', () => {
        cb.checked ? state.enabled.add(p.key) : state.enabled.delete(p.key);
        li.classList.toggle('off', !cb.checked);
        update();
      });
      const up = li.querySelector('.up');
      const down = li.querySelector('.down');
      up.disabled = i === 0;
      down.disabled = i === state.platforms.length - 1;
      up.addEventListener('click', () => move(i, i - 1, 'up'));
      down.addEventListener('click', () => move(i, i + 1, 'down'));
      li.addEventListener('dragstart', (e) => { li.classList.add('dragging'); e.dataTransfer.setData('text/plain', String(i)); });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drop-target'); });
      li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('drop-target');
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (Number.isInteger(from)) move(from, i);
      });
      list.appendChild(li);
    });
  }

  function move(from, to, focus) {
    if (to < 0 || to >= state.platforms.length || from === to) return;
    const [p] = state.platforms.splice(from, 1);
    state.platforms.splice(to, 0, p);
    renderPlatforms();
    if (focus) {
      // En los extremos el botón usado queda desactivado: el foco pasa al otro.
      const li = $(`#platforms li:nth-child(${to + 1})`);
      const btn = li?.querySelector(`.${focus}`);
      (btn && !btn.disabled ? btn : li?.querySelector(focus === 'up' ? '.down' : '.up'))?.focus();
    }
    update();
  }

  function renderStatus() {
    const s = state.status;
    const el = $('#status');
    el.className = 'status';
    if (!s) { $('#status-text').textContent = 'Estado no disponible'; return; }
    if (s.syncing) { el.classList.add('syncing'); $('#status-text').textContent = 'Sincronizando con TMDB…'; }
    else if (!s.lastUpdate) { el.classList.add('stale'); $('#status-text').textContent = 'Aún no hay datos sincronizados'; }
    else {
      el.classList.add(Date.now() - s.lastUpdate > 48 * 3_600_000 ? 'stale' : 'ok');
      $('#status-text').textContent = `Datos actualizados ${ago(s.lastUpdate)}`;
    }
    $('#last-update').textContent = s.lastUpdate ? fmtDate(s.lastUpdate) : 'sin datos';

    const region = $('#region').value;
    const r = s.regions.find((x) => x.region === region);
    const tbody = $('#stats tbody');
    tbody.textContent = '';
    const order = new Map(state.platforms.map((p, i) => [p.key, i]));
    const rows = (r?.catalogs ?? []).slice().sort((a, b) => (order.get(a.platform) ?? 99) - (order.get(b.platform) ?? 99) || a.type.localeCompare(b.type));
    if (!rows.length) {
      const tr = tbody.insertRow();
      const td = tr.insertCell();
      td.colSpan = 5;
      td.textContent = 'Sin datos todavía: la primera sincronización puede tardar varios minutos.';
      return;
    }
    for (const c of rows) {
      const tr = tbody.insertRow();
      tr.insertCell().textContent = `${c.name} — ${c.type === 'movie' ? 'Películas' : 'Series'}`;
      const cells = [c.visible, c.withoutImdb, c.addedLast7Days];
      for (const v of cells) { const td = tr.insertCell(); td.className = 'num'; td.textContent = fmtNum(v); }
      const td = tr.insertCell();
      const tag = document.createElement('span');
      tag.className = 'tag ' + (c.pendingImdb ? 'warn' : c.lastFullComplete ? 'ok' : c.lastFullAt ? 'warn' : '');
      tag.textContent = c.pendingImdb
        ? `resolviendo IMDb (${fmtNum(c.pendingImdb)})`
        : c.lastFullAt ? `${ago(c.lastFullAt)}${c.lastFullComplete ? '' : ' · parcial'}` : 'pendiente';
      if (c.lastError) tag.title = c.lastError;
      td.appendChild(tag);
    }
  }

  // ------------------------------------------------------------ config

  function currentConfig() {
    return {
      platforms: state.platforms.filter((p) => state.enabled.has(p.key)).map((p) => p.key),
      types: [...document.querySelectorAll('input[name="types"]:checked')].map((i) => i.value),
      region: $('#region').value,
      language: $('#language').value,
      sort: $('#sort').value,
      layout: $('#layout').value,
    };
  }

  function encode(cfg) {
    return b64url.encode(JSON.stringify({ p: cfg.platforms, t: cfg.types, r: cfg.region, l: cfg.language, s: cfg.sort, g: cfg.layout }));
  }

  let validateTimer = 0;
  function update() {
    const cfg = currentConfig();
    const err = $('#error');
    const problems = [];
    if (!cfg.platforms.length) problems.push('Activa al menos una plataforma.');
    if (!cfg.types.length) problems.push('Elige películas, series o ambos.');
    const enc = encode(cfg);
    state.encoded = enc;
    const manifest = `${location.origin}/${enc}/manifest.json`;
    $('#manifest-url').value = manifest;
    $('#install').href = `stremio://${location.host}/${enc}/manifest.json`;
    $('#install-web').href = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifest)}`;
    const ok = problems.length === 0;
    for (const b of ['#install', '#install-web', '#copy']) $(b).classList.toggle('disabled', !ok);
    err.hidden = ok;
    err.textContent = problems.join(' ');
    $('#summary').textContent = ok ? `${cfg.platforms.length * cfg.types.length} catálogos · ${cfg.platforms.length} plataformas` : '—';
    $('#sort-hint').textContent = cfg.sort === 'new'
      ? 'Primero los títulos que Streaming Hub ha detectado como incorporados (tras la primera carga); después, por popularidad.'
      : '';
    clearTimeout(validateTimer);
    if (ok) validateTimer = setTimeout(() => validate(cfg, enc), 250);
  }

  async function validate(cfg, enc) {
    try {
      const res = await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) });
      const j = await res.json();
      if (enc !== state.encoded) return;
      const w = $('#warnings');
      w.textContent = '';
      if (!res.ok) {
        $('#error').hidden = false;
        $('#error').textContent = j.err || 'Configuración no válida';
        return;
      }
      $('#summary').textContent = `${j.catalogs} catálogos · ${cfg.platforms.length} plataformas`;
      for (const msg of j.warnings || []) { const li = document.createElement('li'); li.textContent = msg; w.appendChild(li); }
      w.hidden = !(j.warnings || []).length;
    } catch {
      /* sin conexión: la URL generada en el navegador sigue siendo válida */
    }
  }

  // --------------------------------------------------------------- init

  function fillSelect(sel, items, value) {
    sel.textContent = '';
    for (const it of items) sel.add(new Option(it.name, it.code, false, it.code === value));
  }

  function applyRegion(preset) {
    const region = state.options.regions.find((r) => r.code === $('#region').value) ?? state.options.regions[0];
    const keys = region.platforms.map((p) => p.key);
    const order = preset?.platforms?.length ? [...preset.platforms.filter((k) => keys.includes(k)), ...keys.filter((k) => !preset.platforms.includes(k))] : keys;
    state.platforms = order.map((k) => region.platforms.find((p) => p.key === k));
    state.enabled = new Set(preset?.platforms ? preset.platforms.filter((k) => keys.includes(k)) : keys);
    renderPlatforms();
  }

  async function init() {
    const [options, status] = await Promise.all([
      fetch('/api/options').then((r) => r.json()),
      fetch('/api/status').then((r) => r.json()).catch(() => null),
    ]);
    state.options = options;
    state.status = status;
    const preset = configFromUrl();
    const d = options.defaults;
    fillSelect($('#region'), options.regions.map((r) => ({ code: r.code, name: new Intl.DisplayNames(['es'], { type: 'region' }).of(r.code) || r.code })), preset?.region || d.region);
    fillSelect($('#language'), options.languages, preset?.language || d.language);
    fillSelect($('#sort'), options.sorts, preset?.sort || d.sort);
    $('#layout').value = preset?.layout || d.layout;
    if (preset?.types) document.querySelectorAll('input[name="types"]').forEach((i) => { i.checked = preset.types.includes(i.value); });
    $('#version').textContent = `v${options.version}`;
    applyRegion(preset);
    renderStatus();
    update();

    $('#form').addEventListener('change', (e) => {
      if (e.target.id === 'region') { applyRegion(null); renderStatus(); }
      update();
    });
    $('#all-on').addEventListener('click', () => { state.platforms.forEach((p) => state.enabled.add(p.key)); renderPlatforms(); update(); });
    $('#all-off').addEventListener('click', () => { state.enabled.clear(); renderPlatforms(); update(); });
    $('#copy').addEventListener('click', async () => {
      const btn = $('#copy');
      try { await navigator.clipboard.writeText($('#manifest-url').value); btn.textContent = 'Copiada ✓'; }
      catch { $('#manifest-url').select(); btn.textContent = 'Selecciona y copia'; }
      setTimeout(() => { btn.textContent = 'Copiar URL'; }, 1800);
    });
    setInterval(async () => {
      try {
        state.status = await fetch('/api/status').then((r) => r.json());
        renderStatus();
        // Solo se actualizan los recuentos para no interrumpir una reordenación en curso.
        document.querySelectorAll('#platforms li').forEach((li) => { li.querySelector('.counts').textContent = counts(li.dataset.key); });
      } catch { /* reintento en el siguiente ciclo */ }
    }, 60_000);
  }

  init().catch((e) => {
    $('#error').hidden = false;
    $('#error').textContent = 'No se pudo cargar la configuración: ' + e.message;
  });
})();
