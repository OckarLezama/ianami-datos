/**
 * loader.js — IA-NAMI (Huejotzingo, Puebla)
 * ────────────────────────────────────────────────────────────────
 * Responsabilidades:
 *   1. Cargar CSVs desde GitHub de forma asíncrona (PapaParse).
 *   2. Poblar `window.DB` con los datos parseados.
 *   3. BLOQUEAR `refreshDashboard()` hasta que los datos estén listos
 *      (encolando llamadas hechas antes de tiempo).
 *   4. Disparar el evento `ianami-loaded` al completar.
 *
 * ⚠ CAMBIO REQUERIDO EN EL HTML (línea ~1232):
 *      let DB = {};        ❌  no compartible entre <script>
 *      window.DB = {};     ✅  obligatorio
 *
 * ORDEN DE CARGA EN EL HTML (importante):
 *   <script src="https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js"></script>
 *   <script src="loader.js"></script>          ← debe ir ANTES del script principal
 *   <script> ... tu HTML/lógica del dashboard ... </script>
 *
 * Si loader.js NO va antes del <script> principal, el interceptor
 * de `refreshDashboard` no podrá engancharse a tiempo.
 * ────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════
  // CONFIGURACIÓN  — ajusta nombres de archivo a tu repo
  // ════════════════════════════════════════════════════════════════
  const GITHUB_USER   = 'OckarLezama';
  const GITHUB_REPO   = 'Datos';
  const GITHUB_BRANCH = 'main';
  const BASE_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/`;

  // Clave en DB  →  nombre del archivo CSV en el repo
  const CSV_FILES = {
    beneficiarios: 'beneficiarios.csv',
    operadores:    'operadores.csv',
    secciones:     'secciones.csv'
    // agrega los que falten…
  };

  const FETCH_TIMEOUT_MS = 30000; // 30 s por archivo
  const FLUSH_MAX_ATTEMPTS = 20;  // espera hasta 1 s a que el HTML defina refreshDashboard

  // ════════════════════════════════════════════════════════════════
  // ESTADO GLOBAL
  // ════════════════════════════════════════════════════════════════
  window.DB = window.DB || {};

  // Pre-pobla con arrays vacíos: si filterByPeriod corriera antes
  // de tiempo, no truena con "Cannot convert undefined or null".
 Object.keys(CSV_FILES).forEach(k => {
    if (typeof window.DB[k] !== 'object' || window.DB[k] === null || Array.isArray(window.DB[k])) {
      window.DB[k] = {};
    }
  });

  window.IANAMI_READY = false;
  window.IANAMI_LOAD_ERROR = null;

  const pendingRefreshCalls = [];   // cola de llamadas tempranas
  let realRefreshDashboard = null;  // función real definida por el HTML

  // ════════════════════════════════════════════════════════════════
  // INTERCEPTOR DE refreshDashboard
  // ────────────────────────────────────────────────────────────────
  // Instalamos getter/setter en window.refreshDashboard ANTES de que
  // el HTML declare la función. Cuando el HTML hace
  //     function refreshDashboard() { … }
  // el motor JS asigna esa función a window.refreshDashboard, lo que
  // dispara el setter de abajo y guarda la referencia real. Cualquier
  // llamada externa pasa por el getter, que devuelve nuestro wrapper.
  // ════════════════════════════════════════════════════════════════
  Object.defineProperty(window, 'refreshDashboard', {
    configurable: true,
    enumerable: true,
    get() {
      return function refreshDashboard_wrapper(...args) {
        if (!window.IANAMI_READY) {
          console.log('[IA-NAMI] ⏳ refreshDashboard encolada (DB cargando)…');
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
  // CARGA DE UN CSV
  // ════════════════════════════════════════════════════════════════
  function loadCSV(url, key) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Timeout (${FETCH_TIMEOUT_MS} ms) cargando ${key}`));
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
  // CARGA PRINCIPAL (todos los CSVs en paralelo)
  // ════════════════════════════════════════════════════════════════
  async function loadAllData() {
    if (typeof Papa === 'undefined') {
      const msg = 'PapaParse no está cargado. Inclúyelo ANTES de loader.js';
      console.error('[IA-NAMI] ✗', msg);
      window.IANAMI_LOAD_ERROR = msg;
      window.IANAMI_READY = true; // libera la cola para que la UI no se cuelgue
      flushPendingRefreshCalls();
      return;
    }

    console.log('[IA-NAMI] 🚀 Iniciando carga desde GitHub…');
    const t0 = performance.now();

    const entries = Object.entries(CSV_FILES);
    const results = await Promise.allSettled(
      entries.map(([key, file]) =>
        loadCSV(BASE_URL + file, key).then(data => ({ key, data }))
      )
    );

    let total = 0;
    const failures = [];

    results.forEach((res, i) => {
      const [key, file] = entries[i];
      if (res.status === 'fulfilled') {
        window.DB[key] = res.value.data;
        total += res.value.data.length;
        console.log(`[IA-NAMI] ✓ ${key}: ${res.value.data.length} registros`);
      } else {
        window.DB[key] = []; // fallback seguro
        failures.push({ key, file, error: res.reason });
        console.error(`[IA-NAMI] ✗ ${key} (${file}):`, res.reason?.message || res.reason);
      }
    });

    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

    if (failures.length === entries.length) {
      const msg = `No se cargó ningún CSV. Revisa la URL base: ${BASE_URL}`;
      console.error('[IA-NAMI] ✗ FATAL:', msg);
      window.IANAMI_LOAD_ERROR = msg;
      window.dispatchEvent(new CustomEvent('ianami-error', {
        detail: { message: msg, failures }
      }));
    } else if (failures.length) {
      console.warn(`[IA-NAMI] ⚠ Carga parcial: ${failures.length}/${entries.length} archivo(s) fallaron`);
    }

    console.log(`[IA-NAMI] ✅ Listo: ${total} registros en ${elapsed}s`);

    // ORDEN IMPORTANTE: primero el flag, luego evento, luego flush.
    window.IANAMI_READY = true;

    window.dispatchEvent(new CustomEvent('ianami-loaded', {
      detail: { DB: window.DB, recordCount: total, failures }
    }));

    flushPendingRefreshCalls();
  }

  // ════════════════════════════════════════════════════════════════
  // EJECUTAR LLAMADAS ENCOLADAS (o disparar una inicial)
  // ════════════════════════════════════════════════════════════════
  function flushPendingRefreshCalls(attempt = 0) {
    if (typeof realRefreshDashboard !== 'function') {
      // El HTML aún no terminó de parsear y definir la función.
      // Reintentamos brevemente.
      if (attempt < FLUSH_MAX_ATTEMPTS) {
        setTimeout(() => flushPendingRefreshCalls(attempt + 1), 50);
      } else {
        console.warn('[IA-NAMI] refreshDashboard nunca quedó definida tras 1 s de espera');
      }
      return;
    }

    if (pendingRefreshCalls.length === 0) {
      // Nadie llamó refreshDashboard mientras cargábamos →
      // disparamos una llamada inicial nosotros mismos para renderizar.
      console.log('[IA-NAMI] Disparando refreshDashboard inicial');
      try { realRefreshDashboard(); }
      catch (err) { console.error('[IA-NAMI] Error en refreshDashboard inicial:', err); }
      return;
    }

    console.log(`[IA-NAMI] Ejecutando refreshDashboard tras ${pendingRefreshCalls.length} llamada(s) encolada(s)`);
    // Solo replicamos la ÚLTIMA llamada con sus args: cada refresh
    // re-renderiza todo, las anteriores quedan obsoletas. Si tu lógica
    // necesita procesar todas, cámbialo a `while (pendingRefreshCalls.length) …`
    const lastArgs = pendingRefreshCalls[pendingRefreshCalls.length - 1];
    pendingRefreshCalls.length = 0;
    try { realRefreshDashboard.apply(window, lastArgs); }
    catch (err) { console.error('[IA-NAMI] Error en refreshDashboard encolada:', err); }
  }

  // ════════════════════════════════════════════════════════════════
  // ARRANQUE
  // ════════════════════════════════════════════════════════════════
  // Arrancamos lo antes posible: no esperamos a DOMContentLoaded
  // para que la latencia de red ocurra en paralelo al parseo del HTML.
  if (typeof Papa !== 'undefined') {
    loadAllData();
  } else if (document.readyState === 'loading') {
    // PapaParse podría estar más abajo en el HTML; esperamos al DOM listo.
    document.addEventListener('DOMContentLoaded', loadAllData, { once: true });
  } else {
    console.error('[IA-NAMI] PapaParse no encontrado y DOM ya parseado. Revisa el orden de los <script>.');
  }

  // ════════════════════════════════════════════════════════════════
  // API DE DEBUG (útil desde la consola del navegador)
  //   IANAMI.status()  → estado actual
  //   IANAMI.reload()  → recargar todos los CSVs
  //   IANAMI.DB()      → snapshot de los datos
  // ════════════════════════════════════════════════════════════════
  window.IANAMI = {
    reload: loadAllData,
    DB: () => window.DB,
    status: () => ({
      ready: window.IANAMI_READY,
      error: window.IANAMI_LOAD_ERROR,
      pending: pendingRefreshCalls.length,
      counts: Object.fromEntries(
        Object.entries(window.DB).map(([k, v]) => [k, Array.isArray(v) ? v.length : '?'])
      )
    })
  };

})();
