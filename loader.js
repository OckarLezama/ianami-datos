/**
 * loader.js — IA-NAMI (datos migratorios)  v3
 * ────────────────────────────────────────────────────────────────
 * Repo: github.com/OckarLezama/ianami-datos
 *
 * Estructura que produce en window.DB:
 *
 *   DB.<nombre>_monthly = {
 *     "YYYY-MM": { col1: suma, col2: suma, ..., total: suma_total }
 *   }
 *
 *   DB.<nombre>_<dim>_monthly = {            // datasets agrupados
 *     "YYYY-MM": { "CHIAPAS": 234, "CAMPECHE": 12, ... }
 *   }
 * ────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════
  // CONFIGURACIÓN
  // ════════════════════════════════════════════════════════════════
  const GITHUB_USER   = 'OckarLezama';
  const GITHUB_REPO   = 'ianami-datos';     // ← URL CORRECTA
  const GITHUB_BRANCH = 'main';
  const BASE_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/`;

  /**
   * Cada dataset:
   *   file     → nombre del CSV en GitHub
   *   key      → clave en window.DB (agregado total por mes)
   *   groupBy  → (opcional) datasets adicionales agrupados por mes + columna
   *              columnHints son nombres alternativos de la columna por si
   *              varían entre CSVs (mayúsculas, acentos, etc.)
   */
  const DATASETS = [
    { file: 'Presentados.csv',                    key: 'presentados_monthly' },
    {
      file: 'Rescatados.csv',                     key: 'rescatados_monthly',
      groupBy: [
        { key: 'resc_or_monthly',  columnHints: ['Estado / O.R.', 'Estado', 'OR', 'Estado/OR'] },
        { key: 'resc_nac_monthly', columnHints: ['NACIONALIDAD', 'Nacionalidad', 'Nacionalidad/Origen'] }
      ]
    },
    { file: 'Canalizados.csv',                    key: 'can_monthly' },
    { file: 'Retornados.csv',                     key: 'retornados_monthly' },
    { file: 'Extranjeros_recibidos.csv',          key: 'ext_monthly' },
    { file: 'Mexicanos_Recibidos.csv',            key: 'mx_monthly' },
    {
      file: 'Encuentros.csv',                     key: 'encuentros_monthly',
      groupBy: [
        { key: 'enc_ciudad_monthly', columnHints: ['CIUDAD', 'Ciudad', 'Ciudad / Localidad', 'Localidad'] },
        { key: 'enc_estado_monthly', columnHints: ['Estado / O.R.', 'Estado', 'ESTADO', 'OR'] }
      ]
    },
    { file: 'Inadmisiones.csv',                   key: 'inad_monthly' },
    { file: 'Condicion_de_Estancia.csv',          key: 'estancia_monthly' },
    { file: 'Internaciones.csv',                  key: 'internaciones_monthly' },
    { file: 'Motivo_de_Estancia.csv',             key: 'motivo_monthly' },
    { file: 'Caravanas_2019_2026.csv',            key: 'caravanas_monthly' },
    { file: 'Estados_Frontera.csv',               key: 'frontera_monthly' },
    { file: 'Cinturones_Contencion.csv',          key: 'cinturones_monthly' },
    { file: 'Centro_Coordinador_Operaciones.csv', key: 'cco_monthly' }
  ];

  const DATE_COLUMN_HINTS  = ['DIA', 'Dia', 'FECHA', 'Fecha', 'fecha'];
  const FETCH_TIMEOUT_MS   = 60000;
  const FLUSH_MAX_ATTEMPTS = 30;

  // ════════════════════════════════════════════════════════════════
  // ESTADO GLOBAL
  // ════════════════════════════════════════════════════════════════
  window.DB = window.DB || {};

  // Pre-pobla TODAS las claves (principales y agrupadas) con {} para
  // que Object.entries(...) no truene si refreshDashboard corre antes.
  const ALL_KEYS = [];
  DATASETS.forEach(d => {
    ALL_KEYS.push(d.key);
    (d.groupBy || []).forEach(g => ALL_KEYS.push(g.key));
  });
  ALL_KEYS.forEach(k => {
    if (typeof window.DB[k] !== 'object' || window.DB[k] === null || Array.isArray(window.DB[k])) {
      window.DB[k] = {};
    }
  });

  window.IANAMI_READY = false;
  window.IANAMI_LOAD_ERROR = null;

  const pendingRefreshCalls = [];
  let realRefreshDashboard = null;

  // ════════════════════════════════════════════════════════════════
  // INTERCEPTOR DE refreshDashboard
  // ════════════════════════════════════════════════════════════════
  Object.defineProperty(window, 'refreshDashboard', {
    configurable: true,
    enumerable: true,
    get() {
      return function refreshDashboard_wrapper(...args) {
        if (!window.IANAMI_READY) {
          console.log('[IA-NAMI] ⏳ refreshDashboard encolada (datos cargando)…');
          pendingRefreshCalls.push(args);
          return;
        }
        if (typeof realRefreshDashboard !== 'function') {
          console.warn('[IA-NAMI] refreshDashboard llamada pero aún no definida');
          return;
        }
        try { return realRefreshDashboard.apply(this, args); }
        catch (err) { console.error('[IA-NAMI] Error en refreshDashboard:', err); throw err; }
      };
    },
    set(fn) { realRefreshDashboard = fn; }
  });

  // ════════════════════════════════════════════════════════════════
  // UTILIDADES
  // ════════════════════════════════════════════════════════════════
  function toYearMonth(dateStr) {
    if (!dateStr) return null;
    const s = String(dateStr).trim();
    if (!s) return null;

    let m = s.match(/^(\d{4})-(\d{1,2})-\d{1,2}/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;

    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10), y = m[3];
      const month = (a > 12) ? b : (b > 12 ? a : b);
      return `${y}-${String(month).padStart(2, '0')}`;
    }

    m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-]\d{1,2}/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;

    return null;
  }

  function pickColumn(rows, hints) {
    if (!rows.length) return null;
    const headers = Object.keys(rows[0]);
    // 1. Coincidencia exacta
    for (const h of hints) if (headers.includes(h)) return h;
    // 2. Coincidencia insensible a case/acentos/espacios
    const normalize = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
    for (const h of hints) {
      const nh = normalize(h);
      for (const header of headers) {
        if (normalize(header) === nh) return header;
      }
    }
    // 3. Coincidencia parcial
    for (const h of hints) {
      const nh = normalize(h);
      for (const header of headers) {
        if (normalize(header).includes(nh) || nh.includes(normalize(header))) return header;
      }
    }
    return null;
  }

  function detectNumericColumns(rows, excludeCols) {
    if (!rows.length) return [];
    const exclude = new Set(excludeCols.filter(Boolean));
    const candidates = Object.keys(rows[0]).filter(c => !exclude.has(c));
    const numeric = [];
    candidates.forEach(col => {
      for (let i = 0; i < Math.min(rows.length, 50); i++) {
        const v = rows[i][col];
        if (v !== '' && v !== null && v !== undefined) {
          const n = Number(String(v).replace(/,/g, ''));
          if (!isNaN(n)) { numeric.push(col); return; }
        }
      }
    });
    return numeric;
  }

  function rowNumericTotal(row, numericCols) {
    let total = 0;
    numericCols.forEach(c => {
      const raw = row[c];
      if (raw === '' || raw === null || raw === undefined) return;
      const n = Number(String(raw).replace(/,/g, ''));
      if (!isNaN(n)) total += n;
    });
    return total;
  }

  /**
   * Agregado principal: por mes, suma de cada columna numérica + total.
   */
  function aggregateMonthly(rows, dateCol, numericCols) {
    const out = {};
    rows.forEach(row => {
      const ym = toYearMonth(row[dateCol]);
      if (!ym) return;
      if (!out[ym]) {
        out[ym] = { total: 0 };
        numericCols.forEach(c => { out[ym][c] = 0; });
      }
      numericCols.forEach(c => {
        const raw = row[c];
        if (raw === '' || raw === null || raw === undefined) return;
        const n = Number(String(raw).replace(/,/g, ''));
        if (!isNaN(n)) { out[ym][c] += n; out[ym].total += n; }
      });
    });
    return out;
  }

  /**
   * Agregado por dimensión: { "YYYY-MM": { "VALOR_DIM": total_numerico, ... } }
   */
  function aggregateByDimension(rows, dateCol, dimCol, numericCols) {
    const out = {};
    rows.forEach(row => {
      const ym = toYearMonth(row[dateCol]);
      if (!ym) return;
      const dim = row[dimCol];
      if (dim === '' || dim === null || dim === undefined) return;
      const key = String(dim).trim();
      if (!key) return;
      if (!out[ym]) out[ym] = {};
      if (!out[ym][key]) out[ym][key] = 0;
      out[ym][key] += rowNumericTotal(row, numericCols);
    });
    return out;
  }

  // ════════════════════════════════════════════════════════════════
  // CARGA DE UN CSV
  // ════════════════════════════════════════════════════════════════
  function loadCSV(url, key) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error(`Timeout (${FETCH_TIMEOUT_MS}ms) cargando ${key}`)); }
      }, FETCH_TIMEOUT_MS);

      Papa.parse(url, {
        download: true,
        header: true,
        skipEmptyLines: 'greedy',
        transformHeader: h => (h || '').trim(),
        transform: v => (typeof v === 'string' ? v.trim() : v),
        complete: (results) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (results.errors && results.errors.length) {
            console.warn(`[IA-NAMI] ⚠ ${key}: ${results.errors.length} advertencia(s) de parseo`);
          }
          resolve(results.data || []);
        },
        error: (err) => {
          if (settled) return;
          settled = true; clearTimeout(timer); reject(err);
        }
      });
    });
  }

  // ════════════════════════════════════════════════════════════════
  // CARGA PRINCIPAL
  // ════════════════════════════════════════════════════════════════
  async function loadAllData() {
    if (typeof Papa === 'undefined') {
      const msg = 'PapaParse no encontrado. Inclúyelo ANTES de loader.js';
      console.error('[IA-NAMI] ✗', msg);
      window.IANAMI_LOAD_ERROR = msg;
      window.IANAMI_READY = true;
      flushPendingRefreshCalls();
      return;
    }

    console.log(`[IA-NAMI] 🚀 Cargando ${DATASETS.length} CSV(s) desde ${BASE_URL}`);
    const t0 = performance.now();

    const results = await Promise.allSettled(
      DATASETS.map(d => loadCSV(BASE_URL + d.file, d.key).then(rows => ({ d, rows })))
    );

    let okCount = 0;
    const failures = [];

    results.forEach((res, i) => {
      const d = DATASETS[i];
      if (res.status !== 'fulfilled') {
        window.DB[d.key] = {};
        (d.groupBy || []).forEach(g => { window.DB[g.key] = {}; });
        failures.push({ file: d.file, key: d.key, error: res.reason });
        console.error(`[IA-NAMI] ✗ ${d.key} (${d.file}):`, res.reason?.message || res.reason);
        return;
      }

      const rows = res.value.rows;
      if (!rows.length) {
        console.warn(`[IA-NAMI] ⚠ ${d.key}: archivo vacío`);
        return;
      }

      const dateCol = pickColumn(rows, DATE_COLUMN_HINTS);
      if (!dateCol) {
        console.warn(`[IA-NAMI] ⚠ ${d.key}: no se encontró columna de fecha (${DATE_COLUMN_HINTS.join(', ')})`);
        return;
      }

      // Columnas dimensionales a excluir del numérico
      const dimCols = (d.groupBy || [])
        .map(g => pickColumn(rows, g.columnHints))
        .filter(Boolean);

      const numericCols = detectNumericColumns(rows, [dateCol, ...dimCols]);

      // Agregado principal
      window.DB[d.key] = aggregateMonthly(rows, dateCol, numericCols);
      const months = Object.keys(window.DB[d.key]).length;
      console.log(`[IA-NAMI] ✓ ${d.key}: ${rows.length} filas → ${months} mes(es)  [cols: ${numericCols.join(',') || '∅'}]`);

      // Agregados por dimensión
      (d.groupBy || []).forEach(g => {
        const dimCol = pickColumn(rows, g.columnHints);
        if (!dimCol) {
          console.warn(`[IA-NAMI] ⚠ ${g.key}: no se encontró columna (${g.columnHints.join(', ')}) en ${d.file}`);
          window.DB[g.key] = {};
          return;
        }
        window.DB[g.key] = aggregateByDimension(rows, dateCol, dimCol, numericCols);
        const mm = Object.keys(window.DB[g.key]).length;
        console.log(`[IA-NAMI]   ↳ ${g.key} (por "${dimCol}"): ${mm} mes(es)`);
      });

      okCount++;
    });

    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

    if (okCount === 0) {
      const msg = `Ningún CSV cargó. Revisa URL base: ${BASE_URL}`;
      console.error('[IA-NAMI] ✗ FATAL:', msg);
      window.IANAMI_LOAD_ERROR = msg;
      window.dispatchEvent(new CustomEvent('ianami-error', { detail: { message: msg, failures } }));
    } else if (failures.length) {
      console.warn(`[IA-NAMI] ⚠ Carga parcial: ${failures.length}/${DATASETS.length} archivo(s) fallaron`);
    }

    console.log(`[IA-NAMI] ✅ Listo: ${okCount}/${DATASETS.length} datasets en ${elapsed}s`);

    window.IANAMI_READY = true;
    window.dispatchEvent(new CustomEvent('ianami-loaded', { detail: { DB: window.DB, datasets: okCount, failures } }));
    flushPendingRefreshCalls();
  }

  // ════════════════════════════════════════════════════════════════
  // EJECUTAR LLAMADAS ENCOLADAS
  // ════════════════════════════════════════════════════════════════
  function flushPendingRefreshCalls(attempt = 0) {
    if (typeof realRefreshDashboard !== 'function') {
      if (attempt < FLUSH_MAX_ATTEMPTS) { setTimeout(() => flushPendingRefreshCalls(attempt + 1), 50); }
      else console.warn('[IA-NAMI] refreshDashboard nunca quedó definida');
      return;
    }
    if (pendingRefreshCalls.length === 0) {
      console.log('[IA-NAMI] Disparando refreshDashboard inicial');
      try { realRefreshDashboard(); }
      catch (err) { console.error('[IA-NAMI] Error en refreshDashboard inicial:', err); }
      return;
    }
    console.log(`[IA-NAMI] Ejecutando refreshDashboard tras ${pendingRefreshCalls.length} llamada(s) encolada(s)`);
    const lastArgs = pendingRefreshCalls[pendingRefreshCalls.length - 1];
    pendingRefreshCalls.length = 0;
    try { realRefreshDashboard.apply(window, lastArgs); }
    catch (err) { console.error('[IA-NAMI] Error en refreshDashboard encolada:', err); }
  }

  // ════════════════════════════════════════════════════════════════
  // ARRANQUE
  // ════════════════════════════════════════════════════════════════
  if (typeof Papa !== 'undefined') {
    loadAllData();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAllData, { once: true });
  } else {
    console.error('[IA-NAMI] PapaParse no encontrado y DOM ya listo');
  }

  // ════════════════════════════════════════════════════════════════
  // API DE DEBUG (consola del navegador)
  // ════════════════════════════════════════════════════════════════
  window.IANAMI = {
    reload: loadAllData,
    DB: () => window.DB,
    status: () => ({
      ready:    window.IANAMI_READY,
      error:    window.IANAMI_LOAD_ERROR,
      pending:  pendingRefreshCalls.length,
      datasets: Object.fromEntries(ALL_KEYS.map(k => [k, Object.keys(window.DB[k] || {}).length + ' meses']))
    }),
    peek: (key) => {
      const obj = window.DB[key];
      if (!obj) return `No existe DB.${key}`;
      const months = Object.keys(obj).sort();
      const sample = {};
      months.slice(0, 3).forEach(m => { sample[m] = obj[m]; });
      return { totalMeses: months.length, primerosTres: sample };
    }
  };

})();
