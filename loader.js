/**
 * loader.js — IA-NAMI v4 (versión definitiva)
 * ────────────────────────────────────────────────────────────────
 * Repo: github.com/OckarLezama/ianami-datos
 *
 * Cada dataset se carga, se agrega por mes (YYYY-MM) y las columnas
 * del CSV se RENOMBRAN a los nombres cortos que usa el dashboard.
 *
 * Estructura final en window.DB.<key>:
 *   { "YYYY-MM": { total: N, pv: N, rein: N, ... } }
 *
 * Agregados por dimensión (resc_or, resc_nac, enc_ciudad, enc_estado):
 *   { "YYYY-MM": { "CHIAPAS": N, "CAMPECHE": N, ... } }
 * ────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════
  // CONFIGURACIÓN
  // ════════════════════════════════════════════════════════════════
  const GITHUB_USER   = 'OckarLezama';
  const GITHUB_REPO   = 'ianami-datos';
  const GITHUB_BRANCH = 'main';
  const BASE_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/`;

  /**
   * Cada dataset puede definir:
   *
   *   columnMap: { 'COLUMNA EN CSV': 'nombre_corto', ... }
   *              Renombra columnas numéricas. Si incluye 'total',
   *              esa columna es el total (no se duplica).
   *
   *   pivot: { sourceColumn, valueColumn, mapping: { 'VALOR': 'nombre' } }
   *              Suma valueColumn agrupado por categorías de sourceColumn.
   *              Útil para Encuentros (USBP, OFO, CBP One).
   *
   *   groupBy: [{ key, columnHints }]
   *              Agrega también por mes + dimensión (estado, nacionalidad...).
   */
  const DATASETS = [
    {
      file: 'Presentados.csv',
      key:  'presentados_monthly',
      columnMap: { 'PRESENTADOS': 'total' }
    },
    {
      file: 'Rescatados.csv',
      key:  'rescatados_monthly',
      columnMap: {
        'EXTRANJEROS RESCATADOS POR EL INM': 'total',
        'PRIMERA VEZ':         'pv',
        'REINCIDENCIA':        'rein',
        'PRESENTADOS EN EM':   'em',
        'CANALIZADOS AL DIF':  'dif'
      },
      groupBy: [
        { key: 'resc_or_monthly',  columnHints: ['Estado / O.R.', 'Estado'] },
        { key: 'resc_nac_monthly', columnHints: ['NACIONALIDAD', 'Nacionalidad'] }
      ]
    },
    {
      file: 'Canalizados.csv',
      key:  'can_monthly',
      columnMap: {
        'TOTAL DE CANALIZADOS': 'total',
        'ADULTOS':              'adultos',
        'MENORES':              'menores'
      }
    },
    {
      file: 'Retornados.csv',
      key:  'retornados_monthly',
      columnMap: {
        'RETORNADOS A SU PAÍS': 'total',
        'DEPORTADOS':           'dep',
        'RETORNOS ASISTIDOS':   'asist'
      }
    },
    {
      file: 'Extranjeros_recibidos.csv',
      key:  'ext_monthly',
      columnMap: {
        'EXTRANJEROS RECIBIDOS DE EE.UU.': 'total',
        'ADULTOS': 'adultos',
        'MENORES': 'menores'
      }
    },
    {
      file: 'Mexicanos_Recibidos.csv',
      key:  'mx_monthly',
      columnMap: {
        'TOTAL DE REPATRIADOS': 'total',
        'ADULTOS':              'adultos',
        'MENORES':              'menores',
        'NNA NO ACOMPAÑADOS':   'nna_nc',
        'NNA ACOMPAÑADOS':      'nna_ac',
        'TERRESTRES':           'terrestres',
        'VUELOS PRIM':          'vuelos'
      }
    },
    {
      file: 'Encuentros.csv',
      key:  'encuentros_monthly',
      columnMap: {
        'TOTAL':       'total',
        'Mexico':      'mexico',
        'Extranjeros': 'extranjeros'
      },
      pivot: {
        sourceColumn: 'Encuentro',
        valueColumn:  'TOTAL',
        mapping: {
          'USBP':    'usbp',
          'OFO':     'ofo',
          'CBP ONE': 'cbp_one',
          'CBP One': 'cbp_one',
          'CBP one': 'cbp_one'
        }
      },
      groupBy: [
        { key: 'enc_ciudad_monthly', columnHints: ['Ciudad EEUU', 'Ciudad', 'CIUDAD'] },
        { key: 'enc_estado_monthly', columnHints: ['Estado', 'ESTADO', 'Estado / O.R.'] }
      ]
    },
    {
      file: 'Inadmisiones.csv',
      key:  'inad_monthly',
      columnMap: { 'INADMITIDOS': 'total' }
    },
    {
      file: 'Condicion_de_Estancia.csv',
      key:  'estancia_monthly'
      // sin columnMap: detección automática de columnas numéricas
    },
    {
      file: 'Internaciones.csv',
      key:  'internaciones_monthly',
      columnMap: {
        'TOTAL DE INGRESOS':   'total',
        'INGRESOS AÉREOS':     'aereo',
        'INGRESOS MARÍTIMOS':  'maritimo',
        'INGRESOS TERRESTRES': 'terrestre'
      }
    },
    {
      file: 'Motivo_de_Estancia.csv',
      key:  'motivo_monthly'
    },
    {
      file: 'Caravanas_2019_2026.csv',
      key:  'caravanas_monthly'
    },
    { file: 'Estados_Frontera.csv',               key: 'frontera_monthly'   },
    { file: 'Cinturones_Contencion.csv',          key: 'cinturones_monthly' },
    { file: 'Centro_Coordinador_Operaciones.csv', key: 'cco_monthly'        }
  ];

  const DATE_COLUMN_HINTS  = ['DIA', 'Dia', 'FECHA', 'Fecha', 'fecha'];
  const FETCH_TIMEOUT_MS   = 60000;
  const FLUSH_MAX_ATTEMPTS = 30;

  // ════════════════════════════════════════════════════════════════
  // ESTADO GLOBAL
  // ════════════════════════════════════════════════════════════════
  window.DB = window.DB || {};

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
  function normalize(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  }

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
    if (!rows.length || !hints) return null;
    const headers = Object.keys(rows[0]);
    for (const h of hints) if (headers.includes(h)) return h;
    for (const h of hints) {
      const nh = normalize(h);
      for (const header of headers) if (normalize(header) === nh) return header;
    }
    for (const h of hints) {
      const nh = normalize(h);
      for (const header of headers) {
        if (normalize(header).includes(nh) || nh.includes(normalize(header))) return header;
      }
    }
    return null;
  }

  function findMappedColumns(rows, columnMap) {
    // Devuelve { rawColName: shortName, ... } resolviendo mayúsculas/acentos
    const headers = rows.length ? Object.keys(rows[0]) : [];
    const result = {};
    Object.entries(columnMap).forEach(([csvName, shortName]) => {
      // Coincidencia exacta primero
      if (headers.includes(csvName)) { result[csvName] = shortName; return; }
      // Insensible a case/acentos
      const nc = normalize(csvName);
      for (const h of headers) if (normalize(h) === nc) { result[h] = shortName; return; }
      console.warn(`[IA-NAMI] ⚠ columna "${csvName}" no encontrada en CSV`);
    });
    return result;
  }

  function toNumber(v) {
    if (v === '' || v === null || v === undefined) return 0;
    const n = Number(String(v).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
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

  // ════════════════════════════════════════════════════════════════
  // AGREGACIÓN
  // ════════════════════════════════════════════════════════════════
  function aggregateDataset(rows, ds, dateCol) {
    const out = {};
    if (!rows.length) return out;

    // 1. Determinar mapeo de columnas
    let mapping;          // { rawCsvCol: shortName }
    let hasExplicitTotal; // boolean

    if (ds.columnMap) {
      mapping = findMappedColumns(rows, ds.columnMap);
      hasExplicitTotal = Object.values(mapping).includes('total');
    } else {
      // Detección automática
      const dimCols = (ds.groupBy || []).map(g => pickColumn(rows, g.columnHints)).filter(Boolean);
      const pivotCol = ds.pivot ? pickColumn(rows, [ds.pivot.sourceColumn]) : null;
      const numericCols = detectNumericColumns(rows, [dateCol, pivotCol, ...dimCols]);
      mapping = {};
      numericCols.forEach(c => { mapping[c] = c; });   // mantiene el nombre original
      hasExplicitTotal = false;
    }

    // 2. Resolver pivot
    let pivotCol = null, pivotValueCol = null, pivotMapping = null;
    if (ds.pivot) {
      pivotCol = pickColumn(rows, [ds.pivot.sourceColumn]);
      pivotValueCol = pickColumn(rows, [ds.pivot.valueColumn]);
      if (pivotCol && pivotValueCol) {
        // Normalizar mapping de valores
        pivotMapping = {};
        Object.entries(ds.pivot.mapping).forEach(([val, short]) => {
          pivotMapping[normalize(val)] = short;
        });
      }
    }

    // 3. Iterar filas
    rows.forEach(row => {
      const ym = toYearMonth(row[dateCol]);
      if (!ym) return;

      if (!out[ym]) {
        out[ym] = { total: 0 };
        Object.values(mapping).forEach(s => { if (s !== 'total') out[ym][s] = 0; });
        if (pivotMapping) Object.values(pivotMapping).forEach(s => { out[ym][s] = 0; });
      }

      // Sumar columnas mapeadas
      Object.entries(mapping).forEach(([rawCol, shortName]) => {
        const val = toNumber(row[rawCol]);
        out[ym][shortName] = (out[ym][shortName] || 0) + val;
        // Si NO hay total explícito, acumular en total (salvo que el shortName ya sea 'total')
        if (!hasExplicitTotal && shortName !== 'total') {
          out[ym].total += val;
        }
      });

      // Pivot: filas que coinciden con categorías
      if (pivotMapping) {
        const cat = normalize(row[pivotCol]);
        const shortName = pivotMapping[cat];
        if (shortName) {
          out[ym][shortName] = (out[ym][shortName] || 0) + toNumber(row[pivotValueCol]);
        }
      }
    });

    return out;
  }

  function aggregateByDimension(rows, dateCol, dimCol, mapping, hasExplicitTotal) {
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

      // Si hay un 'total' explícito, suma solo ese. Si no, suma todas las columnas mapeadas.
      if (hasExplicitTotal) {
        const totalCol = Object.entries(mapping).find(([_, s]) => s === 'total');
        if (totalCol) out[ym][key] += toNumber(row[totalCol[0]]);
      } else {
        Object.keys(mapping).forEach(rawCol => {
          out[ym][key] += toNumber(row[rawCol]);
        });
      }
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
        error: (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); }
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
        failures.push({ file: d.file, error: res.reason });
        console.error(`[IA-NAMI] ✗ ${d.key}:`, res.reason?.message || res.reason);
        return;
      }

      const rows = res.value.rows;
      if (!rows.length) {
        console.warn(`[IA-NAMI] ⚠ ${d.key}: archivo vacío`);
        return;
      }

      const dateCol = pickColumn(rows, DATE_COLUMN_HINTS);
      if (!dateCol) {
        console.warn(`[IA-NAMI] ⚠ ${d.key}: sin columna de fecha`);
        return;
      }

      // Agregado principal
      window.DB[d.key] = aggregateDataset(rows, d, dateCol);
      const months = Object.keys(window.DB[d.key]).length;
      const sample = months > 0 ? Object.keys(Object.values(window.DB[d.key])[0]).join(',') : '∅';
      console.log(`[IA-NAMI] ✓ ${d.key}: ${rows.length} filas → ${months} meses [campos: ${sample}]`);

      // Agregados por dimensión
      if (d.groupBy) {
        const mapping = d.columnMap ? findMappedColumns(rows, d.columnMap)
                                    : Object.fromEntries(detectNumericColumns(rows, [dateCol]).map(c => [c, c]));
        const hasTotal = Object.values(mapping).includes('total');
        d.groupBy.forEach(g => {
          const dimCol = pickColumn(rows, g.columnHints);
          if (!dimCol) {
            console.warn(`[IA-NAMI] ⚠ ${g.key}: columna no encontrada (${g.columnHints.join(', ')})`);
            window.DB[g.key] = {};
            return;
          }
          window.DB[g.key] = aggregateByDimension(rows, dateCol, dimCol, mapping, hasTotal);
          const mm = Object.keys(window.DB[g.key]).length;
          console.log(`[IA-NAMI]   ↳ ${g.key} (por "${dimCol}"): ${mm} meses`);
        });
      }

      okCount++;
    });

    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

    if (okCount === 0) {
      window.IANAMI_LOAD_ERROR = `Ningún CSV cargó. Revisa URL: ${BASE_URL}`;
      console.error('[IA-NAMI] ✗ FATAL:', window.IANAMI_LOAD_ERROR);
    } else if (failures.length) {
      console.warn(`[IA-NAMI] ⚠ Carga parcial: ${failures.length} archivo(s) fallaron`);
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
  if (typeof Papa !== 'undefined') loadAllData();
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadAllData, { once: true });
  else console.error('[IA-NAMI] PapaParse no encontrado y DOM ya listo');

  // ════════════════════════════════════════════════════════════════
  // API DE DEBUG
  // ════════════════════════════════════════════════════════════════
  window.IANAMI = {
    reload: loadAllData,
    DB: () => window.DB,
    status: () => ({
      ready: window.IANAMI_READY,
      error: window.IANAMI_LOAD_ERROR,
      pending: pendingRefreshCalls.length,
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
