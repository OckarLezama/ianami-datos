/* ============================================================ 
 *  IA-NAMI · loader.js
 *  Carga automática de 15 CSVs desde GitHub → window.DB
 *  Paleta institucional CDMX 2024–2030
 *  Sin dependencias del HTML existente (auto-inyecta UI + PapaParse)
 * ============================================================ */

(function () {
  'use strict';

  // ---------- Configuración ----------
  const GITHUB_BASE =
    'https://raw.githubusercontent.com/OckarLezama/ianami-datos/refs/heads/main/';

  const CSV_FILES = [
    'Presentados.csv',
    'Rescatados.csv',
    'Canalizados.csv',
    'Retornados.csv',
    'Extranjeros_recibidos.csv',
    'Mexicanos_Recibidos.csv',
    'Encuentros.csv',
    'Inadmisiones.csv',
    'Condicion_de_Estancia.csv',
    'Internaciones.csv',
    'Motivo_de_Estancia.csv',
    'Caravanas_2019_2026.csv',
    'Estados_Frontera.csv',
    'Cinturones_Contencion.csv',
    'Centro_Coordinador_Operaciones.csv'
  ];

  // Paleta institucional CDMX
  const COLORS = {
    rojo:  '#B66666',
    arena: '#BDB58D',
    verde: '#778E88',
    crema: '#E5E2D3',
    gris:  '#808080'
  };

  const PAPA_CDN =
    'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js';

  // Inicializa el contenedor global
  window.DB = window.DB || {};

  // ---------- UI: overlay + barra de progreso ----------
  function createProgressUI() {
    const overlay = document.createElement('div');
    overlay.id = 'ianami-loader-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0;
      background: rgba(229, 226, 211, 0.97);
      z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      transition: opacity .4s ease;
    `;

    const card = document.createElement('div');
    card.style.cssText = `
      width: min(560px, 88vw);
      background: #ffffff;
      border-radius: 12px;
      padding: 28px 32px 24px;
      box-shadow: 0 12px 40px rgba(0,0,0,.14);
      border-top: 4px solid ${COLORS.rojo};
    `;

    const title = document.createElement('div');
    title.textContent = 'IA-NAMI · Cargando datos';
    title.style.cssText = `
      font-size: 17px; font-weight: 600;
      color: ${COLORS.verde}; letter-spacing: .3px;
      margin-bottom: 4px;
    `;

    const subtitle = document.createElement('div');
    subtitle.id = 'ianami-loader-subtitle';
    subtitle.textContent = 'Inicializando…';
    subtitle.style.cssText = `
      font-size: 13px; color: ${COLORS.gris};
      margin-bottom: 18px;
    `;

    const barWrap = document.createElement('div');
    barWrap.style.cssText = `
      width: 100%; height: 10px;
      background: ${COLORS.crema};
      border-radius: 6px; overflow: hidden;
      border: 1px solid rgba(0,0,0,.04);
    `;

    const bar = document.createElement('div');
    bar.id = 'ianami-loader-bar';
    bar.style.cssText = `
      height: 100%; width: 0%;
      background: linear-gradient(90deg, ${COLORS.verde} 0%, ${COLORS.arena} 100%);
      transition: width .25s ease;
    `;
    barWrap.appendChild(bar);

    const stats = document.createElement('div');
    stats.style.cssText = `
      display: flex; justify-content: space-between;
      margin-top: 10px;
      font-size: 12px; color: ${COLORS.gris};
      font-variant-numeric: tabular-nums;
    `;
    stats.innerHTML =
      `<span id="ianami-loader-count">0 / ${CSV_FILES.length}</span>` +
      `<span id="ianami-loader-pct">0%</span>`;

    const log = document.createElement('div');
    log.id = 'ianami-loader-log';
    log.style.cssText = `
      margin-top: 16px; max-height: 96px; overflow-y: auto;
      font-size: 11px; color: ${COLORS.gris};
      font-family: 'SF Mono', Monaco, Consolas, 'Courier New', monospace;
      line-height: 1.65;
      border-top: 1px dashed ${COLORS.crema};
      padding-top: 10px;
    `;

    card.append(title, subtitle, barWrap, stats, log);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    return {
      overlay,
      bar:      document.getElementById('ianami-loader-bar'),
      subtitle: document.getElementById('ianami-loader-subtitle'),
      count:    document.getElementById('ianami-loader-count'),
      pct:      document.getElementById('ianami-loader-pct'),
      log:      document.getElementById('ianami-loader-log')
    };
  }

  function updateProgress(ui, loaded, total, file, status) {
    const pct = Math.round((loaded / total) * 100);
    ui.bar.style.width = pct + '%';
    ui.count.textContent = `${loaded} / ${total}`;
    ui.pct.textContent = pct + '%';

    if (file) {
      ui.subtitle.textContent = `Procesando: ${file}`;
      const line = document.createElement('div');
      const icon  = status === 'ok' ? '✓' : status === 'err' ? '✗' : '·';
      const color = status === 'ok' ? COLORS.verde : status === 'err' ? COLORS.rojo : COLORS.gris;
      line.innerHTML =
        `<span style="color:${color};font-weight:700;">${icon}</span> ${file}`;
      ui.log.appendChild(line);
      ui.log.scrollTop = ui.log.scrollHeight;
    }
  }

  function dismissUI(ui, ok) {
    if (ok) {
      ui.subtitle.textContent = '¡Listo! Inicializando aplicación…';
      ui.bar.style.background = COLORS.verde;
      setTimeout(() => {
        ui.overlay.style.opacity = '0';
        setTimeout(() => ui.overlay.remove(), 400);
      }, 600);
    } else {
      ui.subtitle.textContent = 'Error en la carga. Revisa la consola.';
      ui.subtitle.style.color = COLORS.rojo;
    }
  }

  // ---------- Carga dinámica de PapaParse ----------
  function loadPapaParse() {
    return new Promise((resolve, reject) => {
      if (window.Papa) return resolve();
      const s = document.createElement('script');
      s.src = PAPA_CDN;
      s.async = true;
      s.onload  = () => resolve();
      s.onerror = () => reject(new Error('No se pudo cargar PapaParse desde el CDN.'));
      document.head.appendChild(s);
    });
  }

  // ---------- Fetch + parseo de un CSV ----------
  function fileToKey(filename) {
    // Convierte "Presentados.csv" -> "Presentados"
    return filename.replace(/\.csv$/i, '');
  }

  function fetchAndParseCSV(filename, ui, state) {
    const url = GITHUB_BASE + encodeURIComponent(filename);

    return fetch(url, { cache: 'no-cache' })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status} – ${filename}`);
        return res.text();
      })
      .then(text => new Promise((resolve, reject) => {
        window.Papa.parse(text, {
          header: true,
          dynamicTyping: true,
          skipEmptyLines: true,
          transformHeader: h => (h || '').trim(),
          complete: (results) => {
            const key = fileToKey(filename);
            window.DB[key] = results.data;
            state.loaded++;
            updateProgress(ui, state.loaded, CSV_FILES.length, filename, 'ok');
            resolve({ filename, rows: results.data.length, ok: true });
          },
          error: (err) => reject(err)
        });
      }))
      .catch(err => {
        // No abortamos el resto: registramos el error y seguimos.
        state.loaded++;
        window.DB[fileToKey(filename)] = [];
        updateProgress(ui, state.loaded, CSV_FILES.length, `${filename} (error)`, 'err');
        console.error(`[IA-NAMI loader] ${filename}:`, err);
        return { filename, rows: 0, ok: false, error: err.message };
      });
  }

  // ---------- Flujo principal ----------
  function start() {
    const ui = createProgressUI();
    updateProgress(ui, 0, CSV_FILES.length, null, null);
    ui.subtitle.textContent = 'Cargando librería PapaParse…';

    loadPapaParse()
      .then(() => {
        ui.subtitle.textContent = `Descargando ${CSV_FILES.length} archivos en paralelo…`;
        const state = { loaded: 0 };
        // ===== Promise.all → carga paralela =====
        return Promise.all(CSV_FILES.map(f => fetchAndParseCSV(f, ui, state)));
      })
      .then(results => {
        const totalRows = results.reduce((s, r) => s + r.rows, 0);
        const errors    = results.filter(r => !r.ok);

        console.log(
          `%c[IA-NAMI loader] Carga completa%c — ${results.length} archivos · ` +
          `${totalRows.toLocaleString('es-MX')} registros`,
          `color:${COLORS.verde};font-weight:700;`, 'color:inherit;'
        );
        if (errors.length) {
          console.warn(`[IA-NAMI loader] ${errors.length} archivo(s) con error:`, errors);
        }
        console.log('[IA-NAMI loader] window.DB =', window.DB);

        dismissUI(ui, true);

        // ===== Lanzar el inicializador de la app =====
        setTimeout(() => {
          if (typeof window.initApp === 'function') {
            console.log('[IA-NAMI loader] Ejecutando window.initApp()…');
            window.initApp();
          } else if (typeof window.renderAll === 'function') {
            console.log('[IA-NAMI loader] Ejecutando window.renderAll()…');
            window.renderAll();
          } else {
            console.warn(
              '[IA-NAMI loader] No se encontró window.initApp() ni window.renderAll(). ' +
              'Los datos están disponibles en window.DB. ' +
              'Se emitió el evento "ianami:ready".'
            );
          }
          // Evento adicional por si el HTML prefiere escucharlo
          window.dispatchEvent(new CustomEvent('ianami:ready', { detail: { DB: window.DB } }));
        }, 650);
      })
      .catch(err => {
        console.error('[IA-NAMI loader] Error fatal:', err);
        dismissUI(ui, false);
      });
  }

  // ---------- Arranque ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
window.addEventListener('ianami-loaded', function() {
  if (typeof renderDashboard === 'function') renderDashboard();
  if (typeof initCharts === 'function') initCharts();
  if (typeof updateKPIs === 'function') updateKPIs();
  if (typeof renderAll === 'function') renderAll();
});
