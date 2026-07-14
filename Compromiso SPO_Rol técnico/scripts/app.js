// scripts/app.js — Rúbrica interactiva de autoevaluación (asistente por pasos, accesible)
// Modelo de puntuación (sin cambios respecto al original):
//   · Área  = suma de grados de sus 4 actuaciones (0–16) -> clasificación por tramos.
//   · Global = 100 · Calidad · (0,5 + 0,5 · Cobertura)   (escala 0–100)
//       Calidad   = puntos obtenidos / puntos máximos (20 actuaciones × 4 = 80)
//       Cobertura = actuaciones acreditadas / total   (acreditada = grado ≥ accredited_min_grade)
//
// Interacción: 5 pasos (un comportamiento observable por paso) + paso final de resultado.
// Todos los pasos se renderizan en el DOM y se ocultan con [hidden]; así el cálculo lee
// siempre el documento completo (readSelections) sin depender del paso visible.

'use strict';

/* ---------- Utilidades globales (compartidas con el informe PDF) ---------- */
function normalize(s){
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function classifyByRange(score, rules){
  if(!Array.isArray(rules)) return null;
  return rules.find(function(r){
    var lo = Number(r.min), hi = Number(r.max);
    return score >= Math.min(lo, hi) && score <= Math.max(lo, hi);
  }) || null;
}
function areaClassText(area, label){
  if(!area || !label) return "";
  var map = area.area_classification_text || {};
  var lab = normalize(label);
  if(lab.indexOf("alto") >= 0)  return map.alto || "";
  if(lab.indexOf("medio") >= 0) return map.medio || "";
  if(lab.indexOf("basico") >= 0) return map.basico || "";
  if(lab.indexOf("sin competencia") >= 0) return map.sin_competencia || "";
  return "";
}
function pointsForFactory(rubric){
  var ppl = (rubric.scoring && rubric.scoring.points_per_level) || {};
  return function(val){
    if(val == null || val === "") return 0;
    var n = Number(ppl[String(val)]);
    return Number.isFinite(n) ? n : (Number(val) || 0);
  };
}
function allBehaviors(rubric){
  var out = [];
  (rubric.areas || []).forEach(function(a){
    (a.behaviors || []).forEach(function(b){ out.push({ area: a, beh: b }); });
  });
  return out;
}
function computeScores(rubric, selections){
  var pointsFor = pointsForFactory(rubric);
  var sc = rubric.scoring || {};
  var accreditedMin = Number(sc.accredited_min_grade) || 3;
  var gm = sc.global_model || {};
  var maxRaw = Number(gm.max_raw) || (allBehaviors(rubric).length * (Number(sc.max_points_per_behavior) || 4));
  var total = Number(gm.total_behaviors) || allBehaviors(rubric).length;

  var raw = 0, accredited = 0, answered = 0;
  allBehaviors(rubric).forEach(function(item){
    var v = selections[item.beh.id];
    if(v != null && v !== ""){
      answered++;
      var p = pointsFor(v);
      raw += p;
      if(p >= accreditedMin) accredited++;
    }
  });
  var quality = maxRaw > 0 ? (raw / maxRaw) : 0;
  var coverage = total > 0 ? (accredited / total) : 0;
  var punt = Math.round(maxRaw * quality * (0.5 + 0.5 * coverage));
  punt = Math.max(0, Math.min(maxRaw, punt));
  var globalClass = classifyByRange(punt, (sc.classification_rules && sc.classification_rules.global) || []);
  return { raw: raw, maxRaw: maxRaw, answered: answered, total: total, accredited: accredited,
           quality: quality, coverage: coverage, punt: punt, globalClass: globalClass };
}
function areaScore(area, selections, pointsFor){
  return (area.behaviors || []).reduce(function(sum, b){
    var v = selections[b.id];
    return sum + (v != null && v !== "" ? pointsFor(v) : 0);
  }, 0);
}
function areaAnswered(area, selections){
  return (area.behaviors || []).reduce(function(n, b){
    var v = selections[b.id];
    return n + (v != null && v !== "" ? 1 : 0);
  }, 0);
}
// Descriptor corto de un grado (para segmentos y leyenda), derivado de scale.levels.
function gradeShort(lv){
  var d = String(lv.description || "");
  d = d.split("(")[0].split("/")[0];        // quita "(Nivel …)" y "/ No aplicable…"
  d = d.replace(/[.\s]+$/, "").trim();
  return d || lv.label;
}

/* ---------- Utilidades de escape ---------- */
function escapeHTML(s){
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s){
  return escapeHTML(s).replace(/"/g, "&quot;");
}
// Valor de rol sin el prefijo "Rol " (para etiquetas "Rol: …"): "Rol directivo" -> "Directivo".
function roleValue(rol){
  var v = String(rol == null ? "" : rol).replace(/^\s*rol\s+/i, "");
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : v;
}

/* ---------- Aplicación principal ---------- */
(function(){
  var $  = function(s, c){ return (c || document).querySelector(s); };
  var $$ = function(s, c){ return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  var rubric = null;
  var current = 0;         // índice de paso: 0..areas.length-1 = comportamientos; areas.length = resultado
  var lastIndex = 0;       // = areas.length (paso final)
  var commitTimer = null;  // commit agrupado (debounce)

  function loadRubric(){
    return fetch("rubric.json?nocache=" + Date.now()).then(function(r){ return r.json(); });
  }
  function levelsSorted(){
    var lv = (rubric.scale && rubric.scale.levels) || [];
    return lv.slice().sort(function(a, b){ return Number(a.value) - Number(b.value); });
  }
  function maxAreaOf(a){
    return Number((rubric.scoring || {}).max_points_per_area) || ((a.behaviors || []).length * 4);
  }

  function readSelections(){
    var sel = {};
    (rubric.areas || []).forEach(function(a){
      (a.behaviors || []).forEach(function(b){
        var checked = document.querySelector('input[name="b_' + a.id + "_" + b.id + '"]:checked');
        if(checked) sel[b.id] = checked.value;
      });
    });
    return sel;
  }
  function applySelections(sel){
    Object.keys(sel || {}).forEach(function(behId){
      (rubric.areas || []).forEach(function(a){
        (a.behaviors || []).forEach(function(b){
          if(b.id === behId){
            var input = document.getElementById("b_" + a.id + "_" + b.id + "_" + sel[behId]);
            if(input) input.checked = true;
          }
        });
      });
    });
  }

  /* ---------- Render de cabecera, leyenda y stepper ---------- */
  function renderHeader(){
    // El logotipo ya identifica a "Junta de Andalucía": evitamos repetirlo en el kicker.
    var kicker = (rubric.rubric_competency || "").replace(/\s*·\s*Junta de Andaluc[ií]a\s*$/i, "");
    $("#rb-competency").textContent   = kicker;
    $("#rb-title").textContent        = rubric.rubric_title || "Rúbrica";
    $("#rb-rol").textContent          = rubric.rubric_rol || "";
    // La etiqueta "Definición de la competencia:" va en negrita para diferenciarla del texto.
    var def = rubric.rubric_definition || "";
    var defM = def.match(/^(\s*Definici[oó]n de la competencia\s*:?)([\s\S]*)$/i);
    if(defM){
      $("#rb-definition").innerHTML = "<strong>" + escapeHTML(defM[1]) + "</strong>" + escapeHTML(defM[2]);
    } else {
      $("#rb-definition").textContent = def;
    }
    // La frase de instrucciones va en negrita (requisito del cliente).
    $("#rb-instructions").innerHTML   = "<strong>" + escapeHTML(rubric.rubric_instructions || "") + "</strong>";
    document.title = (rubric.rubric_title || "Rúbrica") + " · " + (rubric.rubric_rol || "");
  }

  function renderLegend(){
    var ul = $("#rb-legend");
    ul.innerHTML = "";
    levelsSorted().forEach(function(lv){
      var li = document.createElement("li");
      li.className = "legend-item";
      li.innerHTML =
        '<span class="legend-grade">' + escapeHTML(lv.label) + '</span>' +
        '<span class="legend-desc">' + escapeHTML(gradeShort(lv)) + '</span>';
      ul.appendChild(li);
    });
  }

  function renderStepper(){
    var nav = $("#stepper");
    var ol = document.createElement("ol");
    ol.className = "stepper-list";
    (rubric.areas || []).forEach(function(a, idx){
      ol.appendChild(stepperItem(idx, String(idx + 1), "Comp. " + (idx + 1)));
    });
    ol.appendChild(stepperItem(lastIndex, "⚑", "Resultado")); // ⚑
    nav.innerHTML = "";
    nav.appendChild(ol);
  }
  function stepperItem(idx, dotText, label){
    var li = document.createElement("li");
    li.className = "stepper-item";
    li.setAttribute("data-step-item", String(idx));
    li.innerHTML =
      '<button type="button" class="stepper-btn" data-step="' + idx + '">' +
        '<span class="stepper-dot" aria-hidden="true">' + escapeHTML(dotText) + '</span>' +
        '<span class="stepper-label">' + escapeHTML(label) + '</span>' +
      '</button>';
    return li;
  }

  /* ---------- Render de pasos ---------- */
  function renderSteps(){
    var levels = levelsSorted();
    var host = $("#steps");
    host.innerHTML = "";
    (rubric.areas || []).forEach(function(a, idx){
      host.appendChild(buildAreaStep(a, idx, levels));
    });
    host.appendChild(buildFinalStep());
  }

  function buildAreaStep(a, idx, levels){
    var sec = document.createElement("section");
    sec.className = "panel step";
    sec.id = "step-" + idx;
    sec.setAttribute("role", "group");
    sec.setAttribute("aria-labelledby", "stephead_" + a.id);
    sec.hidden = true;

    var itemsHTML = (a.behaviors || []).map(function(b, bi){
      return buildItem(a, b, bi, levels);
    }).join("");

    sec.innerHTML =
      '<header class="step-header">' +
        '<p class="step-eyebrow">Comportamiento observable ' + (idx + 1) + ' de ' + rubric.areas.length + '</p>' +
        '<h2 class="step-title" id="stephead_' + a.id + '" tabindex="-1">' + escapeHTML(a.title || "Comportamiento") + '</h2>' +
        (a.description ? '<p class="step-desc">' + escapeHTML(a.description) + '</p>' : '') +
        '<div class="step-score" aria-live="polite">' +
          '<span class="score-pill"><span class="visually-hidden">Puntuación del comportamiento: </span>' +
            '<span class="score-num" id="t_' + a.id + '">0</span>' +
            '<span class="score-den">/' + maxAreaOf(a) + '</span></span>' +
          '<span class="badge is-empty" id="c_' + a.id + '">Sin valorar</span>' +
        '</div>' +
        '<p class="step-note" id="d_' + a.id + '"></p>' +
      '</header>' +
      '<div class="items">' + itemsHTML + '</div>' +
      (idx === 0
        ? '<div class="step-nav end-only">' +
            '<button type="button" class="btn primary" data-nav="next">Siguiente</button>' +
          '</div>'
        : '<div class="step-nav">' +
            '<button type="button" class="btn btn-ghost" data-nav="prev">Anterior</button>' +
            '<button type="button" class="btn primary" data-nav="next">Siguiente</button>' +
          '</div>');
    return sec;
  }

  function buildItem(a, b, bi, levels){
    var name = "b_" + a.id + "_" + b.id;
    var segs = levels.map(function(lv){
      var id = name + "_" + lv.value;
      return '<label class="seg">' +
        '<input type="radio" name="' + name + '" id="' + id + '" value="' + lv.value + '"/>' +
        '<span class="seg-body">' +
          '<span class="seg-grade">' + escapeHTML(lv.label) + '</span>' +
          '<span class="seg-desc">' + escapeHTML(gradeShort(lv)) + '</span>' +
          '<span class="seg-check" aria-hidden="true">✓</span>' +
        '</span>' +
      '</label>';
    }).join("");

    return '<div class="item" role="radiogroup" aria-labelledby="lg_' + name + '">' +
      '<p class="item-legend" id="lg_' + name + '">' +
        '<span class="item-index" aria-hidden="true">' + (bi + 1) + '</span>' +
        '<span>' + escapeHTML(b.text || "—") + '</span>' +
      '</p>' +
      '<div class="segments">' + segs + '</div>' +
    '</div>';
  }

  function buildFinalStep(){
    var sec = document.createElement("section");
    sec.className = "panel step result-step";
    sec.id = "step-" + lastIndex;
    sec.setAttribute("role", "group");
    sec.setAttribute("aria-labelledby", "result-h");
    sec.hidden = true;
    sec.innerHTML =
      '<header class="step-header">' +
        '<p class="step-eyebrow">Resumen de la autoevaluación</p>' +
        '<h2 class="step-title" id="result-h" tabindex="-1">Resultado global</h2>' +
      '</header>' +
      '<div class="result-hero">' +
        '<div class="result-figure" aria-live="polite">' +
          '<div class="kpi"><span id="global-score">0</span><span class="kpi-unit" aria-hidden="true">/80</span>' +
            '<span class="visually-hidden"> de 80 puntos</span></div>' +
          '<div class="muted">Puntuación global</div>' +
        '</div>' +
        '<div class="result-verdict" aria-live="polite">' +
          '<span class="badge badge-lg is-empty" id="global-class-label">–</span>' +
          '<p class="note" id="global-class-desc"></p>' +
        '</div>' +
      '</div>' +
      '<h3 class="visually-hidden">Detalle por comportamiento</h3>' +
      '<div class="result-areas" id="result-areas"></div>' +
      '<div class="btn-row">' +
        '<button type="button" id="btn-save" class="btn primary">Guardar y enviar</button>' +
        '<button type="button" id="btn-pdf" class="btn btn-ghost">Descargar PDF</button>' +
        '<button type="button" id="btn-reset" class="btn btn-ghost">Reiniciar</button>' +
      '</div>' +
      '<p class="muted small">El progreso se guarda automáticamente y se restaura al volver a abrir la actividad. ' +
        'Puedes revisarla y volver a guardarla más adelante para comprobar tu evolución; descarga el PDF de cada pasada para conservar el registro.</p>' +
      '<p id="completado" role="status" hidden>Autoevaluación guardada y enviada correctamente.</p>' +
      '<div class="step-nav">' +
        '<button type="button" class="btn btn-ghost" data-nav="prev">Anterior</button>' +
      '</div>';
    return sec;
  }

  /* ---------- Cálculo y refresco de la UI ---------- */
  function refresh(){
    var sel = readSelections();
    var pointsFor = pointsForFactory(rubric);
    var areaRules = ((rubric.scoring || {}).classification_rules || {}).area || [];

    (rubric.areas || []).forEach(function(a){
      var answered = areaAnswered(a, sel);
      var t = areaScore(a, sel, pointsFor);
      var tEl = $("#t_" + a.id); if(tEl) tEl.textContent = String(Math.min(t, maxAreaOf(a)));

      var cEl = $("#c_" + a.id);
      var dEl = $("#d_" + a.id);
      if(answered === 0){
        if(cEl){ cEl.textContent = "Sin valorar"; cEl.classList.add("is-empty"); }
        if(dEl) dEl.textContent = "";
      } else {
        var cls = classifyByRange(t, areaRules) || {};
        if(cEl){ cEl.textContent = cls.label || "–"; cEl.classList.remove("is-empty"); }
        if(dEl) dEl.textContent = areaClassText(a, cls.label) || cls.description || "";
      }
    });

    var s = computeScores(rubric, sel);
    var gsEl = $("#global-score"); if(gsEl) gsEl.textContent = String(s.punt);
    var glEl = $("#global-class-label");
    var gdEl = $("#global-class-desc");
    if(s.answered === 0){
      if(glEl){ glEl.textContent = "–"; glEl.classList.add("is-empty"); }
      if(gdEl) gdEl.textContent = "";
    } else {
      if(glEl){ glEl.textContent = (s.globalClass && s.globalClass.label) || "–"; glEl.classList.remove("is-empty"); }
      if(gdEl) gdEl.textContent = (s.globalClass && s.globalClass.description) || "";
    }

    renderResultAreas(sel, pointsFor, areaRules);
    renderStepperState(sel);
    return sel;
  }

  function renderResultAreas(sel, pointsFor, areaRules){
    var host = $("#result-areas");
    if(!host) return;
    host.innerHTML = (rubric.areas || []).map(function(a, idx){
      var answered = areaAnswered(a, sel);
      var t = areaScore(a, sel, pointsFor);
      var cls = answered === 0 ? null : (classifyByRange(t, areaRules) || {});
      var badge = answered === 0
        ? '<span class="badge is-empty">Sin valorar</span>'
        : '<span class="badge">' + escapeHTML(cls.label || "–") + '</span>';
      return '<div class="result-area">' +
          '<span class="result-area-name">' + (idx + 1) + '. ' + escapeHTML(a.title || "Comportamiento") + '</span>' +
          '<span class="score-pill"><span class="score-num">' + Math.min(t, maxAreaOf(a)) + '</span>' +
            '<span class="score-den">/' + maxAreaOf(a) + '</span></span>' +
          badge +
        '</div>';
    }).join("");
  }

  function renderStepperState(sel){
    var doneCount = 0;
    (rubric.areas || []).forEach(function(a, idx){
      var li = $('[data-step-item="' + idx + '"]');
      if(!li) return;
      var done = areaAnswered(a, sel) === (a.behaviors || []).length && (a.behaviors || []).length > 0;
      if(done) doneCount++;
      li.classList.toggle("is-done", done && idx !== current);
      li.classList.toggle("is-current", idx === current);
      var btn = li.querySelector(".stepper-btn");
      if(btn){ if(idx === current) btn.setAttribute("aria-current", "step"); else btn.removeAttribute("aria-current"); }
    });
    // Línea de progreso: coherente con los puntos (proporción de comportamientos completados).
    var list = document.querySelector(".stepper-list");
    if(list) list.style.setProperty("--progress", lastIndex ? (doneCount / lastIndex) : 0);
    var lastLi = $('[data-step-item="' + lastIndex + '"]');
    if(lastLi){
      lastLi.classList.toggle("is-current", current === lastIndex);
      var lb = lastLi.querySelector(".stepper-btn");
      if(lb){ if(current === lastIndex) lb.setAttribute("aria-current", "step"); else lb.removeAttribute("aria-current"); }
    }
  }

  /* ---------- Navegación entre pasos ---------- */
  function goToStep(n, opts){
    opts = opts || {};
    n = Math.max(0, Math.min(lastIndex, n));
    current = n;
    $$("#steps .step").forEach(function(sec){
      sec.hidden = (sec.id !== "step-" + n);
    });
    refresh();

    var title = (rubric.areas[n] && rubric.areas[n].title) || "Resultado global";
    var stepLabel = "Paso " + (n + 1) + " de " + (lastIndex + 1) + ": " + title;
    var status = $("#wizard-status"); if(status) status.textContent = stepLabel;

    if(opts.focus !== false){
      var active = document.getElementById("step-" + n);
      var head = active && active.querySelector(".step-title");
      if(head) head.focus();
    }
    if(opts.scroll !== false){
      var host = $("#stepper");
      if(host && host.scrollIntoView) host.scrollIntoView({ block: "start" });
    }
  }

  /* ---------- Persistencia SCORM ---------- */
  function scheduleCommit(){
    if(commitTimer) return;               // commit agrupado: como mucho uno cada ~2 s
    commitTimer = setTimeout(function(){
      commitTimer = null;
      try{ SCORM12.commit(); }catch(e){}
    }, 2000);
  }
  function autosave(){
    try{
      var sel = readSelections();
      var payload = JSON.stringify({ selections: sel, ts: Date.now() });
      SCORM12.setValue("cmi.suspend_data", payload.slice(0, 4000));
      scheduleCommit();
    }catch(e){}
  }
  function restore(){
    try{
      var raw = SCORM12.getValue("cmi.suspend_data");
      if(raw){
        var data = JSON.parse(raw);
        if(data && data.selections){ applySelections(data.selections); return true; }
      }
    }catch(e){}
    return false;
  }

  function showError(msg){
    var err = $("#err");
    if(err){ err.hidden = false; err.textContent = msg; }
  }
  function clearError(){
    var err = $("#err"); if(err) err.hidden = true;
  }

  function saveAndSend(){
    var sel = readSelections();
    var s = computeScores(rubric, sel);
    var ok = true;
    ok = SCORM12.setValue("cmi.core.score.min", "0") && ok;
    ok = SCORM12.setValue("cmi.core.score.max", "80") && ok;
    ok = SCORM12.setValue("cmi.core.score.raw", String(s.punt)) && ok;
    ok = SCORM12.setValue("cmi.core.lesson_status", "completed") && ok;
    ok = SCORM12.setValue("cmi.suspend_data",
      JSON.stringify({ selections: sel, punt: s.punt, class: s.globalClass }).slice(0, 4000)) && ok;
    var committed = SCORM12.commit();

    if(ok && committed){
      clearError();
      var done = $("#completado"); if(done){ done.hidden = false; }
    } else {
      var detail = SCORM12.lastError ? SCORM12.lastError() : "";
      if(SCORM12.isMock && SCORM12.isMock()){
        // Sin LMS (modo local/simulación): no es un error real para el usuario.
        clearError();
        var d2 = $("#completado"); if(d2){ d2.hidden = false; d2.textContent = "Guardado localmente (sin conexión con el LMS)."; }
      } else {
        showError("No se pudo guardar en el LMS" + (detail ? ": " + detail : "."));
      }
    }
  }

  function resetAll(){
    $$('input[type="radio"]').forEach(function(i){ i.checked = false; });
    var done = $("#completado"); if(done){ done.hidden = true; done.textContent = "Autoevaluación guardada y enviada correctamente."; }
    clearError();
    try{
      SCORM12.setValue("cmi.suspend_data", "");
      SCORM12.setValue("cmi.core.lesson_status", "incomplete");
      SCORM12.commit();
    }catch(e){}
    goToStep(0);
  }

  /* ---------- Eventos ---------- */
  function wireEvents(){
    document.addEventListener("change", function(e){
      if(e.target && e.target.matches && e.target.matches('input[type="radio"]')){
        refresh(); autosave();
      }
    });

    // Navegación (delegada): Anterior/Siguiente y saltos del stepper.
    document.addEventListener("click", function(e){
      var nav = e.target.closest && e.target.closest("[data-nav]");
      if(nav){
        goToStep(current + (nav.getAttribute("data-nav") === "next" ? 1 : -1));
        return;
      }
      var step = e.target.closest && e.target.closest("[data-step]");
      if(step){ goToStep(Number(step.getAttribute("data-step"))); return; }

      if(e.target.closest && e.target.closest("#btn-save")){ saveAndSend(); return; }
      if(e.target.closest && e.target.closest("#btn-reset")){ resetAll(); return; }
      if(e.target.closest && e.target.closest("#btn-pdf")){ downloadPDF(); return; }
    });
  }

  // Carga el logo (misma-origen, sin taint) devolviendo su data URI y dimensiones,
  // para incrustarlo tanto en el PDF nativo como en el informe imprimible de reserva.
  function loadLogo(cb){
    try{
      var img = new Image();
      img.onload = function(){
        try{
          var c = document.createElement("canvas");
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext("2d").drawImage(img, 0, 0);
          cb({ data: c.toDataURL("image/jpeg", 0.92), w: img.naturalWidth, h: img.naturalHeight });
        }catch(e){ cb(null); }
      };
      img.onerror = function(){ cb(null); };
      img.src = "media/Logo-JuntaAndalucia.jpg";
    }catch(e){ cb(null); }
  }

  function pdfFileName(){
    var base = (rubric.rubric_title || "Rubrica") + " " + (rubric.rubric_rol || "");
    if(base.normalize) base = base.normalize("NFD"); // separa acentos; el filtro ASCII quita las marcas
    base = base.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return "Informe_" + (base || "Rubrica") + ".pdf";
  }

  function downloadPDF(){
    var sel = readSelections();
    var s = computeScores(rubric, sel);
    var studentName = "";
    try{ studentName = SCORM12.getValue("cmi.core.student_name") || ""; }catch(e){}
    var jspdfNS = window.jspdf || null;
    loadLogo(function(logo){
      // Camino principal: generar el PDF y descargarlo directamente (sin ventana ni imprimir).
      if(jspdfNS && jspdfNS.jsPDF){
        try{
          var doc = buildReportPDF(jspdfNS.jsPDF, rubric, sel, s, studentName, logo);
          doc.save(pdfFileName());
          return;
        }catch(e){ console.error("jsPDF falló, uso impresión:", e); }
      }
      // Reserva: informe en ventana + diálogo de impresión.
      printReportFallback(rubric, sel, s, studentName, logo ? logo.data : "");
    });
  }

  // Reserva cuando jsPDF no está disponible: ventana con el informe HTML e impresión.
  function printReportFallback(rb, sel, s, studentName, logoDataUrl){
    var w = window.open("", "_blank");
    if(!w){ alert("Permite las ventanas emergentes para generar el informe."); return; }
    var html = buildReportHTML(rb, sel, s, studentName, logoDataUrl);
    w.document.open(); w.document.write(html); w.document.close();
    setTimeout(function(){ try{ w.focus(); w.print(); }catch(e){} }, 350);
  }

  /* ---------- Arranque ---------- */
  loadRubric().then(function(data){
    rubric = data;
    lastIndex = (rubric.areas || []).length;
    renderHeader();
    renderLegend();
    renderStepper();
    renderSteps();
    wireEvents();
    // Restaurar progreso guardado tras un pequeño retardo (da tiempo a LMSInitialize).
    setTimeout(function(){ restore(); goToStep(0, { focus: false, scroll: false }); }, 250);
    goToStep(0, { focus: false, scroll: false });
  }).catch(function(e){
    showError("No se pudo cargar rubric.json.");
    console.error(e);
  });
})();

/* ---------- Informe imprimible / PDF (ventana aparte, sin librerías) ---------- */
function buildReportHTML(rubric, selections, scores, studentName, logoDataUrl){
  var pointsFor = pointsForFactory(rubric);
  var levelsMap = (rubric.scale && rubric.scale.levels || []).reduce(function(acc, l){
    acc[String(l.value)] = l.label; return acc;
  }, {});
  var maxArea = Number((rubric.scoring || {}).max_points_per_area) || 16;
  var areaRules = ((rubric.scoring || {}).classification_rules || {}).area || [];

  var areasHTML = (rubric.areas || []).map(function(a, idx){
    var rows = (a.behaviors || []).map(function(b){
      var v = selections[b.id];
      var label = (v != null && v !== "") ? (levelsMap[String(v)] || String(v)) : "Sin valorar";
      return "<tr><td>" + escapeHTML(b.text || "—") + "</td><td class='c'>" + escapeHTML(label) + "</td></tr>";
    }).join("");
    var sVal = areaScore(a, selections, pointsFor);
    var answered = areaAnswered(a, selections);
    var cls = answered === 0 ? {} : (classifyByRange(sVal, areaRules) || {});
    var clsText = areaClassText(a, cls.label) || cls.description || "";
    return "<section class='area'>" +
      "<h2>" + (idx + 1) + ". " + escapeHTML(a.title || "Comportamiento") + "</h2>" +
      (a.description ? "<p class='muted'>" + escapeHTML(a.description) + "</p>" : "") +
      "<table><thead><tr><th>Actuación</th><th class='c'>Grado</th></tr></thead><tbody>" + rows + "</tbody></table>" +
      "<p class='areascore'><strong>Puntuación:</strong> " + sVal + "/" + maxArea +
        " &nbsp;·&nbsp; <strong>Nivel:</strong> " + escapeHTML(answered === 0 ? "Sin valorar" : (cls.label || "–")) + "</p>" +
      (clsText ? "<p class='muted'>" + escapeHTML(clsText) + "</p>" : "") +
    "</section>";
  }).join("");

  var gc = scores.globalClass || {};
  var fecha = "";
  try{ fecha = new Date().toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" }); }catch(e){}
  var meta = [];
  if(studentName) meta.push("<div><strong>Persona:</strong> " + escapeHTML(studentName) + "</div>");
  meta.push("<div><strong>Rol:</strong> " + escapeHTML(roleValue(rubric.rubric_rol)) + "</div>");
  if(fecha) meta.push("<div><strong>Fecha:</strong> " + escapeHTML(fecha) + "</div>");

  return "<!doctype html><html lang='es'><head><meta charset='utf-8'/>" +
    "<title>Informe · " + escapeHTML(rubric.rubric_title || "Rúbrica") + "</title><style>" +
    ":root{--g:#007932;--gd:#005a25;--gdeep:#00431c;--soft:#eaf3ec;--ink:#2e2925;--muted:#555559;--bd:#dcdddf}" +
    "*{box-sizing:border-box}body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial;margin:32px;color:var(--ink);line-height:1.55}" +
    "h1{color:var(--gdeep);margin:0 0 4px;font-size:26px;letter-spacing:-.01em}" +
    "h2{color:var(--gd);font-size:18px;margin:22px 0 8px}" +
    ".kicker{color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-size:12px;font-weight:600;margin:0}" +
    ".rol{font-size:16px;font-weight:600;margin:4px 0 14px}" +
    ".meta{display:flex;gap:24px;flex-wrap:wrap;color:var(--muted);font-size:14px;margin:10px 0 4px}" +
    ".summary{background:linear-gradient(135deg,var(--soft),#f3f9f4);border:1px solid var(--g);border-radius:14px;padding:18px 20px;margin:16px 0}" +
    ".kpi{font-size:30px;font-weight:800;color:var(--gdeep);letter-spacing:-.02em}" +
    ".verdict{margin:6px 0 0;font-size:15px}.verdict strong{color:var(--gd)}" +
    "table{width:100%;border-collapse:collapse;margin:8px 0}" +
    "th,td{border:1px solid var(--bd);padding:9px 10px;text-align:left;vertical-align:top}" +
    "th{background:var(--soft);color:var(--gd)}.c{text-align:center;white-space:nowrap}" +
    ".muted{color:var(--muted)}.small{font-size:13px}.areascore{margin:8px 0 2px}" +
    ".brand{display:flex;align-items:center;gap:20px;border-bottom:2px solid var(--g);padding-bottom:14px;margin-bottom:18px}" +
    ".brand-logo{height:52px;width:auto;flex:0 0 auto}.brand h1{margin:2px 0}" +
    ".area{page-break-inside:avoid}@media print{body{margin:12mm}}" +
    "</style></head><body>" +
    "<div class='brand'>" +
      (logoDataUrl ? "<img class='brand-logo' src='" + logoDataUrl + "' alt='Junta de Andalucía'/>" : "") +
      "<div>" +
        "<p class='kicker'>" + escapeHTML(rubric.rubric_competency || "Mapa de Competencias Básicas · Junta de Andalucía") + "</p>" +
        "<h1>" + escapeHTML(rubric.rubric_title || "Rúbrica") + "</h1>" +
        "<p class='rol'>" + escapeHTML(rubric.rubric_rol || "") + "</p>" +
      "</div>" +
    "</div>" +
    (rubric.rubric_definition ? "<p class='muted'>" + escapeHTML(rubric.rubric_definition) + "</p>" : "") +
    "<div class='meta'>" + meta.join("") + "</div>" +
    "<div class='summary'><div class='kpi'>Puntuación global: " + scores.punt + "/" + scores.maxRaw + "</div>" +
      "<p class='verdict'><strong>Nivel de competencia:</strong> " + escapeHTML(gc.label || "–") + "</p>" +
      (gc.description ? "<p class='muted'>" + escapeHTML(gc.description) + "</p>" : "") +
      "<p class='small muted'>Calidad " + Math.round(scores.quality * 100) + "% · " +
        "Cobertura " + scores.accredited + "/" + scores.total + " actuaciones acreditadas</p>" +
    "</div>" +
    areasHTML +
    "</body></html>";
}

/* ---------- Informe PDF nativo (jsPDF, descarga directa, sin imprimir) ---------- */
function buildReportPDF(JsPDF, rubric, selections, scores, studentName, logo){
  var doc = new JsPDF({ unit: "mm", format: "a4", compress: true });
  var pointsFor = pointsForFactory(rubric);
  var levelsMap = (rubric.scale && rubric.scale.levels || []).reduce(function(acc, l){
    acc[String(l.value)] = l.label; return acc;
  }, {});
  var maxArea = Number((rubric.scoring || {}).max_points_per_area) || 16;
  var areaRules = ((rubric.scoring || {}).classification_rules || {}).area || [];

  // Paleta de marca (Junta de Andalucía).
  var GREEN_DEEP = [0, 67, 28], GREEN = [0, 121, 50], GREEN_DK = [0, 90, 37];
  var INK = [46, 41, 37], MUTED = [85, 85, 89], SOFT = [234, 243, 236], BORDER = [214, 216, 218];

  var PW = 210, PH = 297, M = 16, CW = PW - 2 * M;
  var y = M;

  function ink(c){ doc.setTextColor(c[0], c[1], c[2]); }
  function ensure(h){ if(y + h > PH - M){ doc.addPage(); y = M; } }
  function wrap(text, w, size, style){
    doc.setFont("helvetica", style || "normal"); doc.setFontSize(size);
    return doc.splitTextToSize(String(text == null ? "" : text), w);
  }
  function paragraph(text, size, color, style, gap){
    var lines = wrap(text, CW, size, style);
    var lh = size * 0.3528 * 1.32;
    ensure(lines.length * lh);
    ink(color); doc.setFont("helvetica", style || "normal"); doc.setFontSize(size);
    doc.text(lines, M, y + lh * 0.8); y += lines.length * lh + (gap == null ? 2 : gap);
  }
  // Párrafo con "runs" de estilo mixto (p.ej. etiqueta en negrita + texto normal),
  // con word-wrap manual respetando CW. Mantiene el mismo control de página que paragraph().
  function paragraphRuns(runs, size, color, gap){
    var lh = size * 0.3528 * 1.32;
    doc.setFont("helvetica", "normal"); doc.setFontSize(size);
    var space = doc.getTextWidth(" ");
    var tokens = [];
    runs.forEach(function(run){
      var st = run.style || "normal";
      String(run.t == null ? "" : run.t).split(/\s+/).forEach(function(w){
        if(w !== "") tokens.push({ t: w, style: st });
      });
    });
    var lines = [], cur = [], curW = 0;
    tokens.forEach(function(tok){
      doc.setFont("helvetica", tok.style); tok.w = doc.getTextWidth(tok.t);
      var add = (cur.length ? space : 0) + tok.w;
      if(curW + add > CW && cur.length){ lines.push(cur); cur = []; curW = 0; add = tok.w; }
      cur.push(tok); curW += add;
    });
    if(cur.length) lines.push(cur);
    ensure(lines.length * lh);
    ink(color);
    var yy = y + lh * 0.8;
    lines.forEach(function(line){
      var x = M;
      line.forEach(function(tok, i){
        if(i) x += space;
        doc.setFont("helvetica", tok.style); doc.setFontSize(size);
        doc.text(tok.t, x, yy); x += tok.w;
      });
      yy += lh;
    });
    y += lines.length * lh + (gap == null ? 2 : gap);
  }

  /* -- Cabecera de marca (apilado dinámico: soporta títulos largos sin solaparse) -- */
  var textX = M, logoH = 16;
  if(logo && logo.data && logo.w && logo.h){
    var logoW = logoH * (logo.w / logo.h);
    try{ doc.addImage(logo.data, "JPEG", M, y, logoW, logoH); textX = M + logoW + 6; }catch(e){ textX = M; }
  }
  var tw = PW - M - textX;
  var kickLines = wrap(String(rubric.rubric_competency || "Mapa de Competencias Básicas · Junta de Andalucía").toUpperCase(), tw, 8, "bold");
  var titleLines = wrap(String(rubric.rubric_title || "Rúbrica"), tw, 17, "bold");
  var rolLines = wrap(String(rubric.rubric_rol || ""), tw, 11, "bold");
  var hy = y + 3.2;
  ink(MUTED); doc.setFont("helvetica", "bold"); doc.setFontSize(8);
  doc.text(kickLines, textX, hy); hy += (kickLines.length - 1) * 3.4 + 6.6;
  ink(GREEN_DEEP); doc.setFont("helvetica", "bold"); doc.setFontSize(17);
  doc.text(titleLines, textX, hy); hy += (titleLines.length - 1) * 6.6 + 6.2;
  ink(INK); doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  doc.text(rolLines, textX, hy); hy += (rolLines.length - 1) * 5;
  y = Math.max(y + logoH, hy + 2) + 3;
  doc.setDrawColor(GREEN[0], GREEN[1], GREEN[2]); doc.setLineWidth(0.7);
  doc.line(M, y, M + CW, y); y += 6;

  /* -- Definición + meta (etiqueta en negrita, como en pantalla) -- */
  if(rubric.rubric_definition){
    var defM = rubric.rubric_definition.match(/^(\s*Definici[oó]n de la competencia\s*:?)([\s\S]*)$/i);
    if(defM){
      paragraphRuns([{ t: defM[1].trim(), style: "bold" }, { t: defM[2], style: "normal" }], 9.5, MUTED, 3);
    } else {
      paragraph(rubric.rubric_definition, 9.5, MUTED, "normal", 3);
    }
  }
  var fecha = "";
  try{ fecha = new Date().toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" }); }catch(e){}
  var metaParts = [];
  if(studentName) metaParts.push("Persona: " + studentName);
  metaParts.push("Rol: " + roleValue(rubric.rubric_rol));
  if(fecha) metaParts.push("Fecha: " + fecha);
  paragraph(metaParts.join("     ·     "), 9, MUTED, "normal", 4);

  /* -- Cuadro resumen global -- */
  var gc = scores.globalClass || {};
  var boxPad = 5;
  var kpiLines = wrap("Puntuación global: " + scores.punt + "/" + scores.maxRaw, CW - 2 * boxPad, 15, "bold");
  var verdictLines = wrap("Nivel de competencia: " + (gc.label || "–"), CW - 2 * boxPad, 10.5, "bold");
  var descLines = gc.description ? wrap(gc.description, CW - 2 * boxPad, 9.5, "normal") : [];
  var covLines = wrap("Calidad " + Math.round(scores.quality * 100) + "%   ·   Cobertura " +
    scores.accredited + "/" + scores.total + " actuaciones acreditadas", CW - 2 * boxPad, 9, "normal");
  var boxH = boxPad * 2 + kpiLines.length * 6.6 + verdictLines.length * 4.6 +
    descLines.length * 4.2 + covLines.length * 4.0 + 3;
  ensure(boxH + 2);
  doc.setFillColor(SOFT[0], SOFT[1], SOFT[2]);
  doc.setDrawColor(GREEN[0], GREEN[1], GREEN[2]); doc.setLineWidth(0.5);
  doc.roundedRect(M, y, CW, boxH, 3, 3, "FD");
  var by = y + boxPad + 4.5, bx = M + boxPad;
  ink(GREEN_DEEP); doc.setFont("helvetica", "bold"); doc.setFontSize(15);
  doc.text(kpiLines, bx, by); by += kpiLines.length * 6.6 + 1;
  ink(GREEN_DK); doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
  doc.text(verdictLines, bx, by); by += verdictLines.length * 4.6;
  if(descLines.length){ ink(MUTED); doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
    doc.text(descLines, bx, by); by += descLines.length * 4.2; }
  ink(MUTED); doc.setFont("helvetica", "normal"); doc.setFontSize(9);
  doc.text(covLines, bx, by);
  y += boxH + 8;

  /* -- Detalle por comportamiento -- */
  var GRADE_W = 34, ACT_W = CW - GRADE_W, PADX = 3;
  function tableHeader(){
    var hH = 8;
    ensure(hH);
    doc.setFillColor(SOFT[0], SOFT[1], SOFT[2]);
    doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]); doc.setLineWidth(0.3);
    doc.rect(M, y, ACT_W, hH, "FD"); doc.rect(M + ACT_W, y, GRADE_W, hH, "FD");
    ink(GREEN_DK); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
    doc.text("Actuación", M + PADX, y + 5.4);
    doc.text("Grado", M + ACT_W + GRADE_W / 2, y + 5.4, { align: "center" });
    y += hH;
  }
  function tableRow(actText, gradeText){
    var lines = wrap(actText, ACT_W - 2 * PADX, 9, "normal");
    var lh = 4.2, rowH = Math.max(lines.length * lh + 3.6, 8);
    if(y + rowH > PH - M){ doc.addPage(); y = M; tableHeader(); }
    doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]); doc.setLineWidth(0.3);
    doc.rect(M, y, ACT_W, rowH); doc.rect(M + ACT_W, y, GRADE_W, rowH);
    ink(INK); doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    doc.text(lines, M + PADX, y + 3.4 + lh * 0.4);
    ink(GREEN_DK); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
    doc.text(String(gradeText), M + ACT_W + GRADE_W / 2, y + rowH / 2 + 1.4, { align: "center" });
    y += rowH;
  }

  (rubric.areas || []).forEach(function(a, idx){
    ensure(20);
    y += 2;
    ink(GREEN_DK); doc.setFont("helvetica", "bold"); doc.setFontSize(12);
    var titleLines = wrap((idx + 1) + ". " + (a.title || "Comportamiento"), CW, 12, "bold");
    doc.text(titleLines, M, y + 4); y += titleLines.length * 5 + 2;
    if(a.description) paragraph(a.description, 9, MUTED, "normal", 2);
    tableHeader();
    (a.behaviors || []).forEach(function(b){
      var v = selections[b.id];
      var label = (v != null && v !== "") ? (levelsMap[String(v)] || String(v)) : "Sin valorar";
      tableRow(b.text || "—", label);
    });
    var sVal = areaScore(a, selections, pointsFor);
    var answered = areaAnswered(a, selections);
    var cls = answered === 0 ? {} : (classifyByRange(sVal, areaRules) || {});
    var clsText = areaClassText(a, cls.label) || cls.description || "";
    y += 2;
    paragraph("Puntuación: " + sVal + "/" + maxArea + "     ·     Nivel: " +
      (answered === 0 ? "Sin valorar" : (cls.label || "–")), 9.5, INK, "bold", 1);
    if(clsText) paragraph(clsText, 9, MUTED, "normal", 3);
  });

  /* -- Pie de página en cada hoja -- */
  var total = doc.getNumberOfPages();
  for(var p = 1; p <= total; p++){
    doc.setPage(p);
    ink(MUTED); doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    doc.text("Autoevaluación de competencias · Junta de Andalucía", M, PH - 8);
    doc.text(p + " / " + total, PW - M, PH - 8, { align: "right" });
  }
  return doc;
}
