(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
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

  function catalog(key, type) {
    return (site.status.regions[0]?.catalogs ?? []).find((c) => c.platform === key && c.type === type);
  }

  function renderInstall() {
    // La URL del manifiesto es la de esta página: así coincide con la que usan los enlaces internos.
    const url = new URL('manifest.json', location.href).href;
    if (url !== site.manifestUrl) console.warn('El sitio se generó para', site.manifestUrl, 'y se está viendo en', url);
    $('#manifest-url').value = site.manifestUrl;
    $('#install').href = site.manifestUrl.replace(/^https?:\/\//, 'stremio://');
    $('#install-web').href = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(site.manifestUrl)}`;
    $('#summary').textContent = `${site.platforms.length} plataformas · un único addon`;
    $('#limits').textContent = `Cada catálogo muestra hasta ${fmtNum(site.maxTitlesPerCatalog)} títulos, también dentro de cada género.`;
    $('#copy').addEventListener('click', async () => {
      const btn = $('#copy');
      try {
        await navigator.clipboard.writeText(site.manifestUrl);
        btn.textContent = 'Copiada ✓';
      } catch {
        $('#manifest-url').select();
        btn.textContent = 'Selecciona y copia';
      }
      setTimeout(() => { btn.textContent = 'Copiar URL'; }, 1800);
    });
  }

  function renderPlatforms() {
    const list = $('#platforms');
    list.textContent = '';
    for (const p of site.platforms) {
      const li = document.createElement('li');
      if (p.logo) {
        const img = document.createElement('img');
        img.src = p.logo;
        img.alt = '';
        img.loading = 'lazy';
        li.appendChild(img);
      }
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;
      const c = document.createElement('span');
      c.className = 'counts';
      c.textContent = `${fmtNum(catalog(p.key, 'movie')?.visible)} películas · ${fmtNum(catalog(p.key, 'series')?.visible)} series`;
      name.appendChild(c);
      li.appendChild(name);
      list.appendChild(li);
    }
  }

  function renderStatus() {
    const s = site.status;
    const last = s.lastUpdate || site.generatedAt;
    $('#status').className = 'status ' + (Date.now() - last > 48 * 3_600_000 ? 'stale' : 'ok');
    $('#status-text').textContent = `Datos actualizados ${ago(last)}`;
    $('#last-update').textContent = fmtDate(last);

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
    renderInstall();
    renderPlatforms();
    renderStatus();
  }

  init().catch((e) => {
    $('#error').hidden = false;
    $('#error').textContent = 'No se pudieron cargar los datos: ' + e.message;
    $('#status-text').textContent = 'Sin datos';
  });
})();
