/**
 * loader.js — IA-NAMI (datos migratorios)
 * ────────────────────────────────────────────────────────────────
 * Qué hace:
 *   1. Baja cada CSV desde GitHub (PapaParse).
 *   2. Convierte la columna DIA (DD/MM/YYYY) a YYYY-MM.
 *   3. Suma todas las columnas numéricas agrupando por mes.
 *   4. Guarda el resultado en window.DB.<clave>_monthly como objeto
 *      { "YYYY-MM": { col1: suma, col2: suma, ..., total: suma_total } }.
 *   5. BLOQUEA refreshDashboard() hasta terminar (encolando llamadas
 *      tempranas y haciendo replay).
 *   6. Dispara el evento 'ianami-loaded' al completar.
 *
 * HTML requiere:
 *   - window.DB = {}     en lugar de  let DB = {}
 *   - <script> de papaparse ANTES de este loader
 *   - <script src="loader.js"></script>   ANTES del <script> principal
 *
 * Si una clave no coincide con lo que tu dashboard espera (p.ej.
 * tu código usa DB.internaciones_monthly pero aquí dice intern_monthly),
 * ajusta el campo `key` en la tabla DATASETS de abajo.
 * ────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════
  // CONFIGURACIÓN
  // ════════════════════════════════════════════════════════════════
  const GITHUB_USER   = 'OckarLezama';
  const GITHUB_REPO   = 'Datos';
  const GITHUB_BRANCH = 'main';
  const BASE_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/`;

  // Mapeo: archivo → clave en window.DB
  // Si tu código del dashboard usa otro nombre, cambia solo la columna `key`.
  // Los archivos deben coincidir EXACTAMENTE (mayúsculas/minúsculas) con el repo.
  const DATASETS = [
    { file: 'Presentados.csv',                    key: 'presentados_monthly'  },
    { file: 'Rescatados.csv',                     key: 'rescatados_monthly'   },
    { file: 'Canalizados.csv',                    key: 'canalizados_monthly'  },
    { file: 'Retornados.csv',                     key: 'retornados_monthly'   },
    { file: 'Extranjeros_recibidos.csv',          key: 'extranjeros_monthly'  },
    { file: 'Mexicanos_Recibidos.csv',            key: 'mexicanos_monthly'    },
    { file: 'Encuentros.csv',                     key: 'encuentros_monthly'   },
    { file: 'Inadmisiones.csv',                   key: 'inadmisiones_monthly' },
    { file: 'Condicion_de_Estancia.csv',          key: 'condicion_monthly'    },
    { file: 'Internaciones.csv',                  key: 'intern_monthly'       },
    { file: 'Motivo_de_Estancia.csv',             key: 'motivo_monthly'       },
    { file: 'Caravanas_2019_2026.csv',            key: 'caravanas_monthly'    },
    { file: 'Estados_Frontera.csv',               key: 'frontera_monthly'     },
    { file: 'Cinturones_Contencion.csv',          key: 'cinturones_monthly'   },
    { file: 'Centro_Coordinador_Operaciones.csv', key: 'cco_monthly'          }
  ];

  const DATE_COLUMN        = 'DIA';   // columna con la fecha en todos los CSVs
  const FETCH_TIMEOUT_MS   = 45000;   // 45 s por archivo
  const FLUSH_MAX_ATTEMPTS = 20;      // espera hasta 1 s a que el HTML defina refreshDashboard

  // ════════════════════════════════════════════════════════════════
  // ESTADO GLOBAL
  // ════════════════════════════════════════════════════════════════
  window.DB = window.DB || {};

  // Pre-pobla con {} para que Object.entries(DB.xxx_monthly) NO truene
  // si refreshDashboard se ejecutara antes de tiempo.
  DATASETS.forEach(d => {
    if (typeof window.DB[d.key] !== 'object' || window.DB[d.key] === null || Array.isArray(window.DB[d.key])) {
      window.DB[d.key] = {};
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
        try {
          return realRefreshDashboard.apply(this, args);
        } catch (err) {
          console.error('[IA-NAMI] Error en refreshDashboard:', err);
          throw err;
        }
      };
    },
    set(fn) {
      realRefreshDashboard = fn;
    }
  });

  // ════════════════════════════════════════════════════════════════
  // UTILIDADES
  // ════════════════════════════════════════════════════════════════

  /**
   * Convierte "01/10/2024" (DD/MM/YYYY) → "2024-10".
   * También acepta "2024-10-01" (ISO) y "10/01/2024" si detecta día > 12.
   */
  function toYearMonth(dateStr) {
    if (!dateStr) return null;
    const s = String(dateStr).trim();
    if (!s) return null;

    // ISO: 2024-10-01
    let m = s.match(/^(\d{4})-(\d{1,2})-\d{1,2}/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;

    // DD/MM/YYYY o MM/DD/YYYY
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10), y = m[3];
      // Si a > 12 forzosamente DD/MM. Si b > 12 forzosamente MM/DD.
      // Si ambos <= 12 asumimos DD/MM (formato mexicano).
      const month = (a > 12) ? b : (b > 12 ? a : b);
      return `${y}-${String(month).padStart(2, '0')}`;
    }

    // YYYY/MM/DD
    m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-]\d{1,2}/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;

    return null;
  }

  /**
   * Detecta columnas numéricas mirando hasta 50 filas.
   */
  function detectNumericColumns(rows, excludeCol) {
    if (!rows.length) return [];
    const candidates = Object.keys(rows[0]).filter(c => c !== excludeCol);
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

  /**
   * Agrupa filas por mes y suma columnas numéricas.
   * Devuelve { "YYYY-MM": { col1: suma, col2: suma, ..., total: suma_total } }
   */
  function aggregateByMonth(rows, dateCol) {
    const result = {};
    if (!rows.length) return result;

    const numericCols = detectNumericColumns(rows, dateCol);
    if (!numericCols.length) {
      console.warn(`[IA-NAMI] ⚠ Sin columnas numéricas detectadas (col fecha: ${dateCol})`);
      return result;
    }

    rows.forEach(row => {
      const ym = toYearMonth(row[dateCol]);
      if (!ym) return;
      if (!result[ym]) {
        result[ym] = { total: 0 };
        numericCols.forEach(c => { result[ym][c] = 0; });
      }
      numericCols.forEach(c => {
        const raw = row[c];
        if (raw === '' || raw === null || raw === undefined) return;
        const n = Number(String(raw).replace(/,/g, ''));
        if (!isNaN(n)) {
          result[ym][c] += n;
          result[ym].total += n;
        }
      });
    });

    return result;
  }

  // ════════════════════════════════════════════════════════════════
  // CARGA DE UN CSV
  // ════════════════════════════════════════════════════════════════
  function loadCSV(url, key) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Timeout (${FETCH_TIMEOUT_MS}ms) cargando ${key}`));
        }
      }, FETCH_TIMEOUT_MS);

      Papa.parse(url, {
        download: true,
        header: true,
        skipEmptyLines: 'greedy',
        transformHeader: h => (h || '').trim(),
        transform: v => (typeof v === 'string' ? v.trim() : v),
        complete: (results) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (results.errors && results.errors.length) {
            console.warn(`[IA-NAMI] ⚠ ${key}: ${results.errors.length} advertencia(s) de parseo`);
          }
          resolve(results.data || []);
        },
        error: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
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

    console.log('[IA-NAMI] 🚀 Cargando', DATASETS.length, 'CSV(s) desde GitHub…');
    const t0 = performance.now();

    const results = await Promise.allSettled(
      DATASETS.map(d =>
        loadCSV(BASE_URL + d.file, d.key).then(rows => ({ d, rows }))
      )
    );

    let okCount = 0, totalMonths = 0;
    const failures = [];

    results.forEach((res, i) => {
      const d = DATASETS[i];
      if (res.status === 'fulfilled') {
        const rows = res.value.rows;
        const agg = aggregateByMonth(rows, DATE_COLUMN);
        window.DB[d.key] = agg;
        const months = Object.keys(agg).length;
        totalMonths += months;
        okCount++;
        console.log(`[IA-NAMI] ✓ ${d.key}: ${rows.length} filas → ${months} mes(es)`);
      } else {
        window.DB[d.key] = {};
        failures.push({ file: d.file, key: d.key, error: res.reason });
        console.error(`[IA-NAMI] ✗ ${d.key} (${d.file}):`, res.reason?.message || res.reason);
      }
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

    console.log(`[IA-NAMI] ✅ Listo: ${okCount}/${DATASETS.length} datasets, ${totalMonths} mes(es) en ${elapsed}s`);

    window.IANAMI_READY = true;

    window.dispatchEvent(new CustomEvent('ianami-loaded', {
      detail: { DB: window.DB, datasets: okCount, failures }
    }));

    flushPendingRefreshCalls();
  }

  // ════════════════════════════════════════════════════════════════
  // EJECUTAR LLAMADAS ENCOLADAS
  // ════════════════════════════════════════════════════════════════
  function flushPendingRefreshCalls(attempt = 0) {
    if (typeof realRefreshDashboard !== 'function') {
      if (attempt < FLUSH_MAX_ATTEMPTS) {
        setTimeout(() => flushPendingRefreshCalls(attempt + 1), 50);
      } else {
        console.warn('[IA-NAMI] refreshDashboard nunca quedó definida tras 1 s');
      }
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
    console.error('[IA-NAMI] PapaParse no encontrado y DOM ya listo. Verifica orden de <script>.');
  }

  // ════════════════════════════════════════════════════════════════
  // API DE DEBUG (consola del navegador)
  //   IANAMI.status()                       → estado actual
  //   IANAMI.reload()                       → recargar todos los CSVs
  //   IANAMI.peek('rescatados_monthly')     → primeros 3 meses de un dataset
  // ════════════════════════════════════════════════════════════════
  window.IANAMI = {
    reload: loadAllData,
    DB: () => window.DB,
    status: () => ({
      ready: window.IANAMI_READY,
      error: window.IANAMI_LOAD_ERROR,
      pending: pendingRefreshCalls.length,
      datasets: Object.fromEntries(
        DATASETS.map(d => [d.key, Object.keys(window.DB[d.key] || {}).length + ' meses'])
      )
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
