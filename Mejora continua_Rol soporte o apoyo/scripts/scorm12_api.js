// scripts/scorm12_api.js — Adaptador SCORM 1.2 sobre @studiolxd/scorm (window.Scorm)
//
// Conserva la fachada estable `window.SCORM12.{init,getValue,setValue,commit,finish}`
// que usa app.js, pero por debajo delega en el runtime vendorizado (scorm.global.js),
// que aporta descubrimiento robusto de la API del LMS, tipado de errores (Result) y
// un modo simulación (mock) cuando no hay LMS (pruebas locales).
//
// Se fuerza la versión "1.2" (no "auto") para evitar cualquier detección errónea de 2004
// en Moodle. Si el runtime no estuviera disponible, se degrada a modo sin-op sin romper la UI.
(function () {
  'use strict';

  var session = null;   // sesión de @studiolxd/scorm
  var api = null;       // session.api (ScormApi): getRaw/setRaw/commit/…
  var ready = false;    // initialize (LMSInitialize) completado
  var mock = true;      // true = no se encontró LMS real (modo simulación)
  var lastError = '';   // último error legible del LMS

  function hasRuntime() {
    return typeof window !== 'undefined' && window.Scorm &&
      typeof window.Scorm.createScormSession === 'function';
  }

  // ¿Existe una API SCORM 1.2 real en la jerarquía de ventanas?
  function realApiPresent() {
    try {
      if (window.Scorm && typeof window.Scorm.findScormApi === 'function') {
        var found = window.Scorm.findScormApi('1.2', {});
        return !!(found && found.api);
      }
    } catch (e) { /* noop */ }
    return false;
  }

  function ensure() {
    if (session) return session;
    if (!hasRuntime()) {
      console.warn('[SCORM] runtime @studiolxd/scorm (scorm.global.js) no cargado. Modo sin-op.');
      return null;
    }
    try {
      mock = !realApiPresent();
      // noLmsBehavior:'mock' → usa el LMS si está; si no, driver simulado (offline).
      session = window.Scorm.createScormSession('1.2', { noLmsBehavior: 'mock' });
      api = session ? session.api : null;
      if (mock) console.info('[SCORM] API del LMS no encontrada: modo simulación (offline).');
    } catch (e) {
      console.warn('[SCORM] no se pudo crear la sesión:', e);
      session = null; api = null;
    }
    return session;
  }

  // Normaliza un Result de la librería y captura el error legible.
  function unwrap(r) {
    if (r && r.ok === false) {
      var err = r.error || {};
      lastError = err.errorString || err.diagnostic ||
        ('Error SCORM' + (err.code != null ? ' (' + err.code + ')' : ''));
    }
    return r;
  }

  window.SCORM12 = {
    init: function () {
      if (ready) return true;
      var s = ensure();
      if (!s) return false;
      var r = unwrap(s.initialize());
      ready = !!(r && r.ok);
      return ready;
    },
    // Lectura genérica de cualquier elemento CMI (incluye cmi.suspend_data).
    getValue: function (el) {
      var s = ensure();
      if (!s || !api) return '';
      var r = unwrap(api.getRaw(el));
      return (r && r.ok && r.value != null) ? String(r.value) : '';
    },
    // Escritura genérica de cualquier elemento CMI.
    setValue: function (el, v) {
      var s = ensure();
      if (!s || !api) return false;
      var r = unwrap(api.setRaw(el, String(v)));
      return !!(r && r.ok);
    },
    commit: function () {
      var s = ensure();
      if (!s) return false;
      var r = unwrap(s.commit());
      return !!(r && r.ok);
    },
    finish: function () {
      var s = ensure();
      if (!s) return false;
      var r = unwrap(s.terminate());
      var okFinish = !!(r && r.ok);
      if (okFinish) ready = false;
      return okFinish;
    },
    // Extras del adaptador (usados por app.js para diagnóstico/UX).
    lastError: function () { return lastError; },
    isMock: function () { ensure(); return mock; }
  };

  // Ciclo de vida: inicializar al cargar, terminar al descargar.
  window.addEventListener('load', function () { try { window.SCORM12.init(); } catch (e) {} });
  window.addEventListener('beforeunload', function () { try { window.SCORM12.finish(); } catch (e) {} });
})();
