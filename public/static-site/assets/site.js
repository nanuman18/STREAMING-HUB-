(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  // Base del sitio (funciona en https://usuario.github.io/repo/ y en un dominio propio).
  const base = new URL('.', location.href).href;
  let site = null;

  const fmtNum = (n) => (n ?? 0).toLocaleString('es-ES');
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : 'nunca');
  const ago = (ms) => {
    if (!ms) return 'nunca';
    const h = (Date.now() - ms) / 3_600_000;
    if (h < 1) return `hace ${Math.max(1, Math.round(h * 60))} min`;
    if (h < 48) return `hace ${Math.round(h)} h`;
    return `hace ${Math.round(h / 24)} días`;
  };

  const manifestUrl = (key, sort) => `${base}${key}/${sort}/manifest.json`;

  function counts(key) {
    const cats = site.status.regions[0]?.catalogs ?? [];
    const m = cats.find((c) => c.platform === key && c.type === 'movie');
    const s = cats.find((c) => c.platform === key && c.type === 'series');
    return `${fmtNum(m?.visible)} películas · ${fmtNum(s?.visible)} series`;
  }

  function renderPlatforms() {
    const sort = $('#sort').value;
    const list = $('#platforms');
    list.textContent = '';
    for (const p of site.platforms) {
      const url = manifestUrl(p.key, sort);
      const li = document.createElement('li');
      li.className = 'platform' + (params.get('platform') === p.key ? ' selected' : '');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;
      const c = document.createElement('span');
      c.className = 'counts';
      c.textContent = counts(p.key);
      name.appendChild(c);

      const actions = document.createElement('span');
      actions.className = 'actions-row';
      const install = document.createElement('a');
      install.className = 'btn small primary';
      install.href = url.replace(/^https?:\/\//, 'stremio://');
      install.textContent = 'Instalar';
      install.setAttribute('aria-label', `Instalar ${p.name} en Stremio`);
      const web = document.createElement('a');
      web.className = 'btn small';
      web.href = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(url)}`;
      web.target = '_blank';
      web.rel = 'noopener';
      web.textContent = 'Web';
      web.setAttribute('aria-label', `Abrir ${p.name} en Stremio Web`);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn small';
      copy.textContent = 'Copiar';
      copy.setAttribute('aria-label', `Copiar la URL de ${p.name}`);
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(url);
          copy.textContent = 'Copiada ✓';
        } catch {
          window.prompt('Copia la URL del addon:', url);
        }
        setTimeout(() => { copy.textContent = 'Copiar'; }, 1800);
      });
      actions.append(install, web, copy);
      li.append(name, actions);
      list.appendChild(li);
    }
    $('#sort-hint').textContent = sort === 'new'
      ? 'Primero los títulos detectados como incorporados después de la primera carga; después, por popularidad.'
      : '';
  }

  function renderStatus() {
    const s = site.status;
    const el = $('#status');
    const last = s.lastUpdate || site.generatedAt;
    el.className = 'status ' + (Date.now() - last > 48 * 3_600_000 ? 'stale' : 'ok');
    $('#status-text').textContent = `Datos actualizados ${ago(last)}`;
    $('#last-update').textContent = fmtDate(last);
    $('#limits').textContent = `Cada catálogo muestra hasta ${fmtNum(site.maxTitlesPerCatalog)} títulos (también dentro de cada género).`;

    const order = new Map(site.platforms.map((p, i) => [p.key, i]));
    const rows = (s.regions[0]?.catalogs ?? []).filter((c) => order.has(c.platform))
      .sort((a, b) => order.get(a.platform) - order.get(b.platform) || a.type.localeCompare(b.type));
    const tbody = $('#stats tbody');
    tbody.textContent = '';
    for (const c of rows) {
      const tr = tbody.insertRow();
      tr.insertCell().textContent = `${c.name} — ${c.type === 'movie' ? 'Películas' : 'Series'}`;
      for (const v of [c.visible, c.withoutImdb, c.addedLast7Days]) {
        const td = tr.insertCell();
        td.className = 'num';
        td.textContent = fmtNum(v);
      }
      const td = tr.insertCell();
      const tag = document.createElement('span');
      tag.className = 'tag ' + (c.lastFullComplete ? 'ok' : c.lastFullAt ? 'warn' : '');
      tag.textContent = c.lastFullAt ? `${ago(c.lastFullAt)}${c.lastFullComplete ? '' : ' · parcial'}` : 'pendiente';
      if (c.lastError) tag.title = c.lastError;
      td.appendChild(tag);
    }
  }

  async function init() {
    site = await fetch('site.json', { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`site.json → ${r.status}`);
      return r.json();
    });
    const sel = $('#sort');
    for (const s of site.sorts) sel.add(new Option(s.name, s.code));
    const wanted = params.get('sort');
    if (wanted && site.sorts.some((s) => s.code === wanted)) sel.value = wanted;
    sel.addEventListener('change', renderPlatforms);
    renderPlatforms();
    renderStatus();
  }

  init().catch((e) => {
    $('#error').hidden = false;
    $('#error').textContent = 'No se pudieron cargar los datos: ' + e.message;
    $('#status-text').textContent = 'Sin datos';
  });
})();
