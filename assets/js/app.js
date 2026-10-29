/**
 * PMO FIBEX TELECOM - DASHBOARD INTERACTIVO MULTI-REPORTE
 * Gestión y Seguimiento de HUBs, Enlaces Troncales y NOC
 */

(function () {
  'use strict';

  // API Conector de Google Sheets (Solo Lectura)
  const GOOGLE_SHEETS_API_URL = 'https://script.google.com/macros/s/AKfycbzhlff1TQhyWF3RaMHlfhp-HtYLbG9hQRSe-ZtMKuYO_M7W7nI-bks0qM-4r8lB3znL/exec';

  // State
  const state = {
    currentView: 'general',
    hubsTab: 'consolidado', // 'consolidado', 'nuevos', 'operaciones'
    enlacesTab: 'consolidado', // 'consolidado', 'operaciones', 'nuevos'
    hubsTaskFilter: null, // null, 'no_iniciadas', 'en_curso', 'completadas', 'retrasadas'
    enlacesTaskFilter: null, // null, 'no_iniciadas', 'en_curso', 'completadas', 'retrasadas'
    nocDeptFilter: null,
    hubsResponsableFilter: '', // Selected responsable in HUBS dropdown
    enlacesResponsableFilter: '', // Selected responsable in ENLACES dropdown
    nocResponsableFilter: '', // Selected responsable in NOC dropdown
    nocTaskFilter: null, // null, 'no_iniciadas', 'en_curso', 'completadas', 'retrasadas'
    searchQuery: '',
    rawData: (() => {
      try {
        const cached = localStorage.getItem('pmo_sheets_cached_data');
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
            return parsed;
          }
        }
      } catch (e) {}
      return window.INITIAL_PMO_DATA || {};
    })(),
    lastModifiedDate: (() => {
      try {
        const storedSync = localStorage.getItem('pmo_last_sync_date');
        if (storedSync) {
          const d = new Date(storedSync);
          if (!isNaN(d.getTime())) return d;
        }
        if (window.PMO_LAST_MODIFIED_DATE) {
          const d = new Date(window.PMO_LAST_MODIFIED_DATE);
          if (!isNaN(d.getTime())) return d;
        }
        const stored = localStorage.getItem('pmo_last_modified_date');
        if (stored) {
          const d = new Date(stored);
          if (!isNaN(d.getTime())) return d;
        }
      } catch (e) {}
      return new Date();
    })(),
    isSyncing: false,
    processed: {
      hubsNuevos: [],
      hubsOperaciones: [],
      hubsAll: [],
      enlacesOperaciones: [],
      enlacesNuevos: [],
      enlacesAll: [],
      noc: []
    },
    metrics: {}
  };

  // Chart instances
  let chartComparativo = null;
  let chartGlobalEstados = null;
  let chartHubsRanking = null;
  let chartNocDept = null;
  let chartNocUrgent = null;

  /* ==========================================================================
     HELPERS & PARSING
     ========================================================================== */

  function getFormattedReportDate(d) {
    const dateObj = (d instanceof Date && !isNaN(d.getTime())) ? d : new Date();
    const weekday = dateObj.toLocaleDateString('es-ES', { weekday: 'long' });
    const day = dateObj.getDate();
    const month = dateObj.toLocaleDateString('es-ES', { month: 'long' });
    const year = dateObj.getFullYear();
    
    const capWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    const capMonth = month.charAt(0).toUpperCase() + month.slice(1);
    
    return `${capWeekday}, ${day} de ${capMonth} de ${year}`;
  }

  function updateReportDates() {
    const formatted = getFormattedReportDate(state.lastModifiedDate);
    const timeStr = (state.lastModifiedDate instanceof Date && !isNaN(state.lastModifiedDate.getTime()))
      ? state.lastModifiedDate.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
      : '';

    const hubsDateEl = document.getElementById('hubs-report-date');
    if (hubsDateEl) {
      hubsDateEl.textContent = `Generado el: ${formatted}`;
    }

    const enlacesDateEl = document.getElementById('enlaces-report-date');
    if (enlacesDateEl) {
      enlacesDateEl.textContent = `Operaciones y Nuevos Proyectos • Generado el: ${formatted}`;
    }

    const nocDateEl = document.getElementById('noc-report-date');
    if (nocDateEl) {
      nocDateEl.textContent = `Comité de Dirección • Generado el: ${formatted}`;
    }

    const heroDateText = document.getElementById('hero-date-text');
    if (heroDateText) {
      heroDateText.textContent = `📅 Fecha de Reporte: ${formatted}`;
    } else {
      const heroDateEl = document.getElementById('hero-report-date');
      if (heroDateEl) {
        heroDateEl.textContent = `📅 Fecha de Reporte: ${formatted}`;
      }
    }

    const syncBadge = document.getElementById('hero-sync-badge');
    if (syncBadge && !state.isSyncing) {
      syncBadge.className = 'sync-badge-live';
      syncBadge.textContent = timeStr 
        ? `🟢 Google Sheets en vivo (${timeStr})` 
        : `🟢 Conectado con Google Sheets`;
    }
  }

  function recordModification() {
    state.lastModifiedDate = new Date();
    try {
      localStorage.setItem('pmo_last_modified_date', state.lastModifiedDate.toISOString());
    } catch (e) {}
    updateReportDates();
  }

  function normalizeKey(k) {
    if (!k) return '';
    return k.trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, '_');
  }

  function formatDate(val) {
    if (!val || val === '-' || val === 'nan' || val === 'NaN') return '-';
    if (val instanceof Date) {
      if (isNaN(val.getTime())) return '-';
      const d = String(val.getDate()).padStart(2, '0');
      const m = String(val.getMonth() + 1).padStart(2, '0');
      const y = val.getFullYear();
      return `${d}/${m}/${y}`;
    }
    if (typeof val === 'number') {
      const date = new Date(Math.round((val - 25569) * 86400 * 1000));
      const d = String(date.getUTCDate()).padStart(2, '0');
      const m = String(date.getUTCMonth() + 1).padStart(2, '0');
      const y = date.getUTCFullYear();
      return `${d}/${m}/${y}`;
    }
    if (typeof val === 'string') {
      const s = val.trim();
      if (!s || s === '-' || s.toLowerCase() === 'nan') return '-';
      const match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (match) {
        return `${match[3].padStart(2, '0')}/${match[2].padStart(2, '0')}/${match[1]}`;
      }
      if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) return s;
      return s;
    }
    return '-';
  }

  function parseDateObj(val) {
    if (!val || val === '-' || val === 'nan' || val === 'NaN') return null;
    if (val instanceof Date) {
      if (isNaN(val.getTime())) return null;
      return new Date(val.getFullYear(), val.getMonth(), val.getDate());
    }
    if (typeof val === 'number') {
      const d = new Date(Math.round((val - 25569) * 86400 * 1000));
      return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
    if (typeof val === 'string') {
      const s = val.trim();
      if (!s || s === '-' || s.toLowerCase() === 'nan') return null;
      const matchIso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (matchIso) {
        return new Date(parseInt(matchIso[1]), parseInt(matchIso[2]) - 1, parseInt(matchIso[3]));
      }
      const matchSlash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (matchSlash) {
        return new Date(parseInt(matchSlash[3]), parseInt(matchSlash[2]) - 1, parseInt(matchSlash[1]));
      }
    }
    return null;
  }

  function isCompletedAfterPlanned(completedVal, plannedVal) {
    const dComp = parseDateObj(completedVal);
    const dPlan = parseDateObj(plannedVal);
    if (!dComp || !dPlan) return false;
    return dComp.getTime() > dPlan.getTime();
  }

  function parseChecklist(val) {
    if (!val || typeof val !== 'string' || !val.includes('/')) {
      return { done: 0, total: 0, str: '-' };
    }
    const parts = val.split('/');
    const done = parseFloat(parts[0].trim()) || 0;
    const total = parseFloat(parts[1].trim()) || 0;
    return { done, total, str: `${done}/${total}` };
  }

  function calculateTaskAdvance(task) {
    const status = (task['Estado'] || '').trim().toLowerCase();
    const chk = parseChecklist(task['Elementos de la lista de comprobación completados']);
    
    if (status === 'completado') {
      return 100;
    }
    if (chk.total > 0) {
      return Math.round((chk.done / chk.total) * 1000) / 10;
    }
    if (status === 'en curso') {
      return 50;
    }
    return 0;
  }

  function isTaskDelayed(task) {
    const rawLate = task['Con retraso'];
    if (rawLate === true || rawLate === 'True' || rawLate === 'true' || rawLate === 1) return true;
    
    // Check due date
    const dueStr = formatDate(task['Fecha de vencimiento']);
    if (dueStr !== '-') {
      const parts = dueStr.split('/');
      if (parts.length === 3) {
        const dueDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
        const status = (task['Estado'] || '').trim().toLowerCase();
        if (status !== 'completado') {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          if (dueDate < today) return true;
        }
      }
    }
    return false;
  }

  function isDueWithin3Days(task) {
    const status = (task['Estado'] || '').trim().toLowerCase();
    if (status === 'completado') return false;
    const dueStr = formatDate(task['Fecha de vencimiento']);
    if (dueStr === '-') return false;
    const parts = dueStr.split('/');
    if (parts.length === 3) {
      const dueDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
      // Reference date or today
      const refDate = new Date(); // or 2026-10-21 corte
      const diffTime = dueDate.getTime() - refDate.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      return diffDays >= -1 && diffDays <= 3;
    }
    return false;
  }

  function getAssigneesAndTags(task) {
    const assignees = (task['Asignado a'] || '')
      .split(';')
      .map(s => s.trim())
      .filter(s => s && s.toLowerCase() !== 'nan');

    const tags = (task['Etiquetas'] || '')
      .split(';')
      .map(s => s.trim())
      .filter(s => s && s.toLowerCase() !== 'nan');

    return { assignees, tags };
  }

  /* ==========================================================================
     CUSTOM REASONS STORAGE & EDITING HELPERS
     ========================================================================== */

  function getCustomReason(entityName, taskName) {
    try {
      const key = `${entityName}:::${taskName}`;
      if (window.PMO_PRELOADED_REASONS && window.PMO_PRELOADED_REASONS[key] !== undefined) {
        return window.PMO_PRELOADED_REASONS[key];
      }
      const stored = localStorage.getItem('pmo_custom_reasons');
      if (!stored) return null;
      const map = JSON.parse(stored);
      return (map[key] !== undefined && map[key] !== null) ? map[key] : null;
    } catch (e) {
      return null;
    }
  }

  function saveCustomReason(entityName, taskName, reason) {
    try {
      const stored = localStorage.getItem('pmo_custom_reasons');
      const map = stored ? JSON.parse(stored) : {};
      const key = `${entityName}:::${taskName}`;
      map[key] = reason;
      localStorage.setItem('pmo_custom_reasons', JSON.stringify(map));
    } catch (e) {
      console.warn('Could not persist reason to localStorage', e);
    }
  }

  function updateTaskReasonInMemory(entityName, taskName, newReason) {
    const allLists = [
      state.processed.hubsAll,
      state.processed.hubsNuevos,
      state.processed.hubsOperaciones,
      state.processed.enlacesAll,
      state.processed.enlacesNuevos,
      state.processed.enlacesOperaciones
    ];

    allLists.forEach(list => {
      if (!list) return;
      list.forEach(entity => {
        if (entity.name === entityName) {
          entity.tasks.forEach(task => {
            if (task.name === taskName) {
              task.reason = newReason || '';
              if (task.raw) {
                task.raw['Notas'] = newReason;
              }
            }
          });
        }
      });
    });

    if (state.processed.noc) {
      state.processed.noc.forEach(task => {
        if ((task.department === entityName || entityName === 'NOC') && task.name === taskName) {
          task.reason = newReason || '';
          if (task.raw) {
            task.raw['Notas'] = newReason;
          }
        }
      });
    }

    recordModification();
  }

  /* ==========================================================================
     DATA PROCESSING
     ========================================================================== */

  function processData() {
    const raw = state.rawData;

    // Helper to find sheet
    function getSheet(pattern) {
      const keys = Object.keys(raw);
      for (const k of keys) {
        const upper = k.toUpperCase();
        if (pattern(upper)) return raw[k] || [];
      }
      return [];
    }

    const npHubsRaw = getSheet(u => u.includes('HUB') && (u.includes('NUEVO') || u.includes('PROYECT')));
    const opHubsRaw = getSheet(u => u.includes('HUB') && (u.includes('OPERACION') || u.includes('O&M')));
    const npEnlacesRaw = getSheet(u => u.includes('ENLACE') && (u.includes('NUEVO') || u.includes('PROYECT')));
    const opEnlacesRaw = getSheet(u => u.includes('ENLACE') && (u.includes('OPERACION') || u.includes('O&M')));
    const nocRaw = getSheet(u => u.includes('NOC') || u.includes('RED IP'));

    // Grouping function for HUBs or Enlaces
    function groupEntities(rows, categoryName) {
      const map = new Map();
      rows.forEach(r => {
        const name = (r['Depósito'] || r['Deposito'] || 'Sin Asignar').trim();
        if (!map.has(name)) {
          map.set(name, {
            name: name,
            category: categoryName,
            tasks: [],
            totalTasks: 0,
            completadas: 0,
            enCurso: 0,
            enCursoATiempo: 0,
            enCursoRetrasadas: 0,
            noIniciadas: 0,
            noIniciadasATiempo: 0,
            noIniciadasRetrasadas: 0,
            retrasadas: 0,
            advance: 0
          });
        }
        const item = map.get(name);
        const taskAdvance = calculateTaskAdvance(r);
        const delayed = isTaskDelayed(r);
        const st = (r['Estado'] || 'No iniciado').trim();
        
        const completedLate = isCompletedAfterPlanned(
          r['Fecha de finalización'] || r['Fecha de finalizacion'],
          r['Fecha de vencimiento']
        );
        
        const taskName = r['Nombre de la tarea'] || 'Sin nombre';
        const customReason = getCustomReason(name, taskName);
        let defaultReason = '-';
        if (r['Notas'] && String(r['Notas']).trim() && String(r['Notas']).toLowerCase() !== 'nan') {
          defaultReason = String(r['Notas']).trim();
        } else if (delayed) {
          defaultReason = 'Vencida fuera de plazo';
        }
        const finalReason = (customReason !== null && customReason !== undefined) ? customReason : defaultReason;

        const taskObj = {
          name: taskName,
          status: st,
          advance: taskAdvance,
          plannedDate: formatDate(r['Fecha de vencimiento']),
          completedDate: formatDate(r['Fecha de finalización'] || r['Fecha de finalizacion']),
          isCompletedLate: completedLate,
          reason: finalReason,
          checklist: r['Elementos de la lista de comprobación completados'] || '-',
          delayed: delayed,
          assignees: getAssigneesAndTags(r).assignees,
          tags: getAssigneesAndTags(r).tags,
          raw: r
        };

        item.tasks.push(taskObj);
        item.totalTasks++;
        if (st.toLowerCase() === 'completado') {
          item.completadas++;
        } else if (st.toLowerCase() === 'en curso') {
          item.enCurso++;
          if (delayed) {
            item.enCursoRetrasadas = (item.enCursoRetrasadas || 0) + 1;
          } else {
            item.enCursoATiempo = (item.enCursoATiempo || 0) + 1;
          }
        } else {
          item.noIniciadas++;
          if (delayed) {
            item.noIniciadasRetrasadas = (item.noIniciadasRetrasadas || 0) + 1;
          } else {
            item.noIniciadasATiempo = (item.noIniciadasATiempo || 0) + 1;
          }
        }

        if (delayed) item.retrasadas++;
      });

      // Calculate advance average for each entity
      const list = [];
      map.forEach(item => {
        // Requirement: Los HUBs / Enlaces que tengan las tareas recuperacion optica y auditoria y diagnostico.
        // Pon primero auditoria y diagnostico y luego recuperacion optica
        item.tasks.sort((a, b) => {
          const aNorm = normalizeKey(a.name).toLowerCase();
          const bNorm = normalizeKey(b.name).toLowerCase();

          const aIsAudit = aNorm.includes('auditoria') || aNorm.includes('diagnostico');
          const bIsAudit = bNorm.includes('auditoria') || bNorm.includes('diagnostico');
          const aIsRecup = aNorm.includes('recuperacion');
          const bIsRecup = bNorm.includes('recuperacion');

          if (aIsAudit && bIsRecup) return -1;
          if (aIsRecup && bIsAudit) return 1;
          return 0;
        });

        if (item.tasks.length > 0) {
          const sum = item.tasks.reduce((acc, t) => acc + t.advance, 0);
          item.advance = Math.round(sum / item.tasks.length);
        }
        list.push(item);
      });
      list.sort((a, b) => b.advance - a.advance);
      return list;
    }

    state.processed.hubsNuevos = groupEntities(npHubsRaw, 'Nuevos Proyectos');
    state.processed.hubsOperaciones = groupEntities(opHubsRaw, 'Operaciones');
    state.processed.hubsAll = [...state.processed.hubsNuevos, ...state.processed.hubsOperaciones];

    state.processed.enlacesNuevos = groupEntities(npEnlacesRaw, 'Nuevos Proyectos');
    state.processed.enlacesOperaciones = groupEntities(opEnlacesRaw, 'Operaciones');
    state.processed.enlacesAll = [...state.processed.enlacesNuevos, ...state.processed.enlacesOperaciones];

    // Process NOC
    state.processed.noc = nocRaw.map(r => {
      const taskAdvance = calculateTaskAdvance(r);
      const delayed = isTaskDelayed(r);
      const dueSoon = isDueWithin3Days(r);
      const st = (r['Estado'] || 'No iniciado').trim();
      const people = getAssigneesAndTags(r);

      const completedLate = isCompletedAfterPlanned(
        r['Fecha de finalización'] || r['Fecha de finalizacion'],
        r['Fecha de vencimiento']
      );

      const dept = (r['Depósito'] || r['Deposito'] || 'Sin Depósito').trim();
      const taskName = r['Nombre de la tarea'] || 'Sin nombre';
      const customReason = getCustomReason(dept, taskName);
      // Clean reason ready for writing, clear pre-filled text unless user saved a custom reason
      const finalReason = customReason || '';

      const priorityRaw = r['Priority'] || r['Prioridad'] || r['prioridad'] || r['priority'] || 'Media';
      const priority = String(priorityRaw).trim();
      const hasUrgentTag = people.tags.some(tg => tg.toLowerCase().includes('urgente'));
      const isUrgent = priority.toLowerCase() === 'urgente' || hasUrgentTag;

      return {
        name: taskName,
        department: dept,
        status: st,
        priority: priority,
        isUrgent: isUrgent,
        advance: taskAdvance,
        plannedDate: formatDate(r['Fecha de vencimiento']),
        completedDate: formatDate(r['Fecha de finalización'] || r['Fecha de finalizacion']),
        isCompletedLate: completedLate,
        reason: finalReason,
        checklist: r['Elementos de la lista de comprobación completados'] || '-',
        delayed: delayed,
        dueSoon: dueSoon,
        assignees: people.assignees,
        tags: people.tags,
        raw: r
      };
    });

    // Calculate Global Metrics
    calculateGlobalMetrics();
  }

  function calculateGlobalMetrics() {
    const { hubsNuevos, hubsOperaciones, hubsAll, enlacesNuevos, enlacesOperaciones, enlacesAll, noc } = state.processed;

    // Advance Hubs Nuevos Proyectos (Exact 60% like hubs.pdf)
    const hubsNuevosAdv = hubsNuevos.length > 0 
      ? Math.round(hubsNuevos.reduce((acc, h) => acc + h.advance, 0) / hubsNuevos.length)
      : 0;

    // Advance Hubs Operaciones
    const hubsOpAdv = hubsOperaciones.length > 0 
      ? Math.round(hubsOperaciones.reduce((acc, h) => acc + h.advance, 0) / hubsOperaciones.length)
      : 0;

    // Advance Hubs Consolidado (weighted or simple average across all HUBs)
    const hubsAllAdv = hubsAll.length > 0 
      ? Math.round(hubsAll.reduce((acc, h) => acc + h.advance, 0) / hubsAll.length)
      : 0;

    // Advance Enlaces Nuevos Proyectos
    const enlacesNuevosAdv = enlacesNuevos && enlacesNuevos.length > 0
      ? Math.round(enlacesNuevos.reduce((acc, e) => acc + e.advance, 0) / enlacesNuevos.length)
      : 0;

    // Advance Enlaces Operaciones
    const enlacesOpAdv = enlacesOperaciones && enlacesOperaciones.length > 0
      ? Math.round(enlacesOperaciones.reduce((acc, e) => acc + e.advance, 0) / enlacesOperaciones.length)
      : 0;

    // Advance Enlaces Consolidado (Exact 60% average of active links)
    const enlacesAdv = enlacesAll.length > 0
      ? Math.round(enlacesAll.reduce((acc, e) => acc + e.advance, 0) / enlacesAll.length)
      : 0;

    // Advance NOC (Average of all task advances in NOC)
    const nocAdv = noc.length > 0
      ? Math.round(noc.reduce((acc, t) => acc + t.advance, 0) / noc.length)
      : 0;

    // Overall Combined PMO Portfolio Advance: Promedio de las 3 áreas del portafolio (HUBs, Enlaces, NOC)
    const validAreas = [hubsAllAdv, enlacesAdv, nocAdv].filter(v => typeof v === 'number');
    const globalAdvance = validAreas.length > 0 ? Math.round(validAreas.reduce((a, b) => a + b, 0) / validAreas.length) : 0;

    // All Tasks Totals
    let totalTasks = 0, completadas = 0, enCurso = 0, noIniciadas = 0, retrasadas = 0;
    let enCursoATiempo = 0, enCursoRetrasadas = 0, noIniciadasATiempo = 0, noIniciadasRetrasadas = 0;

    hubsAll.forEach(h => {
      totalTasks += h.totalTasks;
      completadas += h.completadas;
      enCurso += h.enCurso;
      enCursoATiempo += (h.enCursoATiempo || 0);
      enCursoRetrasadas += (h.enCursoRetrasadas || 0);
      noIniciadas += h.noIniciadas;
      noIniciadasATiempo += (h.noIniciadasATiempo || 0);
      noIniciadasRetrasadas += (h.noIniciadasRetrasadas || 0);
      retrasadas += h.retrasadas;
    });

    enlacesAll.forEach(e => {
      totalTasks += e.totalTasks;
      completadas += e.completadas;
      enCurso += e.enCurso;
      enCursoATiempo += (e.enCursoATiempo || 0);
      enCursoRetrasadas += (e.enCursoRetrasadas || 0);
      noIniciadas += e.noIniciadas;
      noIniciadasATiempo += (e.noIniciadasATiempo || 0);
      noIniciadasRetrasadas += (e.noIniciadasRetrasadas || 0);
      retrasadas += e.retrasadas;
    });

    noc.forEach(t => {
      totalTasks++;
      const st = (t.status || '').toLowerCase().trim();
      if (st === 'completado') {
        completadas++;
      } else if (st === 'en curso') {
        enCurso++;
        if (t.delayed) {
          enCursoRetrasadas++;
        } else {
          enCursoATiempo++;
        }
      } else {
        noIniciadas++;
        if (t.delayed) {
          noIniciadasRetrasadas++;
        } else {
          noIniciadasATiempo++;
        }
      }

      if (t.delayed) retrasadas++;
    });

    state.metrics = {
      globalAdvance,
      hubsNuevosAdv,
      hubsOpAdv,
      hubsAllAdv,
      enlacesNuevosAdv,
      enlacesOpAdv,
      enlacesAdv,
      nocAdv,
      totalTasks,
      completadas,
      enCurso,
      enCursoATiempo,
      enCursoRetrasadas,
      noIniciadas,
      noIniciadasATiempo,
      noIniciadasRetrasadas,
      retrasadas
    };
  }

  /* ==========================================================================
     RENDERERS
     ========================================================================== */

  function renderApp() {
    updateReportDates();
    renderMainDashboard();
    renderHubsView();
    renderEnlacesView();
    renderNocView();
    updateCharts();
  }

  /* 1. Main Dashboard View */
  function renderMainDashboard() {
    const m = state.metrics;

    // Hero metrics
    document.getElementById('hero-global-percent').textContent = `${m.globalAdvance}%`;
    document.getElementById('hero-meter-fill').style.width = `${m.globalAdvance}%`;

    document.getElementById('kpi-total-tasks').textContent = m.totalTasks;
    document.getElementById('kpi-done-tasks').textContent = m.completadas;
    
    const elKpiProgTotal = document.getElementById('kpi-progress-total');
    if (elKpiProgTotal) elKpiProgTotal.textContent = `${m.enCurso} total`;

    const elKpiProgOntime = document.getElementById('kpi-progress-ontime-tasks');
    if (elKpiProgOntime) elKpiProgOntime.textContent = m.enCursoATiempo;
    
    const elKpiProgLate = document.getElementById('kpi-progress-late-tasks');
    if (elKpiProgLate) elKpiProgLate.textContent = m.enCursoRetrasadas;

    const elKpiUnstartedTotal = document.getElementById('kpi-unstarted-total');
    if (elKpiUnstartedTotal) elKpiUnstartedTotal.textContent = `${m.noIniciadas} total`;

    const elKpiUnstartedOntime = document.getElementById('kpi-unstarted-ontime-tasks');
    if (elKpiUnstartedOntime) elKpiUnstartedOntime.textContent = m.noIniciadasATiempo;

    const elKpiUnstartedLate = document.getElementById('kpi-unstarted-late-tasks');
    if (elKpiUnstartedLate) elKpiUnstartedLate.textContent = m.noIniciadasRetrasadas;

    // Card HUBS
    const hubsCount = state.processed.hubsAll.length;
    const hubsTotalTasks = state.processed.hubsAll.reduce((a, h) => a + h.totalTasks, 0);
    const hubsDone = state.processed.hubsAll.reduce((a, h) => a + h.completadas, 0);
    const hubsProgOntime = state.processed.hubsAll.reduce((a, h) => a + (h.enCursoATiempo || 0), 0);
    const hubsProgLate = state.processed.hubsAll.reduce((a, h) => a + (h.enCursoRetrasadas || 0), 0);
    const hubsUnstartedOntime = state.processed.hubsAll.reduce((a, h) => a + (h.noIniciadasATiempo || 0), 0);
    const hubsUnstartedLate = state.processed.hubsAll.reduce((a, h) => a + (h.noIniciadasRetrasadas || 0), 0);

    const hubsTitleBadge = document.getElementById('card-hubs-count-badge');
    if (hubsTitleBadge) hubsTitleBadge.textContent = `(${hubsCount} HUBs)`;

    const hubsDescNuevos = document.getElementById('card-hubs-desc-nuevos');
    if (hubsDescNuevos) hubsDescNuevos.textContent = state.processed.hubsNuevos.length;
    const hubsDescOps = document.getElementById('card-hubs-desc-ops');
    if (hubsDescOps) hubsDescOps.textContent = state.processed.hubsOperaciones.length;

    document.getElementById('card-hubs-percent').textContent = `${m.hubsAllAdv}%`;
    document.getElementById('card-hubs-fill').style.width = `${m.hubsAllAdv}%`;
    document.getElementById('card-hubs-stat-total').textContent = hubsTotalTasks;
    document.getElementById('card-hubs-stat-done').textContent = hubsDone;
    
    const elHubsProgOntime = document.getElementById('card-hubs-stat-prog-ontime');
    if (elHubsProgOntime) elHubsProgOntime.textContent = hubsProgOntime;
    const elHubsProgLate = document.getElementById('card-hubs-stat-prog-late');
    if (elHubsProgLate) elHubsProgLate.textContent = hubsProgLate;
    const elHubsUnstartedOntime = document.getElementById('card-hubs-stat-unstarted-ontime');
    if (elHubsUnstartedOntime) elHubsUnstartedOntime.textContent = hubsUnstartedOntime;
    const elHubsUnstartedLate = document.getElementById('card-hubs-stat-unstarted-late');
    if (elHubsUnstartedLate) elHubsUnstartedLate.textContent = hubsUnstartedLate;

    // Card ENLACES
    const enlacesCount = state.processed.enlacesAll.length;
    const enlacesTotalTasks = state.processed.enlacesAll.reduce((a, e) => a + e.totalTasks, 0);
    const enlacesDone = state.processed.enlacesAll.reduce((a, e) => a + e.completadas, 0);
    const enlacesProgOntime = state.processed.enlacesAll.reduce((a, e) => a + (e.enCursoATiempo || 0), 0);
    const enlacesProgLate = state.processed.enlacesAll.reduce((a, e) => a + (e.enCursoRetrasadas || 0), 0);
    const enlacesUnstartedOntime = state.processed.enlacesAll.reduce((a, e) => a + (e.noIniciadasATiempo || 0), 0);
    const enlacesUnstartedLate = state.processed.enlacesAll.reduce((a, e) => a + (e.noIniciadasRetrasadas || 0), 0);

    const enlacesTitleBadge = document.getElementById('card-enlaces-count-badge');
    if (enlacesTitleBadge) enlacesTitleBadge.textContent = `(${enlacesCount} Enlaces)`;

    document.getElementById('card-enlaces-percent').textContent = `${m.enlacesAdv}%`;
    document.getElementById('card-enlaces-fill').style.width = `${m.enlacesAdv}%`;
    document.getElementById('card-enlaces-stat-total').textContent = enlacesTotalTasks;
    document.getElementById('card-enlaces-stat-done').textContent = enlacesDone;

    const elEnlacesProgOntime = document.getElementById('card-enlaces-stat-prog-ontime');
    if (elEnlacesProgOntime) elEnlacesProgOntime.textContent = enlacesProgOntime;
    const elEnlacesProgLate = document.getElementById('card-enlaces-stat-prog-late');
    if (elEnlacesProgLate) elEnlacesProgLate.textContent = enlacesProgLate;
    const elEnlacesUnstartedOntime = document.getElementById('card-enlaces-stat-unstarted-ontime');
    if (elEnlacesUnstartedOntime) elEnlacesUnstartedOntime.textContent = enlacesUnstartedOntime;
    const elEnlacesUnstartedLate = document.getElementById('card-enlaces-stat-unstarted-late');
    if (elEnlacesUnstartedLate) elEnlacesUnstartedLate.textContent = enlacesUnstartedLate;

    // Card NOC
    const nocCount = state.processed.noc.length;
    const nocDone = state.processed.noc.filter(t => (t.status || '').toLowerCase() === 'completado').length;
    const nocProgOntime = state.processed.noc.filter(t => (t.status || '').toLowerCase() === 'en curso' && !t.delayed).length;
    const nocProgLate = state.processed.noc.filter(t => (t.status || '').toLowerCase() === 'en curso' && t.delayed).length;
    const nocUnstartedOntime = state.processed.noc.filter(t => {
      const s = (t.status || '').toLowerCase().trim();
      return s !== 'completado' && s !== 'en curso' && !t.delayed;
    }).length;
    const nocUnstartedLate = state.processed.noc.filter(t => {
      const s = (t.status || '').toLowerCase().trim();
      return s !== 'completado' && s !== 'en curso' && t.delayed;
    }).length;

    document.getElementById('card-noc-percent').textContent = `${m.nocAdv}%`;
    document.getElementById('card-noc-fill').style.width = `${m.nocAdv}%`;
    document.getElementById('card-noc-stat-total').textContent = nocCount;
    document.getElementById('card-noc-stat-done').textContent = nocDone;

    const elNocProgOntime = document.getElementById('card-noc-stat-prog-ontime');
    if (elNocProgOntime) elNocProgOntime.textContent = nocProgOntime;
    const elNocProgLate = document.getElementById('card-noc-stat-prog-late');
    if (elNocProgLate) elNocProgLate.textContent = nocProgLate;
    const elNocUnstartedOntime = document.getElementById('card-noc-stat-unstarted-ontime');
    if (elNocUnstartedOntime) elNocUnstartedOntime.textContent = nocUnstartedOntime;
    const elNocUnstartedLate = document.getElementById('card-noc-stat-unstarted-late');
    if (elNocUnstartedLate) elNocUnstartedLate.textContent = nocUnstartedLate;
  }

  /* Populate Responsables dropdown for HUBS view */
  function populateHubsResponsablesSelect(baseHubsList) {
    const select = document.getElementById('hubs-responsable-select');
    const clearBtn = document.getElementById('btn-clear-responsable-filter');
    if (!select) return;

    // Collect unique assignees and tags with task counts
    const assigneesMap = new Map();
    const tagsMap = new Map();

    baseHubsList.forEach(hub => {
      hub.tasks.forEach(task => {
        task.assignees.forEach(a => {
          const trimmed = (a || '').trim();
          if (trimmed && trimmed.toLowerCase() !== 'nan') {
            assigneesMap.set(trimmed, (assigneesMap.get(trimmed) || 0) + 1);
          }
        });
        task.tags.forEach(tg => {
          const trimmed = (tg || '').trim();
          if (trimmed && trimmed.toLowerCase() !== 'nan') {
            tagsMap.set(trimmed, (tagsMap.get(trimmed) || 0) + 1);
          }
        });
      });
    });

    const currentVal = state.hubsResponsableFilter;
    const sortedAssignees = Array.from(assigneesMap.keys()).sort((a, b) => a.localeCompare(b));
    const sortedTags = Array.from(tagsMap.keys()).sort((a, b) => a.localeCompare(b));

    let optionsHtml = '<option value="">👤 Todos los Responsables</option>';

    if (sortedAssignees.length > 0) {
      optionsHtml += '<optgroup label="Personas / Asignados">';
      sortedAssignees.forEach(name => {
        const count = assigneesMap.get(name);
        const sel = (currentVal === name) ? ' selected' : '';
        optionsHtml += `<option value="${escapeHtml(name)}"${sel}>👤 ${escapeHtml(name)} (${count} tareas)</option>`;
      });
      optionsHtml += '</optgroup>';
    }

    if (sortedTags.length > 0) {
      optionsHtml += '<optgroup label="Etiquetas / Áreas">';
      sortedTags.forEach(tag => {
        const count = tagsMap.get(tag);
        const sel = (currentVal === tag) ? ' selected' : '';
        optionsHtml += `<option value="${escapeHtml(tag)}"${sel}>🏷️ ${escapeHtml(tag)} (${count} tareas)</option>`;
      });
      optionsHtml += '</optgroup>';
    }

    select.innerHTML = optionsHtml;
    select.value = currentVal;

    // If currentVal is no longer in options for active tab, reset filter
    if (currentVal && !assigneesMap.has(currentVal) && !tagsMap.has(currentVal)) {
      state.hubsResponsableFilter = '';
      select.value = '';
    }

    select.classList.toggle('active-filter', !!state.hubsResponsableFilter);
    if (clearBtn) {
      clearBtn.style.display = state.hubsResponsableFilter ? 'inline-flex' : 'none';
    }
  }

  /* Populate Responsables dropdown for ENLACES view */
  function populateEnlacesResponsablesSelect(baseEnlacesList) {
    const select = document.getElementById('enlaces-responsable-select');
    const clearBtn = document.getElementById('btn-clear-enlaces-responsable-filter');
    if (!select) return;

    // Collect unique assignees and tags with task counts
    const assigneesMap = new Map();
    const tagsMap = new Map();

    baseEnlacesList.forEach(enlace => {
      enlace.tasks.forEach(task => {
        task.assignees.forEach(a => {
          const trimmed = (a || '').trim();
          if (trimmed && trimmed.toLowerCase() !== 'nan') {
            assigneesMap.set(trimmed, (assigneesMap.get(trimmed) || 0) + 1);
          }
        });
        task.tags.forEach(tg => {
          const trimmed = (tg || '').trim();
          if (trimmed && trimmed.toLowerCase() !== 'nan') {
            tagsMap.set(trimmed, (tagsMap.get(trimmed) || 0) + 1);
          }
        });
      });
    });

    const currentVal = state.enlacesResponsableFilter;
    const sortedAssignees = Array.from(assigneesMap.keys()).sort((a, b) => a.localeCompare(b));
    const sortedTags = Array.from(tagsMap.keys()).sort((a, b) => a.localeCompare(b));

    let optionsHtml = '<option value="">👤 Todos los Responsables</option>';

    if (sortedAssignees.length > 0) {
      optionsHtml += '<optgroup label="Personas / Asignados">';
      sortedAssignees.forEach(name => {
        const count = assigneesMap.get(name);
        const sel = (currentVal === name) ? ' selected' : '';
        optionsHtml += `<option value="${escapeHtml(name)}"${sel}>👤 ${escapeHtml(name)} (${count} tareas)</option>`;
      });
      optionsHtml += '</optgroup>';
    }

    if (sortedTags.length > 0) {
      optionsHtml += '<optgroup label="Etiquetas / Áreas">';
      sortedTags.forEach(tag => {
        const count = tagsMap.get(tag);
        const sel = (currentVal === tag) ? ' selected' : '';
        optionsHtml += `<option value="${escapeHtml(tag)}"${sel}>🏷️ ${escapeHtml(tag)} (${count} tareas)</option>`;
      });
      optionsHtml += '</optgroup>';
    }

    select.innerHTML = optionsHtml;
    select.value = currentVal;

    // If currentVal is no longer in options for active tab, reset filter
    if (currentVal && !assigneesMap.has(currentVal) && !tagsMap.has(currentVal)) {
      state.enlacesResponsableFilter = '';
      select.value = '';
    }

    select.classList.toggle('active-filter', !!state.enlacesResponsableFilter);
    if (clearBtn) {
      clearBtn.style.display = state.enlacesResponsableFilter ? 'inline-flex' : 'none';
    }
  }

  /* 2. HUBS View (Formatted like hubs.pdf + Filtrable por Tareas & Responsable) */
  function renderHubsView() {
    let baseHubsList = [];
    if (state.hubsTab === 'nuevos') {
      baseHubsList = state.processed.hubsNuevos;
    } else if (state.hubsTab === 'operaciones') {
      baseHubsList = state.processed.hubsOperaciones;
    } else {
      baseHubsList = state.processed.hubsAll;
    }

    // Update tab counts
    const hubsTabAllEl = document.getElementById('hubs-tab-count-consolidado');
    if (hubsTabAllEl) hubsTabAllEl.textContent = state.processed.hubsAll.length;
    const hubsTabNuevosEl = document.getElementById('hubs-tab-count-nuevos');
    if (hubsTabNuevosEl) hubsTabNuevosEl.textContent = state.processed.hubsNuevos.length;
    const hubsTabOpsEl = document.getElementById('hubs-tab-count-operaciones');
    if (hubsTabOpsEl) hubsTabOpsEl.textContent = state.processed.hubsOperaciones.length;

    // Populate or sync Responsables select options with active tab
    populateHubsResponsablesSelect(baseHubsList);

    // Tasks summary for active hubs (calculated from baseHubsList before task status filtering, respecting responsable filter)
    let noIniciadasOnTime = 0, noIniciadasLate = 0;
    let enCursoOnTime = 0, enCursoLate = 0;
    let completadas = 0, totalTasks = 0;

    baseHubsList.forEach(h => {
      let tasksForKpi = h.tasks;
      if (state.hubsResponsableFilter) {
        const respLower = state.hubsResponsableFilter.toLowerCase();
        tasksForKpi = tasksForKpi.filter(t => 
          t.assignees.some(a => a.toLowerCase() === respLower) ||
          t.tags.some(tg => tg.toLowerCase() === respLower)
        );
      }
      tasksForKpi.forEach(t => {
        totalTasks++;
        const st = (t.status || '').toLowerCase().trim();
        if (st === 'completado') {
          completadas++;
        } else if (st === 'en curso') {
          if (t.delayed) enCursoLate++;
          else enCursoOnTime++;
        } else {
          if (t.delayed) noIniciadasLate++;
          else noIniciadasOnTime++;
        }
      });
    });

    const enCursoTotal = enCursoOnTime + enCursoLate;
    const noIniciadasTotal = noIniciadasOnTime + noIniciadasLate;

    const elHubsTotal = document.getElementById('hubs-kpi-total');
    if (elHubsTotal) elHubsTotal.textContent = totalTasks;
    const elHubsComp = document.getElementById('hubs-kpi-completadas');
    if (elHubsComp) elHubsComp.textContent = completadas;
    const elHubsCursoTotal = document.getElementById('hubs-kpi-en-curso-total');
    if (elHubsCursoTotal) elHubsCursoTotal.textContent = enCursoTotal;
    const elHubsCursoOntime = document.getElementById('hubs-kpi-en-curso-ontime');
    if (elHubsCursoOntime) elHubsCursoOntime.textContent = enCursoOnTime;
    const elHubsCursoLate = document.getElementById('hubs-kpi-en-curso-late');
    if (elHubsCursoLate) elHubsCursoLate.textContent = enCursoLate;
    const elHubsNoIniTotal = document.getElementById('hubs-kpi-no-iniciadas-total');
    if (elHubsNoIniTotal) elHubsNoIniTotal.textContent = noIniciadasTotal;
    const elHubsNoIniOntime = document.getElementById('hubs-kpi-no-iniciadas-ontime');
    if (elHubsNoIniOntime) elHubsNoIniOntime.textContent = noIniciadasOnTime;
    const elHubsNoIniLate = document.getElementById('hubs-kpi-no-iniciadas-late');
    if (elHubsNoIniLate) elHubsNoIniLate.textContent = noIniciadasLate;

    // Visual active state on KPI filter buttons & sub-cols
    const kpiBtns = {
      total: document.getElementById('kpi-btn-hubs-total'),
      completadas: document.getElementById('kpi-btn-hubs-completadas'),
      en_curso: document.getElementById('kpi-btn-hubs-en-curso'),
      en_curso_ontime: document.getElementById('kpi-btn-hubs-en-curso-ontime'),
      en_curso_late: document.getElementById('kpi-btn-hubs-en-curso-late'),
      no_iniciadas: document.getElementById('kpi-btn-hubs-no-iniciadas'),
      no_iniciadas_ontime: document.getElementById('kpi-btn-hubs-no-iniciadas-ontime'),
      no_iniciadas_late: document.getElementById('kpi-btn-hubs-no-iniciadas-late')
    };
    Object.entries(kpiBtns).forEach(([key, el]) => {
      if (el) el.classList.toggle('active', state.hubsTaskFilter === key);
    });
    const cardHubsCurso = document.getElementById('kpi-card-hubs-en-curso');
    if (cardHubsCurso) {
      cardHubsCurso.classList.toggle('active', !!(state.hubsTaskFilter && state.hubsTaskFilter.startsWith('en_curso')));
    }
    const cardHubsNoIni = document.getElementById('kpi-card-hubs-no-iniciadas');
    if (cardHubsNoIni) {
      cardHubsNoIni.classList.toggle('active', !!(state.hubsTaskFilter && state.hubsTaskFilter.startsWith('no_iniciadas')));
    }

    // Active filter banner & clear button
    const clearBtnTop = document.getElementById('btn-clear-hubs-filter');
    const filterIndicator = document.getElementById('hubs-active-filter-indicator');
    const filterLabel = document.getElementById('hubs-active-filter-label');
    const matchingCountElem = document.getElementById('hubs-matching-count');

    const filterLabels = {
      total: 'Todas las Tareas',
      completadas: 'Completadas',
      en_curso: 'En Curso (Todas)',
      en_curso_ontime: 'En Curso (A Tiempo)',
      en_curso_late: 'En Curso (Retrasadas)',
      no_iniciadas: 'No Iniciadas (Todas)',
      no_iniciadas_ontime: 'No Iniciadas (A Tiempo)',
      no_iniciadas_late: 'No Iniciadas (Retrasadas)',
      retrasadas: 'Retrasadas'
    };

    const hasAnyFilter = !!(state.hubsTaskFilter || state.hubsResponsableFilter || state.searchQuery.trim());

    if (hasAnyFilter) {
      if (clearBtnTop) clearBtnTop.style.display = 'inline-flex';
      if (filterIndicator) {
        filterIndicator.style.display = 'flex';
        const parts = [];
        if (state.hubsTaskFilter) parts.push(`Tareas: ${filterLabels[state.hubsTaskFilter] || state.hubsTaskFilter}`);
        if (state.hubsResponsableFilter) parts.push(`Responsable: ${state.hubsResponsableFilter}`);
        if (state.searchQuery.trim()) parts.push(`Búsqueda: "${state.searchQuery.trim()}"`);
        if (filterLabel) filterLabel.textContent = parts.join(' • ');
      }
    } else {
      if (clearBtnTop) clearBtnTop.style.display = 'none';
      if (filterIndicator) filterIndicator.style.display = 'none';
    }

    // Filter hubs and tasks
    const query = state.searchQuery.trim().toLowerCase();
    const filteredHubs = [];

    baseHubsList.forEach(hub => {
      let matchingTasks = hub.tasks;

      // 1. Filter by task status if selected
      if (state.hubsTaskFilter) {
        matchingTasks = matchingTasks.filter(task => {
          const st = (task.status || '').toLowerCase().trim();
          if (state.hubsTaskFilter === 'total') return true;
          if (state.hubsTaskFilter === 'completadas') return st === 'completado';
          if (state.hubsTaskFilter === 'en_curso') return st === 'en curso';
          if (state.hubsTaskFilter === 'en_curso_ontime') return st === 'en curso' && !task.delayed;
          if (state.hubsTaskFilter === 'en_curso_late') return st === 'en curso' && task.delayed;
          if (state.hubsTaskFilter === 'no_iniciadas') return st !== 'completado' && st !== 'en curso';
          if (state.hubsTaskFilter === 'no_iniciadas_ontime') return st !== 'completado' && st !== 'en curso' && !task.delayed;
          if (state.hubsTaskFilter === 'no_iniciadas_late') return st !== 'completado' && st !== 'en curso' && task.delayed;
          if (state.hubsTaskFilter === 'retrasadas') return task.delayed === true;
          return true;
        });
      }

      // 2. Filter by Responsable if selected from dropdown
      if (state.hubsResponsableFilter) {
        const respLower = state.hubsResponsableFilter.toLowerCase();
        matchingTasks = matchingTasks.filter(t => 
          t.assignees.some(a => a.toLowerCase() === respLower) ||
          t.tags.some(tg => tg.toLowerCase() === respLower)
        );
      }

      // 3. Search query (text search)
      if (query) {
        const hubMatchesName = hub.name.toLowerCase().includes(query);
        if (!hubMatchesName) {
          matchingTasks = matchingTasks.filter(t => 
            t.name.toLowerCase().includes(query) ||
            t.assignees.some(a => a.toLowerCase().includes(query)) ||
            t.tags.some(tg => tg.toLowerCase().includes(query))
          );
        }
      }

      // Only include HUB if it contains matching tasks
      if (matchingTasks.length > 0) {
        filteredHubs.push({
          ...hub,
          tasksToRender: matchingTasks
        });
      }
    });

    // Requirement 2: en Resumen de Avance por HUB organizarlo en el orden del hub que tenga mas % de avance a menor
    filteredHubs.sort((a, b) => {
      if (b.advance !== a.advance) return b.advance - a.advance;
      return a.name.localeCompare(b.name);
    });

    if (matchingCountElem) {
      matchingCountElem.textContent = filteredHubs.length;
    }

    // Advance Global of currently displayed Hubs
    const hubsAvg = filteredHubs.length > 0 
      ? Math.round(filteredHubs.reduce((acc, h) => acc + h.advance, 0) / filteredHubs.length)
      : 0;

    let filterSuffix = '';
    if (state.hubsTaskFilter || state.hubsResponsableFilter) {
      filterSuffix = ` (${filteredHubs.length} de ${baseHubsList.length})`;
    }
    document.getElementById('hubs-badge-total').textContent = `Total HUBs: ${filteredHubs.length}${filterSuffix}`;
    document.getElementById('hubs-badge-global-advance').textContent = `Avance Global: ${hubsAvg}%`;

    // BOX 1: Mini HUB Cards Grid
    const miniGrid = document.getElementById('hubs-mini-cards-grid');
    miniGrid.innerHTML = '';

    if (filteredHubs.length === 0) {
      miniGrid.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: #64748b; background: #f8fafc; border-radius: 8px;">
          No hay HUBs que contengan tareas con el filtro <strong>${filterLabels[state.hubsTaskFilter] || ''}</strong>.
          <br><br>
          <button class="btn-clear-pill" onclick="window.clearHubsFilter()">✕ Quitar Filtro / Ver Todos los HUBs</button>
        </div>
      `;
    } else {
      filteredHubs.forEach(hub => {
        const card = document.createElement('div');
        card.className = 'hub-mini-card';
        card.title = `Haga clic para ver el detalle de ${hub.name}`;
        
        let barColor = '#00bcd4';
        if (hub.advance >= 75) barColor = '#00bcd4';
        else if (hub.advance >= 50) barColor = '#eab308';
        else if (hub.advance > 0) barColor = '#f97316';
        else barColor = '#cbd5e1';

        card.innerHTML = `
          <div class="hub-mini-title">${escapeHtml(hub.name)}</div>
          <div class="hub-mini-bar-row">
            <div class="hub-mini-progress-track">
              <div class="hub-mini-progress-bar" style="width: ${hub.advance}%; background: ${barColor};"></div>
            </div>
            <div class="hub-mini-percent">${hub.advance}%</div>
          </div>
        `;

        card.addEventListener('click', () => {
          const target = document.getElementById(`hub-detail-${hub.name.replace(/\s+/g, '_')}`);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.style.outline = '3px solid #00bcd4';
            setTimeout(() => { target.style.outline = 'none'; }, 2000);
          }
        });

        miniGrid.appendChild(card);
      });
    }

    // Detailed Hub Cards Section
    const detailsContainer = document.getElementById('hubs-detailed-cards-container');
    detailsContainer.innerHTML = '';

    if (filteredHubs.length === 0) {
      detailsContainer.innerHTML = `
        <div style="padding: 32px; text-align: center; color: #64748b; background: #ffffff; border: 1px dashed #cbd5e1; border-radius: 12px; margin-bottom: 24px;">
          <p style="font-size: 15px; font-weight: 600; color: #1e293b; margin-bottom: 8px;">No se encontraron HUBs con tareas que coincidan con el filtro actual</p>
          <button class="btn-clear-pill" onclick="window.clearHubsFilter()">✕ Quitar Filtro / Ver Todas las Tareas</button>
        </div>
      `;
    } else {
      filteredHubs.forEach(hub => {
        const hubCard = document.createElement('div');
        hubCard.className = 'hub-detailed-card';
        hubCard.id = `hub-detail-${hub.name.replace(/\s+/g, '_')}`;

        let fillGradient = 'linear-gradient(90deg, #00bcd4, #00e5ff)';
        if (hub.advance < 50 && hub.advance > 0) fillGradient = 'linear-gradient(90deg, #f59e0b, #fbbf24)';
        else if (hub.advance === 0) fillGradient = '#475569';

        let rowsHtml = '';
        hub.tasksToRender.forEach(task => {
          const stLower = task.status.toLowerCase();
          let statusClass = 'status-no-iniciado';
          if (stLower === 'completado') statusClass = 'status-completado';
          else if (stLower === 'en curso') statusClass = 'status-en-curso';

          let barColor = '#22c55e';
          if (task.advance < 100 && task.advance >= 50) barColor = '#00bcd4';
          else if (task.advance < 50 && task.advance > 0) barColor = '#f59e0b';
          else if (task.advance === 0) barColor = '#e2e8f0';

          // Badges for assignees and tags
          let respHtml = '';
          if (task.assignees.length > 0) {
            task.assignees.forEach(a => {
              respHtml += `<span class="badge-assignee">👤 ${escapeHtml(a)}</span>`;
            });
          }
          if (task.tags.length > 0) {
            task.tags.forEach(tg => {
              respHtml += `<span class="badge-tag-chip">🏷️ ${escapeHtml(tg)}</span>`;
            });
          }
          if (!respHtml) respHtml = '<span style="color:#94a3b8;">-</span>';

          // Requirement 2: Si en una tarea la fecha de finalizacion es mayor a la fecha planificada poner en color rojo
          const completedDateTd = task.isCompletedLate
            ? `<td><span class="cell-completed-late" title="Finalizada posterior a la fecha planificada">${task.completedDate}</span></td>`
            : `<td>${task.completedDate}</td>`;

          rowsHtml += `
            <tr>
              <td class="task-name-cell">${escapeHtml(task.name)}</td>
              <td>
                <span class="status-pill ${statusClass}">${escapeHtml(task.status)}</span>
                ${task.delayed ? '<br><span class="pill-retrasada">Retrasada</span>' : ''}
              </td>
              <td>
                <div class="table-progress-cell">
                  <div class="table-progress-track">
                    <div class="table-progress-fill" style="width: ${task.advance}%; background: ${barColor};"></div>
                  </div>
                  <div class="table-progress-num">${task.advance}%</div>
                </div>
              </td>
              <td>${task.plannedDate}</td>
              ${completedDateTd}
              <td class="reason-cell">
                <div class="reason-input-wrapper">
                  <textarea 
                    class="reason-edit-textarea" 
                    data-hub="${escapeHtml(hub.name)}" 
                    data-task="${escapeHtml(task.name)}" 
                    placeholder="Escribir razón..." 
                    rows="2"
                    title="Escriba directamente aquí la razón o justificación de esta tarea">${escapeHtml(task.reason && task.reason !== '-' ? task.reason : '')}</textarea>
                  <span class="reason-print-only">${escapeHtml(task.reason || '-')}</span>
                </div>
              </td>
              <td><div class="responsables-cell">${respHtml}</div></td>
            </tr>
          `;
        });

        const filterTaskBadge = state.hubsTaskFilter ? ` &bull; ${hub.tasksToRender.length} de ${hub.tasks.length} tareas` : '';

        hubCard.innerHTML = `
          <div class="hub-card-top-navy">
            <div class="hub-card-name-title">${escapeHtml(hub.name)} <span style="font-size:11px; font-weight:normal; opacity:0.8;">(${hub.category}${filterTaskBadge})</span></div>
            <div class="hub-card-global-progress">
              <span class="hub-card-global-label">Avance Global</span>
              <div class="hub-card-global-track">
                <div class="hub-card-global-fill" style="width: ${hub.advance}%; background: ${fillGradient};"></div>
              </div>
              <span class="hub-card-global-percent">${hub.advance}%</span>
            </div>
          </div>
          <div class="table-responsive">
            <table class="hub-tasks-table">
              <thead>
                <tr>
                  <th>Tarea</th>
                  <th>Estado</th>
                  <th>Avance</th>
                  <th>Planificada</th>
                  <th>Finalización</th>
                  <th>Razón</th>
                  <th>RESPONSABLES</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>
        `;

        detailsContainer.appendChild(hubCard);
      });
    }
  }

  /* 3. ENLACES View (Structured like hubs.pdf + Filtrable por Tareas & Responsable) */
  function renderEnlacesView() {
    let baseEnlacesList = [];
    if (state.enlacesTab === 'nuevos') {
      baseEnlacesList = state.processed.enlacesNuevos;
    } else if (state.enlacesTab === 'operaciones') {
      baseEnlacesList = state.processed.enlacesOperaciones;
    } else {
      baseEnlacesList = state.processed.enlacesAll;
    }

    // Update tab counts
    const enlacesTabAllEl = document.getElementById('enlaces-tab-count-consolidado');
    if (enlacesTabAllEl) enlacesTabAllEl.textContent = state.processed.enlacesAll.length;
    const enlacesTabOpsEl = document.getElementById('enlaces-tab-count-operaciones');
    if (enlacesTabOpsEl) enlacesTabOpsEl.textContent = state.processed.enlacesOperaciones.length;
    const enlacesTabNuevosEl = document.getElementById('enlaces-tab-count-nuevos');
    if (enlacesTabNuevosEl) enlacesTabNuevosEl.textContent = state.processed.enlacesNuevos.length;

    // Populate or sync Responsables select options with active tab
    populateEnlacesResponsablesSelect(baseEnlacesList);

    // Tasks summary for active enlaces (calculated from baseEnlacesList before task status filtering, respecting responsable filter)
    let noIniciadasOnTime = 0, noIniciadasLate = 0;
    let enCursoOnTime = 0, enCursoLate = 0;
    let completadas = 0, totalTasks = 0;

    baseEnlacesList.forEach(e => {
      let tasksForKpi = e.tasks;
      if (state.enlacesResponsableFilter) {
        const respLower = state.enlacesResponsableFilter.toLowerCase();
        tasksForKpi = tasksForKpi.filter(t => 
          t.assignees.some(a => a.toLowerCase() === respLower) ||
          t.tags.some(tg => tg.toLowerCase() === respLower)
        );
      }
      tasksForKpi.forEach(t => {
        totalTasks++;
        const st = (t.status || '').toLowerCase().trim();
        if (st === 'completado') {
          completadas++;
        } else if (st === 'en curso') {
          if (t.delayed) enCursoLate++;
          else enCursoOnTime++;
        } else {
          if (t.delayed) noIniciadasLate++;
          else noIniciadasOnTime++;
        }
      });
    });

    const enCursoTotal = enCursoOnTime + enCursoLate;
    const noIniciadasTotal = noIniciadasOnTime + noIniciadasLate;

    const elEnlacesTotal = document.getElementById('enlaces-kpi-total');
    if (elEnlacesTotal) elEnlacesTotal.textContent = totalTasks;
    const elEnlacesComp = document.getElementById('enlaces-kpi-completadas');
    if (elEnlacesComp) elEnlacesComp.textContent = completadas;
    const elEnlacesCursoTotal = document.getElementById('enlaces-kpi-en-curso-total');
    if (elEnlacesCursoTotal) elEnlacesCursoTotal.textContent = enCursoTotal;
    const elEnlacesCursoOntime = document.getElementById('enlaces-kpi-en-curso-ontime');
    if (elEnlacesCursoOntime) elEnlacesCursoOntime.textContent = enCursoOnTime;
    const elEnlacesCursoLate = document.getElementById('enlaces-kpi-en-curso-late');
    if (elEnlacesCursoLate) elEnlacesCursoLate.textContent = enCursoLate;
    const elEnlacesNoIniTotal = document.getElementById('enlaces-kpi-no-iniciadas-total');
    if (elEnlacesNoIniTotal) elEnlacesNoIniTotal.textContent = noIniciadasTotal;
    const elEnlacesNoIniOntime = document.getElementById('enlaces-kpi-no-iniciadas-ontime');
    if (elEnlacesNoIniOntime) elEnlacesNoIniOntime.textContent = noIniciadasOnTime;
    const elEnlacesNoIniLate = document.getElementById('enlaces-kpi-no-iniciadas-late');
    if (elEnlacesNoIniLate) elEnlacesNoIniLate.textContent = noIniciadasLate;

    // Active state on KPI buttons & sub-cols
    const kpiBtns = {
      total: document.getElementById('kpi-btn-enlaces-total'),
      completadas: document.getElementById('kpi-btn-enlaces-completadas'),
      en_curso: document.getElementById('kpi-btn-enlaces-en-curso'),
      en_curso_ontime: document.getElementById('kpi-btn-enlaces-en-curso-ontime'),
      en_curso_late: document.getElementById('kpi-btn-enlaces-en-curso-late'),
      no_iniciadas: document.getElementById('kpi-btn-enlaces-no-iniciadas'),
      no_iniciadas_ontime: document.getElementById('kpi-btn-enlaces-no-iniciadas-ontime'),
      no_iniciadas_late: document.getElementById('kpi-btn-enlaces-no-iniciadas-late')
    };
    Object.entries(kpiBtns).forEach(([key, el]) => {
      if (el) el.classList.toggle('active', state.enlacesTaskFilter === key);
    });
    const cardEnlacesCurso = document.getElementById('kpi-card-enlaces-en-curso');
    if (cardEnlacesCurso) {
      cardEnlacesCurso.classList.toggle('active', !!(state.enlacesTaskFilter && state.enlacesTaskFilter.startsWith('en_curso')));
    }
    const cardEnlacesNoIni = document.getElementById('kpi-card-enlaces-no-iniciadas');
    if (cardEnlacesNoIni) {
      cardEnlacesNoIni.classList.toggle('active', !!(state.enlacesTaskFilter && state.enlacesTaskFilter.startsWith('no_iniciadas')));
    }

    const clearBtnTop = document.getElementById('btn-clear-enlaces-filter');
    const filterIndicator = document.getElementById('enlaces-active-filter-indicator');
    const filterLabel = document.getElementById('enlaces-active-filter-label');
    const matchingCountElem = document.getElementById('enlaces-matching-count');

    const filterLabels = {
      total: 'Todas las Tareas',
      completadas: 'Completadas',
      en_curso: 'En Curso (Todas)',
      en_curso_ontime: 'En Curso (A Tiempo)',
      en_curso_late: 'En Curso (Retrasadas)',
      no_iniciadas: 'No Iniciadas (Todas)',
      no_iniciadas_ontime: 'No Iniciadas (A Tiempo)',
      no_iniciadas_late: 'No Iniciadas (Retrasadas)',
      retrasadas: 'Retrasadas'
    };

    if (state.enlacesTaskFilter || state.enlacesResponsableFilter) {
      if (clearBtnTop) clearBtnTop.style.display = 'inline-flex';
      if (filterIndicator) {
        filterIndicator.style.display = 'flex';
        const parts = [];
        if (state.enlacesTaskFilter) parts.push(`Tareas: ${filterLabels[state.enlacesTaskFilter] || state.enlacesTaskFilter}`);
        if (state.enlacesResponsableFilter) parts.push(`Responsable: "${state.enlacesResponsableFilter}"`);
        if (filterLabel) filterLabel.textContent = parts.join(' & ');
      }
    } else {
      if (clearBtnTop) clearBtnTop.style.display = 'none';
      if (filterIndicator) filterIndicator.style.display = 'none';
    }

    const query = state.searchQuery.trim().toLowerCase();
    const filteredEnlaces = [];

    baseEnlacesList.forEach(enlace => {
      let matchingTasks = enlace.tasks;

      // Filter by task status / delayed
      if (state.enlacesTaskFilter) {
        matchingTasks = matchingTasks.filter(task => {
          const st = (task.status || '').toLowerCase().trim();
          if (state.enlacesTaskFilter === 'total') return true;
          if (state.enlacesTaskFilter === 'completadas') return st === 'completado';
          if (state.enlacesTaskFilter === 'en_curso') return st === 'en curso';
          if (state.enlacesTaskFilter === 'en_curso_ontime') return st === 'en curso' && !task.delayed;
          if (state.enlacesTaskFilter === 'en_curso_late') return st === 'en curso' && task.delayed;
          if (state.enlacesTaskFilter === 'no_iniciadas') return st !== 'completado' && st !== 'en curso';
          if (state.enlacesTaskFilter === 'no_iniciadas_ontime') return st !== 'completado' && st !== 'en curso' && !task.delayed;
          if (state.enlacesTaskFilter === 'no_iniciadas_late') return st !== 'completado' && st !== 'en curso' && task.delayed;
          if (state.enlacesTaskFilter === 'retrasadas') return task.delayed === true;
          return true;
        });
      }

      // Filter by Responsables dropdown selection
      if (state.enlacesResponsableFilter) {
        const respLower = state.enlacesResponsableFilter.toLowerCase();
        matchingTasks = matchingTasks.filter(t => 
          t.assignees.some(a => a.toLowerCase() === respLower) ||
          t.tags.some(tg => tg.toLowerCase() === respLower)
        );
      }

      // Search input query
      if (query) {
        const enlaceMatchesName = enlace.name.toLowerCase().includes(query);
        if (!enlaceMatchesName) {
          matchingTasks = matchingTasks.filter(t => 
            t.name.toLowerCase().includes(query) ||
            t.assignees.some(a => a.toLowerCase().includes(query)) ||
            t.tags.some(tg => tg.toLowerCase().includes(query))
          );
        }
      }

      if (matchingTasks.length > 0) {
        filteredEnlaces.push({
          ...enlace,
          tasksToRender: matchingTasks
        });
      }
    });

    if (matchingCountElem) {
      matchingCountElem.textContent = filteredEnlaces.length;
    }

    const enlacesAvg = filteredEnlaces.length > 0
      ? Math.round(filteredEnlaces.reduce((acc, e) => acc + e.advance, 0) / filteredEnlaces.length)
      : 0;

    let filterSuffix = '';
    if (state.enlacesTaskFilter || state.enlacesResponsableFilter) {
      filterSuffix = ` (${filteredEnlaces.length} de ${baseEnlacesList.length})`;
    }
    document.getElementById('enlaces-badge-total').textContent = `Total Enlaces: ${filteredEnlaces.length}${filterSuffix}`;
    document.getElementById('enlaces-badge-global-advance').textContent = `Avance Global: ${enlacesAvg}%`;

    // BOX 1: Mini Enlaces Cards Grid
    const miniGrid = document.getElementById('enlaces-mini-cards-grid');
    miniGrid.innerHTML = '';

    if (filteredEnlaces.length === 0) {
      const activeFilterMsg = state.enlacesResponsableFilter
        ? `el responsable <strong>"${escapeHtml(state.enlacesResponsableFilter)}"</strong>`
        : `el filtro <strong>${filterLabels[state.enlacesTaskFilter] || ''}</strong>`;
      miniGrid.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: #64748b; background: #f8fafc; border-radius: 8px;">
          No hay enlaces que contengan tareas con ${activeFilterMsg}.
          <br><br>
          <button class="btn-clear-pill" onclick="window.clearEnlacesFilter()">✕ Quitar Filtro / Ver Todos los Enlaces</button>
        </div>
      `;
    } else {
      filteredEnlaces.forEach(enlace => {
        const card = document.createElement('div');
        card.className = 'hub-mini-card';
        card.title = `Haga clic para ver el detalle de ${enlace.name}`;

        let barColor = '#0284c7';
        if (enlace.advance >= 75) barColor = '#22c55e';
        else if (enlace.advance >= 50) barColor = '#0284c7';
        else if (enlace.advance > 0) barColor = '#f59e0b';
        else barColor = '#cbd5e1';

        card.innerHTML = `
          <div class="hub-mini-title">${escapeHtml(enlace.name)}</div>
          <div class="hub-mini-bar-row">
            <div class="hub-mini-progress-track">
              <div class="hub-mini-progress-bar" style="width: ${enlace.advance}%; background: ${barColor};"></div>
            </div>
            <div class="hub-mini-percent">${enlace.advance}%</div>
          </div>
        `;

        card.addEventListener('click', () => {
          const target = document.getElementById(`enlace-detail-${enlace.name.replace(/\s+/g, '_')}`);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.style.outline = '3px solid #0284c7';
            setTimeout(() => { target.style.outline = 'none'; }, 2000);
          }
        });

        miniGrid.appendChild(card);
      });
    }

    // Detailed Enlace Cards
    const detailsContainer = document.getElementById('enlaces-detailed-cards-container');
    detailsContainer.innerHTML = '';

    if (filteredEnlaces.length === 0) {
      detailsContainer.innerHTML = `
        <div style="padding: 32px; text-align: center; color: #64748b; background: #ffffff; border: 1px dashed #cbd5e1; border-radius: 12px; margin-bottom: 24px;">
          <p style="font-size: 15px; font-weight: 600; color: #1e293b; margin-bottom: 8px;">No se encontraron enlaces con tareas que coincidan con el filtro actual</p>
          <button class="btn-clear-pill" onclick="window.clearEnlacesFilter()">✕ Quitar Filtro / Ver Todas las Tareas</button>
        </div>
      `;
    } else {
      filteredEnlaces.forEach(enlace => {
        const enlaceCard = document.createElement('div');
        enlaceCard.className = 'hub-detailed-card';
        enlaceCard.id = `enlace-detail-${enlace.name.replace(/\s+/g, '_')}`;

        let fillGradient = 'linear-gradient(90deg, #0284c7, #38bdf8)';
        if (enlace.advance === 100) fillGradient = 'linear-gradient(90deg, #10b981, #34d399)';
        else if (enlace.advance === 0) fillGradient = '#475569';

        let rowsHtml = '';
        enlace.tasksToRender.forEach(task => {
          const stLower = task.status.toLowerCase();
          let statusClass = 'status-no-iniciado';
          if (stLower === 'completado') statusClass = 'status-completado';
          else if (stLower === 'en curso') statusClass = 'status-en-curso';

          let barColor = '#22c55e';
          if (task.advance < 100 && task.advance >= 50) barColor = '#0284c7';
          else if (task.advance < 50 && task.advance > 0) barColor = '#f59e0b';
          else if (task.advance === 0) barColor = '#e2e8f0';

          let respHtml = '';
          if (task.assignees.length > 0) {
            task.assignees.forEach(a => {
              respHtml += `<span class="badge-assignee">👤 ${escapeHtml(a)}</span>`;
            });
          }
          if (task.tags.length > 0) {
            task.tags.forEach(tg => {
              respHtml += `<span class="badge-tag-chip">🏷️ ${escapeHtml(tg)}</span>`;
            });
          }
          if (!respHtml) respHtml = '<span style="color:#94a3b8;">-</span>';

          const completedDateTd = task.isCompletedLate
            ? `<td><span class="cell-completed-late" title="Finalizada posterior a la fecha planificada">${task.completedDate}</span></td>`
            : `<td>${task.completedDate}</td>`;

          rowsHtml += `
            <tr>
              <td class="task-name-cell">${escapeHtml(task.name)}</td>
              <td>
                <span class="status-pill ${statusClass}">${escapeHtml(task.status)}</span>
                ${task.delayed ? '<br><span class="pill-retrasada">Retrasada</span>' : ''}
              </td>
              <td>
                <div class="table-progress-cell">
                  <div class="table-progress-track">
                    <div class="table-progress-fill" style="width: ${task.advance}%; background: ${barColor};"></div>
                  </div>
                  <div class="table-progress-num">${task.advance}%</div>
                </div>
              </td>
              <td>${task.plannedDate}</td>
              ${completedDateTd}
              <td class="reason-cell">
                <div class="reason-input-wrapper">
                  <textarea 
                    class="reason-edit-textarea" 
                    data-hub="${escapeHtml(enlace.name)}" 
                    data-task="${escapeHtml(task.name)}" 
                    placeholder="Escribir razón..." 
                    rows="2"
                    title="Escriba directamente aquí la razón o justificación de esta tarea">${escapeHtml(task.reason && task.reason !== '-' ? task.reason : '')}</textarea>
                  <span class="reason-print-only">${escapeHtml(task.reason || '-')}</span>
                </div>
              </td>
              <td><div class="responsables-cell">${respHtml}</div></td>
            </tr>
          `;
        });

        const filterTaskBadge = (state.enlacesTaskFilter || state.enlacesResponsableFilter) ? ` &bull; ${enlace.tasksToRender.length} de ${enlace.tasks.length} tareas` : '';

        enlaceCard.innerHTML = `
          <div class="hub-card-top-navy" style="background: #112d4e;">
            <div class="hub-card-name-title">${escapeHtml(enlace.name)} <span style="font-size:11px; font-weight:normal; opacity:0.8;">(${enlace.category}${filterTaskBadge})</span></div>
            <div class="hub-card-global-progress">
              <span class="hub-card-global-label">Avance Global</span>
              <div class="hub-card-global-track">
                <div class="hub-card-global-fill" style="width: ${enlace.advance}%; background: ${fillGradient};"></div>
              </div>
              <span class="hub-card-global-percent">${enlace.advance}%</span>
            </div>
          </div>
          <div class="table-responsive">
            <table class="hub-tasks-table">
              <thead>
                <tr>
                  <th>Tarea</th>
                  <th>Estado</th>
                  <th>Avance</th>
                  <th>Planificada</th>
                  <th>Finalización</th>
                  <th>Razón</th>
                  <th>RESPONSABLES</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>
        `;

        detailsContainer.appendChild(enlaceCard);
      });
    }
  }

  /* Populate Responsables dropdown for NOC view */
  function populateNocResponsablesSelect(tasks) {
    const select = document.getElementById('noc-responsable-select');
    const clearBtn = document.getElementById('btn-clear-noc-responsable-filter');
    if (!select) return;

    const assigneesMap = new Map();
    const tagsMap = new Map();

    tasks.forEach(task => {
      task.assignees.forEach(a => {
        const trimmed = (a || '').trim();
        if (trimmed && trimmed.toLowerCase() !== 'nan') {
          assigneesMap.set(trimmed, (assigneesMap.get(trimmed) || 0) + 1);
        }
      });
      task.tags.forEach(tg => {
        const trimmed = (tg || '').trim();
        if (trimmed && trimmed.toLowerCase() !== 'nan') {
          tagsMap.set(trimmed, (tagsMap.get(trimmed) || 0) + 1);
        }
      });
    });

    const currentVal = state.nocResponsableFilter || '';
    let optionsHtml = '<option value="">👥 Todos los Responsables</option>';

    const sortedAssignees = Array.from(assigneesMap.keys()).sort((a, b) => a.localeCompare(b, 'es'));
    const sortedTags = Array.from(tagsMap.keys()).sort((a, b) => a.localeCompare(b, 'es'));

    if (sortedAssignees.length > 0) {
      optionsHtml += '<optgroup label="Asignados a">';
      sortedAssignees.forEach(name => {
        const count = assigneesMap.get(name);
        const sel = (currentVal === name) ? ' selected' : '';
        optionsHtml += `<option value="${escapeHtml(name)}"${sel}>👤 ${escapeHtml(name)} (${count} tareas)</option>`;
      });
      optionsHtml += '</optgroup>';
    }

    if (sortedTags.length > 0) {
      optionsHtml += '<optgroup label="Etiquetas / Departamentos">';
      sortedTags.forEach(tag => {
        const count = tagsMap.get(tag);
        const sel = (currentVal === tag) ? ' selected' : '';
        optionsHtml += `<option value="${escapeHtml(tag)}"${sel}>🏷️ ${escapeHtml(tag)} (${count} tareas)</option>`;
      });
      optionsHtml += '</optgroup>';
    }

    select.innerHTML = optionsHtml;
    select.value = currentVal;

    if (currentVal && !assigneesMap.has(currentVal) && !tagsMap.has(currentVal)) {
      state.nocResponsableFilter = '';
      select.value = '';
    }

    select.classList.toggle('active-filter', !!state.nocResponsableFilter);
    if (clearBtn) {
      clearBtn.style.display = state.nocResponsableFilter ? 'inline-flex' : 'none';
    }
  }

  /* Helper to get planned timestamp for chronological priority sorting (nearest date first) */
  function getTaskPlannedTimestamp(task) {
    if (!task) return Infinity;
    const dStr = task.plannedDate;
    if (!dStr || dStr === '-' || dStr === 'nan' || dStr === 'NaN') return Infinity;
    const parts = dStr.split('/');
    if (parts.length === 3) {
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const year = parseInt(parts[2], 10);
      const dt = new Date(year, month, day);
      if (!isNaN(dt.getTime())) return dt.getTime();
    }
    return Infinity;
  }

  /* 4. NOC View (Structured like hubs.pdf/noc.pdf + Filtrable por Tareas & Responsable) */
  function renderNocView() {
    let allNocTasks = state.processed.noc || [];

    // Header advance percentage badge (matches Avance Global NOC in Vista General)
    const nocAdvBadge = document.getElementById('noc-badge-global-advance');
    if (nocAdvBadge && state.metrics) {
      nocAdvBadge.textContent = `Avance Global: ${state.metrics.nocAdv}%`;
    }

    // Populate or sync Responsables select options with NOC tasks
    populateNocResponsablesSelect(allNocTasks);

    // Apply department filter
    if (state.nocDeptFilter) {
      allNocTasks = allNocTasks.filter(t => t.department === state.nocDeptFilter);
      document.getElementById('noc-active-filter-container').style.display = 'block';
      document.getElementById('noc-filter-name-text').textContent = state.nocDeptFilter;
    } else {
      document.getElementById('noc-active-filter-container').style.display = 'none';
    }

    // Apply responsable filter
    if (state.nocResponsableFilter) {
      const respLower = state.nocResponsableFilter.toLowerCase();
      allNocTasks = allNocTasks.filter(t => 
        t.assignees.some(a => a.toLowerCase() === respLower) ||
        t.tags.some(tg => tg.toLowerCase() === respLower)
      );
    }

    // Apply search filter if any
    const query = state.searchQuery.trim().toLowerCase();
    if (query) {
      allNocTasks = allNocTasks.filter(t => 
        t.name.toLowerCase().includes(query) ||
        t.department.toLowerCase().includes(query) ||
        t.assignees.some(a => a.toLowerCase().includes(query)) ||
        t.tags.some(tg => tg.toLowerCase().includes(query))
      );
    }

    // Top 4 KPIs for NOC (Respecting active filters)
    const totalCount = allNocTasks.length;
    const completadas = allNocTasks.filter(t => (t.status || '').toLowerCase().trim() === 'completado');
    const enCurso = allNocTasks.filter(t => (t.status || '').toLowerCase().trim() === 'en curso');
    const enCursoOntime = enCurso.filter(t => !t.delayed);
    const enCursoLate = enCurso.filter(t => t.delayed);
    const noIniciadas = allNocTasks.filter(t => {
      const s = (t.status || '').toLowerCase().trim();
      return s !== 'completado' && s !== 'en curso';
    });
    const noIniciadasOntime = noIniciadas.filter(t => !t.delayed);
    const noIniciadasLate = noIniciadas.filter(t => t.delayed);
    const retrasadas = allNocTasks.filter(t => t.delayed);

    const elNocTotal = document.getElementById('noc-kpi-total-val');
    if (elNocTotal) elNocTotal.textContent = totalCount;
    const elNocDone = document.getElementById('noc-kpi-done-val');
    if (elNocDone) elNocDone.textContent = completadas.length;
    const elNocCursoTotal = document.getElementById('noc-kpi-curso-total');
    if (elNocCursoTotal) elNocCursoTotal.textContent = enCurso.length;
    const elNocCursoOntime = document.getElementById('noc-kpi-curso-ontime');
    if (elNocCursoOntime) elNocCursoOntime.textContent = enCursoOntime.length;
    const elNocCursoLate = document.getElementById('noc-kpi-curso-late');
    if (elNocCursoLate) elNocCursoLate.textContent = enCursoLate.length;
    const elNocNotStartedTotal = document.getElementById('noc-kpi-notstarted-total');
    if (elNocNotStartedTotal) elNocNotStartedTotal.textContent = noIniciadas.length;
    const elNocNotStartedOntime = document.getElementById('noc-kpi-notstarted-ontime');
    if (elNocNotStartedOntime) elNocNotStartedOntime.textContent = noIniciadasOntime.length;
    const elNocNotStartedLate = document.getElementById('noc-kpi-notstarted-late');
    if (elNocNotStartedLate) elNocNotStartedLate.textContent = noIniciadasLate.length;

    const countAllNocEl = document.getElementById('noc-tab-count-all');
    if (countAllNocEl) countAllNocEl.textContent = state.processed.noc.length;

    // Visual active state on KPI filter buttons
    const nocKpiBtns = {
      total: document.getElementById('kpi-btn-noc-total'),
      completadas: document.getElementById('kpi-btn-noc-completadas'),
      en_curso: document.getElementById('kpi-btn-noc-en-curso'),
      en_curso_ontime: document.getElementById('kpi-btn-noc-en-curso-ontime'),
      en_curso_late: document.getElementById('kpi-btn-noc-en-curso-late'),
      no_iniciadas: document.getElementById('kpi-btn-noc-no-iniciadas'),
      no_iniciadas_ontime: document.getElementById('kpi-btn-noc-no-iniciadas-ontime'),
      no_iniciadas_late: document.getElementById('kpi-btn-noc-no-iniciadas-late')
    };
    Object.entries(nocKpiBtns).forEach(([key, el]) => {
      if (el) el.classList.toggle('filter-active', state.nocTaskFilter === key);
    });
    const cardNocCurso = document.getElementById('kpi-card-noc-en-curso');
    if (cardNocCurso) {
      cardNocCurso.classList.toggle('filter-active', !!(state.nocTaskFilter && state.nocTaskFilter.startsWith('en_curso')));
    }
    const cardNocNoIni = document.getElementById('kpi-card-noc-no-iniciadas');
    if (cardNocNoIni) {
      cardNocNoIni.classList.toggle('filter-active', !!(state.nocTaskFilter && state.nocTaskFilter.startsWith('no_iniciadas')));
    }

    // Task Filter Banner
    const taskBanner = document.getElementById('noc-active-task-filter-indicator');
    const taskBannerLabel = document.getElementById('noc-active-task-filter-label');
    const taskMatchingCount = document.getElementById('noc-matching-count');
    if (taskBanner) {
      if (state.nocTaskFilter && state.nocTaskFilter !== 'total') {
        const labelsMap = {
          'completadas': 'Tareas Completadas',
          'en_curso': 'Tareas en Curso (Todas)',
          'en_curso_ontime': 'Tareas en Curso (A Tiempo)',
          'en_curso_late': 'Tareas en Curso (Retrasadas)',
          'no_iniciadas': 'Frentes No Iniciados (Todos)',
          'no_iniciadas_ontime': 'Frentes No Iniciados (A Tiempo)',
          'no_iniciadas_late': 'Frentes No Iniciados (Retrasados)',
          'retrasadas': 'Alertas con Retraso'
        };
        const countsMap = {
          'completadas': completadas.length,
          'en_curso': enCurso.length,
          'en_curso_ontime': enCursoOntime.length,
          'en_curso_late': enCursoLate.length,
          'no_iniciadas': noIniciadas.length,
          'no_iniciadas_ontime': noIniciadasOntime.length,
          'no_iniciadas_late': noIniciadasLate.length,
          'retrasadas': retrasadas.length
        };
        taskBanner.style.display = 'flex';
        taskBannerLabel.textContent = labelsMap[state.nocTaskFilter] || state.nocTaskFilter;
        taskMatchingCount.textContent = countsMap[state.nocTaskFilter] ?? 0;
      } else {
        taskBanner.style.display = 'none';
      }
    }

    // Show/hide subsections according to task filter
    const secComp = document.getElementById('noc-subsection-completed');
    const secProg = document.getElementById('noc-subsection-inprogress');
    const secNotStarted = document.getElementById('noc-subsection-notstarted');
    const secDelayed = document.getElementById('noc-section-delayed');

    if (secComp) secComp.style.display = (!state.nocTaskFilter || state.nocTaskFilter === 'total' || state.nocTaskFilter === 'completadas') ? 'block' : 'none';
    if (secProg) secProg.style.display = (!state.nocTaskFilter || state.nocTaskFilter === 'total' || state.nocTaskFilter.startsWith('en_curso')) ? 'block' : 'none';
    if (secNotStarted) secNotStarted.style.display = (!state.nocTaskFilter || state.nocTaskFilter === 'total' || state.nocTaskFilter.startsWith('no_iniciadas')) ? 'block' : 'none';
    if (secDelayed) secDelayed.style.display = (!state.nocTaskFilter || state.nocTaskFilter === 'total' || state.nocTaskFilter === 'retrasadas' || state.nocTaskFilter === 'en_curso_late' || state.nocTaskFilter === 'no_iniciadas_late') ? 'block' : 'none';

    // SECTION 1: Distribución de Carga por Responsable (Departamento)
    renderNocDistributionTable();

    // Filter tasks if ontime/late sub-filter is active
    let displayEnCurso = [...enCurso];
    if (state.nocTaskFilter === 'en_curso_ontime') displayEnCurso = enCursoOntime;
    else if (state.nocTaskFilter === 'en_curso_late') displayEnCurso = enCursoLate;

    let displayNoIniciadas = [...noIniciadas];
    if (state.nocTaskFilter === 'no_iniciadas_ontime') displayNoIniciadas = noIniciadasOntime;
    else if (state.nocTaskFilter === 'no_iniciadas_late') displayNoIniciadas = noIniciadasLate;

    let displayRetrasadas = [...retrasadas];
    if (state.nocTaskFilter === 'en_curso_late') displayRetrasadas = enCursoLate;
    else if (state.nocTaskFilter === 'no_iniciadas_late') displayRetrasadas = noIniciadasLate;

    // Sort tasks from nearest date to farthest date for 2.2, 2.3, and 3 (priorities at top)
    const sortedEnCurso = displayEnCurso.sort((a, b) => getTaskPlannedTimestamp(a) - getTaskPlannedTimestamp(b));
    const sortedNoIniciadas = displayNoIniciadas.sort((a, b) => getTaskPlannedTimestamp(a) - getTaskPlannedTimestamp(b));
    const sortedRetrasadas = displayRetrasadas.sort((a, b) => getTaskPlannedTimestamp(a) - getTaskPlannedTimestamp(b));

    // SECTION 2: Estado Detallado
    // 2.1 Completadas
    document.getElementById('noc-count-done-badge').textContent = `${completadas.length} elementos`;
    renderNocTableRows('noc-table-completed-body', completadas, true, false);

    // 2.2 En Curso
    document.getElementById('noc-count-prog-badge').textContent = `${sortedEnCurso.length} elementos`;
    renderNocTableRows('noc-table-inprogress-body', sortedEnCurso, false, false);

    // 2.3 No Iniciadas (fechas retrasadas o a vencerse en 3 días en ROJO)
    document.getElementById('noc-count-notstarted-badge').textContent = `${sortedNoIniciadas.length} elementos`;
    renderNocTableRows('noc-table-notstarted-body', sortedNoIniciadas, false, true);

    // SECTION 3: Alertas con Retraso (fechas retrasadas en ROJO, sólo Razón editable)
    document.getElementById('noc-count-delayed-badge').textContent = `${sortedRetrasadas.length} elementos críticos`;
    renderNocTableRows('noc-table-delayed-body', sortedRetrasadas, false, true);

    // Urgent Tasks Chart
    renderNocUrgentChart();

    // SECTION 4: PMO Analysis & Bottlenecks Calculation
    renderNocPmoAnalysis();
  }

  function renderNocDistributionTable() {
    const rawNoc = state.processed.noc;
    const deptMap = {};
    rawNoc.forEach(t => {
      deptMap[t.department] = (deptMap[t.department] || 0) + 1;
    });

    const totalRaw = rawNoc.length || 1;
    const tbody = document.getElementById('noc-distribution-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const sortedDepts = Object.entries(deptMap).sort((a, b) => b[1] - a[1]);

    sortedDepts.forEach(([dept, count]) => {
      const prop = ((count / totalRaw) * 100).toFixed(1);
      const tr = document.createElement('tr');
      tr.className = 'clickable-dept-row';
      if (state.nocDeptFilter === dept) {
        tr.classList.add('dept-row-selected');
      }

      tr.innerHTML = `
        <td class="dept-name-cell">${escapeHtml(dept)}</td>
        <td style="font-weight: 700; width: 120px;">${count}</td>
        <td>
          <div class="dept-bar-cell">
            <div class="dept-bar-track">
              <div class="dept-bar-fill" style="width: ${prop}%;"></div>
            </div>
            <div class="dept-bar-num">${prop}%</div>
          </div>
        </td>
      `;

      tr.addEventListener('click', () => {
        if (state.nocDeptFilter === dept) {
          state.nocDeptFilter = null;
        } else {
          state.nocDeptFilter = dept;
        }
        renderNocView();
      });

      tbody.appendChild(tr);
    });
  }

  function isDateOverdueOrDueSoon(task) {
    if (!task) return false;
    if (!task.plannedDate || task.plannedDate === '-' || task.plannedDate === 'nan') return false;
    if (task.delayed || task.dueSoon) return true;
    const parts = task.plannedDate.split('/');
    if (parts.length === 3) {
      const due = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const diffDays = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return diffDays <= 3;
    }
    return false;
  }

  function renderNocTableRows(containerId, tasks, showCompletionDate, highlightDueSoon) {
    const tbody = document.getElementById(containerId);
    if (!tbody) return;
    tbody.innerHTML = '';

    const colSpan = showCompletionDate ? 7 : 6;
    if (tasks.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align:center; padding: 20px; color: #94a3b8;">No hay tareas que coincidan con el filtro</td></tr>`;
      return;
    }

    tasks.forEach(task => {
      const tr = document.createElement('tr');
      const isRedDate = highlightDueSoon && isDateOverdueOrDueSoon(task);

      let respHtml = '';
      if (task.assignees.length > 0) {
        task.assignees.forEach(a => {
          respHtml += `<span class="badge-assignee">👤 ${escapeHtml(a)}</span> `;
        });
      }
      if (task.tags.length > 0) {
        task.tags.forEach(tg => {
          respHtml += `<span class="badge-tag-chip">🏷️ ${escapeHtml(tg)}</span> `;
        });
      }
      if (!respHtml) respHtml = '<span style="color:#94a3b8;">-</span>';

      const completionTd = showCompletionDate 
        ? (task.isCompletedLate 
            ? `<td><span class="cell-completed-late" title="Finalizada posterior a la fecha planificada">${task.completedDate}</span></td>` 
            : `<td>${task.completedDate}</td>`)
        : '';

      const urgentBadge = task.isUrgent 
        ? `<span class="noc-badge-urgent" style="display:inline-block; margin-left:6px; background:#ffe4e6; color:#b91c1c; border:1px solid #fecdd3; border-radius:4px; padding:1px 6px; font-size:10px; font-weight:700;">🔥 Urgente</span>`
        : '';

      const dateHtml = isRedDate 
        ? `<span class="due-date-alert-red">${task.plannedDate}</span>` 
        : escapeHtml(task.plannedDate);

      tr.innerHTML = `
        <td class="task-name-cell">${escapeHtml(task.name)}${urgentBadge}</td>
        <td>
          <div class="table-progress-cell" style="min-width: 90px;">
            <div class="table-progress-track">
              <div class="table-progress-fill" style="width: ${task.advance}%; background: ${task.advance === 100 ? '#22c55e' : (task.advance > 0 ? '#0284c7' : '#cbd5e1')};"></div>
            </div>
            <div class="table-progress-num">${task.advance}%</div>
          </div>
        </td>
        <td><span class="dept-cell-name">${escapeHtml(task.department)}</span></td>
        <td><div class="responsables-cell">${respHtml}</div></td>
        <td class="due-date-cell">${dateHtml}</td>
        ${completionTd}
        <td class="reason-cell">
          <div class="reason-input-wrapper">
            <textarea 
              class="reason-edit-textarea" 
              data-hub="${escapeHtml(task.department || 'NOC')}" 
              data-task="${escapeHtml(task.name)}" 
              placeholder="Escribir razón..." 
              rows="2"
              title="Escriba directamente aquí la razón o justificación de esta tarea">${escapeHtml(task.reason && task.reason !== '-' ? task.reason : '')}</textarea>
            <span class="reason-print-only">${escapeHtml(task.reason && task.reason !== '-' ? task.reason : '-')}</span>
          </div>
        </td>
      `;

      tbody.appendChild(tr);
    });
  }

  function renderNocPmoAnalysis() {
    const rawNoc = state.processed.noc;

    // Overloaded assignees
    const assigneeMap = {};
    const assigneeLateMap = {};

    rawNoc.forEach(t => {
      t.assignees.forEach(a => {
        assigneeMap[a] = (assigneeMap[a] || 0) + 1;
        if (t.delayed) {
          assigneeLateMap[a] = (assigneeLateMap[a] || 0) + 1;
        }
      });
    });

    const topAssignees = Object.entries(assigneeMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => `${name} (${count} tareas${assigneeLateMap[name] ? `, ${assigneeLateMap[name]} con retraso` : ''})`)
      .join(', ');

    const topElem = document.getElementById('pmo-overload-text');
    if (topElem) {
      topElem.textContent = topAssignees 
        ? `Existen cuellos de botella marcados en roles específicos: ${topAssignees}. La sobreasignación en frentes de alta complejidad está quebrando las fechas de entrega.`
        : 'Carga de trabajo balanceada actualmente sin dependencias críticas.';
    }

    // Unassigned dates count
    const noDueCount = rawNoc.filter(t => t.plannedDate === '-').length;
    const noDueElem = document.getElementById('pmo-undated-text');
    if (noDueElem) {
      noDueElem.textContent = `Se identificaron ${noDueCount} tareas en Planner sin Fecha de Vencimiento definida (-), incluyendo varias en RED FISICA y Cyber Seguridad. En metodologías ágiles/PMO, la ausencia de un compromiso temporal equivale a un ticket congelado sin escalamiento.`;
    }

    // Phantom progress count
    const phantomCount = rawNoc.filter(t => t.status.toLowerCase() === 'en curso' && (t.checklist.startsWith('0/') || t.advance === 0)).length;
    const phantomElem = document.getElementById('pmo-phantom-text');
    if (phantomElem) {
      phantomElem.textContent = `Se detectan ${phantomCount} tareas catalogadas "En Curso" pero con listas de comprobación estancadas en 0% (Ej. Troncales RED FISICA). Esto indica que el estado fue cambiado administrativamente sin evidencia de avance técnico en campo o laboratorio.`;
    }
  }

  /* ==========================================================================
     CHARTS (Chart.js)
     ========================================================================== */

  function updateCharts() {
    if (typeof Chart === 'undefined') return;

    // 1. Chart Comparativo por Sección (Home)
    const ctxComp = document.getElementById('chart-comparativo-canvas');
    if (ctxComp) {
      const m = state.metrics;

      if (chartComparativo) chartComparativo.destroy();
      chartComparativo = new Chart(ctxComp, {
        type: 'bar',
        data: {
          labels: ['HUBs', 'Enlaces Troncales', 'NOC Red IP'],
          datasets: [
            {
              label: 'Nuevos Proyectos',
              data: [m.hubsNuevosAdv, m.enlacesNuevosAdv, null],
              backgroundColor: '#0284c7',
              borderRadius: 4,
              borderWidth: 1
            },
            {
              label: 'Operaciones',
              data: [m.hubsOpAdv, m.enlacesOpAdv, null],
              backgroundColor: '#64748b',
              borderRadius: 4,
              borderWidth: 1
            },
            {
              label: 'Red IP (NOC)',
              data: [null, null, m.nocAdv],
              backgroundColor: '#0f2942',
              borderRadius: 4,
              borderWidth: 1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          skipNull: true,
          scales: {
            x: {
              grid: { display: false }
            },
            y: {
              beginAtZero: true,
              max: 100,
              ticks: { callback: v => `${v}%` }
            }
          },
          datasets: {
            bar: {
              maxBarThickness: 42
            }
          },
          plugins: {
            legend: {
              display: true,
              position: 'top',
              labels: {
                boxWidth: 12,
                font: { size: 11, weight: '600' }
              }
            },
            tooltip: {
              callbacks: {
                label: ctx => ` ${ctx.dataset.label}: ${ctx.raw}%`
              }
            }
          }
        },
        plugins: [{
          id: 'barLabels',
          afterDatasetsDraw(chart) {
            const { ctx } = chart;
            chart.data.datasets.forEach((dataset, i) => {
              const meta = chart.getDatasetMeta(i);
              meta.data.forEach((bar, index) => {
                const val = dataset.data[index];
                if (val !== null && val !== undefined) {
                  ctx.save();
                  ctx.fillStyle = '#334155';
                  ctx.font = 'bold 11px system-ui, sans-serif';
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'bottom';
                  ctx.fillText(`${val}%`, bar.x, bar.y - 4);
                  ctx.restore();
                }
              });
            });
          }
        }]
      });
    }

    // 2. Chart Global Estados (Home)
    const ctxEstados = document.getElementById('chart-estados-canvas');
    if (ctxEstados) {
      const m = state.metrics;
      if (chartGlobalEstados) chartGlobalEstados.destroy();
      chartGlobalEstados = new Chart(ctxEstados, {
        type: 'doughnut',
        data: {
          labels: [
            'Completadas',
            'En Curso (a tiempo)',
            'En Curso (Retrasadas)',
            'No Iniciadas (a tiempo)',
            'No Iniciadas (Retrasadas)'
          ],
          datasets: [{
            data: [
              m.completadas,
              m.enCursoATiempo,
              m.enCursoRetrasadas,
              m.noIniciadasATiempo,
              m.noIniciadasRetrasadas
            ],
            backgroundColor: ['#22c55e', '#0284c7', '#ea580c', '#94a3b8', '#dc2626'],
            hoverOffset: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10, weight: '600' } } }
          },
          cutout: '65%'
        }
      });
    }

    // 3. Chart NOC Urgent Tasks by Department
    renderNocUrgentChart();
  }

  function renderNocUrgentChart() {
    const ctxUrgent = document.getElementById('chart-noc-urgent-canvas');
    if (!ctxUrgent || typeof Chart === 'undefined') return;

    // Tally urgent tasks by department
    const urgentMap = {};
    let totalUrgent = 0;
    (state.processed.noc || []).forEach(t => {
      if (t.isUrgent) {
        totalUrgent++;
        urgentMap[t.department] = (urgentMap[t.department] || 0) + 1;
      }
    });

    const badge = document.getElementById('noc-urgent-total-badge');
    if (badge) {
      badge.textContent = `${totalUrgent} ${totalUrgent === 1 ? 'tarea urgente' : 'tareas urgentes'}`;
    }

    const filterIndicator = document.getElementById('noc-urgent-filter-indicator');
    const filterDept = document.getElementById('noc-urgent-filter-dept');
    if (filterIndicator && filterDept) {
      if (state.nocDeptFilter) {
        filterIndicator.style.display = 'block';
        filterDept.textContent = state.nocDeptFilter;
      } else {
        filterIndicator.style.display = 'none';
      }
    }

    // Sort descending by urgent count
    const sortedUrgent = Object.entries(urgentMap).sort((a, b) => b[1] - a[1]);
    const labels = sortedUrgent.map(e => e[0]);
    const counts = sortedUrgent.map(e => e[1]);

    // Dynamic height based on number of labels
    const canvasContainer = ctxUrgent.parentElement;
    if (canvasContainer) {
      const neededHeight = Math.max(140, Math.min(260, (labels.length || 1) * 45 + 50));
      canvasContainer.style.height = `${neededHeight}px`;
    }

    // Colors: highlight if active filter matches department
    const bgColors = labels.map(dept => state.nocDeptFilter === dept ? '#9f1239' : '#e11d48');
    const hoverColors = labels.map(() => '#be123c');

    if (chartNocUrgent) {
      chartNocUrgent.destroy();
      chartNocUrgent = null;
    }

    chartNocUrgent = new Chart(ctxUrgent, {
      type: 'bar',
      data: {
        labels: labels.length > 0 ? labels : ['Sin tareas urgentes'],
        datasets: [{
          label: 'Tareas Urgentes',
          data: counts.length > 0 ? counts : [0],
          backgroundColor: bgColors,
          hoverBackgroundColor: hoverColors,
          borderRadius: 6,
          barThickness: 22
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        onClick: (evt, elements) => {
          if (elements && elements.length > 0) {
            const idx = elements[0].index;
            const clickedDept = labels[idx];
            if (!clickedDept) return;
            if (state.nocDeptFilter === clickedDept) {
              state.nocDeptFilter = null; // Toggle off
            } else {
              state.nocDeptFilter = clickedDept;
            }
            renderNocView();
          }
        },
        onHover: (evt, elements) => {
          if (evt.native && evt.native.target) {
            evt.native.target.style.cursor = (elements && elements.length) ? 'pointer' : 'default';
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.raw} tareas urgentes • Clic para filtrar`
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { precision: 0, stepSize: 1, color: '#9f1239', font: { weight: '600' } },
            grid: { color: '#ffe4e6' }
          },
          y: {
            grid: { display: false },
            ticks: {
              font: { weight: '700', size: 12 },
              color: '#4c0519'
            }
          }
        }
      }
    });
  }

  /* ==========================================================================
     EXCEL IMPORT ENGINE (SheetJS)
     ========================================================================== */

  function handleExcelUpload(file) {
    if (!file) return;
    if (typeof XLSX === 'undefined') {
      showToast('Error: Biblioteca SheetJS no disponible.');
      return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array', cellDates: true });
        
        const newData = {};
        workbook.SheetNames.forEach(sheetName => {
          const sheet = workbook.Sheets[sheetName];
          const jsonRows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
          newData[sheetName] = jsonRows;
        });

        state.rawData = newData;
        state.lastUpdated = new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        recordModification();
        
        // Reprocess
        processData();
        renderApp();

        showToast(`¡Excel cargado con éxito! ${workbook.SheetNames.length} hojas actualizadas.`);
      } catch (err) {
        console.error('Error al procesar el archivo Excel:', err);
        showToast('Error al leer el archivo Excel. Verifique el formato.');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  /* ==========================================================================
     GOOGLE SHEETS LIVE SYNC ENGINE
     ========================================================================== */

  async function syncDataFromGoogleSheets(isManual = false) {
    if (state.isSyncing) return;
    state.isSyncing = true;

    const syncBtn = document.getElementById('btn-sync-sheets');
    const syncLabel = document.getElementById('sync-btn-label');
    const heroSyncBadge = document.getElementById('hero-sync-badge');

    if (syncBtn) syncBtn.classList.add('syncing');
    if (syncLabel) syncLabel.textContent = 'Sincronizando...';
    if (heroSyncBadge) {
      heroSyncBadge.className = 'sync-badge-live sync-badge-syncing';
      heroSyncBadge.textContent = '🔄 Conectando con Google Sheets...';
    }

    try {
      const res = await fetch(GOOGLE_SHEETS_API_URL);
      if (!res.ok) {
        throw new Error(`Respuesta no satisfactoria del servidor: ${res.status}`);
      }
      const data = await res.json();
      if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
        throw new Error('Formato de datos vacío o no reconocido');
      }

      state.rawData = data;
      state.lastModifiedDate = new Date();

      try {
        localStorage.setItem('pmo_sheets_cached_data', JSON.stringify(data));
        localStorage.setItem('pmo_last_sync_date', state.lastModifiedDate.toISOString());
      } catch (storageErr) {
        console.warn('No se pudo guardar la caché en localStorage', storageErr);
      }

      processData();
      renderApp();

      if (isManual) {
        showToast('¡Datos sincronizados exitosamente con Google Sheets!');
      }
    } catch (err) {
      console.error('Error al sincronizar con Google Sheets:', err);
      if (heroSyncBadge) {
        heroSyncBadge.className = 'sync-badge-live sync-badge-error';
        heroSyncBadge.textContent = '⚠️ Error de sincronización (usando datos locales)';
      }
      if (isManual) {
        showToast('No se pudo conectar a Google Sheets. Verifique su conexión a internet.');
      }
    } finally {
      state.isSyncing = false;
      if (syncBtn) syncBtn.classList.remove('syncing');
      if (syncLabel) syncLabel.textContent = 'Sincronizar Sheets';
      updateReportDates();
    }
  }

  function exportSectionToExcel(section) {
    if (typeof XLSX === 'undefined') {
      showToast('Error: Biblioteca SheetJS no disponible para exportar.');
      return;
    }

    const wb = XLSX.utils.book_new();

    if (section === 'HUBS' || section === 'ALL') {
      const hubsExportRows = [];
      state.processed.hubsAll.forEach(h => {
        h.tasks.forEach(t => {
          hubsExportRows.push({
            'HUB': h.name,
            'Sección': h.category,
            'Avance Global HUB': `${h.advance}%`,
            'Tarea': t.name,
            'Estado': t.status,
            'Avance Tarea': `${t.advance}%`,
            'Fecha Planificada': t.plannedDate,
            'Fecha Finalización': t.completedDate,
            'Razón / Notas': t.reason,
            'Asignado a': t.assignees.join('; '),
            'Etiquetas': t.tags.join('; ')
          });
        });
      });
      const wsHubs = XLSX.utils.json_to_sheet(hubsExportRows);
      XLSX.utils.book_append_sheet(wb, wsHubs, 'Reporte HUBS');
    }

    if (section === 'ENLACES' || section === 'ALL') {
      const enlacesExportRows = [];
      state.processed.enlacesAll.forEach(e => {
        e.tasks.forEach(t => {
          enlacesExportRows.push({
            'Enlace Troncal': e.name,
            'Sección': e.category,
            'Avance Global Enlace': `${e.advance}%`,
            'Tarea': t.name,
            'Estado': t.status,
            'Avance Tarea': `${t.advance}%`,
            'Fecha Planificada': t.plannedDate,
            'Fecha Finalización': t.completedDate,
            'Razón / Notas': t.reason,
            'Asignado a': t.assignees.join('; '),
            'Etiquetas': t.tags.join('; ')
          });
        });
      });
      const wsEnlaces = XLSX.utils.json_to_sheet(enlacesExportRows);
      XLSX.utils.book_append_sheet(wb, wsEnlaces, 'Reporte ENLACES');
    }

    if (section === 'NOC' || section === 'ALL') {
      const nocExportRows = state.processed.noc.map(t => ({
        'Nombre de la tarea': t.name,
        'Departamento / Depósito': t.department,
        'Estado': t.status,
        'Subtareas': t.checklist,
        'Avance': `${t.advance}%`,
        'Asignado a': t.assignees.join('; '),
        'Etiquetas': t.tags.join('; '),
        'Fecha Planificada': t.plannedDate,
        'Fecha Finalización': t.completedDate,
        'Razón / Alerta': t.reason
      }));
      const wsNoc = XLSX.utils.json_to_sheet(nocExportRows);
      XLSX.utils.book_append_sheet(wb, wsNoc, 'Reporte NOC');
    }

    const filename = `PMO_Fibex_Reporte_${section}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, filename);
    showToast(`Archivo ${filename} generado y descargado.`);
  }

  /* ==========================================================================
     STANDALONE INDEX.HTML EXPORT (SINGLE-FILE OFFLINE DASHBOARD)
     ========================================================================== */

  function exportStandaloneIndex() {
    showToast('Generando aplicación index.html autónoma con datos actuales...');

    // 1. Gather all current custom reasons
    let customReasons = {};
    try {
      customReasons = JSON.parse(localStorage.getItem('pmo_custom_reasons') || '{}');
    } catch (e) {}

    // Ensure any reason currently in DOM textareas is saved
    document.querySelectorAll('.reason-edit-textarea').forEach(ta => {
      const entity = ta.dataset.hub;
      const task = ta.dataset.task;
      const val = ta.value.trim();
      if (entity && task && val) {
        customReasons[`${entity}:::${task}`] = val;
      }
    });

    const resources = window.STANDALONE_RESOURCES || {};
    let template = resources.htmlTemplate || '';

    if (!template) {
      template = `<!DOCTYPE html>\n<html lang="es">\n${document.documentElement.innerHTML}\n</html>`;
    }

    const cssContent = resources.css || '';
    const chartContent = resources.chartJs || '';
    const xlsxContent = resources.xlsxJs || '';
    const appContent = resources.appJs || '';

    // Replace stylesheet link with inline <style>
    if (cssContent) {
      const styleTag = `<style id="app-styles">\n${cssContent}\n</style>`;
      template = template.replace(/<link\s+rel=["']stylesheet["']\s+href=["']assets\/css\/styles\.css["']\s*>/i, () => styleTag);
    }

    // Prepare self-contained scripts block without literal script tags in app source code
    // Safeguard JSON strings against unexpected script closing sequences
    const safeRawData = JSON.stringify(state.rawData).replace(/<\/(script)/gi, '<\\/$1');
    const safeReasons = JSON.stringify(customReasons).replace(/<\/(script)/gi, '<\\/$1');
    const safeDate = JSON.stringify(state.lastModifiedDate ? state.lastModifiedDate.toISOString() : new Date().toISOString());

    const sOpen = '<' + 'script>';
    const sClose = '<' + '/script>';

    const embeddedScripts = [
      '  <!-- ==========================================================================',
      '       DATOS, BIBLIOTECAS Y LÓGICA 100% EMBEBIDOS PARA USO AUTÓNOMO / OFFLINE',
      '       ========================================================================== -->',
      `  ${sOpen}`,
      xlsxContent,
      `  ${sClose}`,
      `  ${sOpen}`,
      chartContent,
      `  ${sClose}`,
      `  ${sOpen}`,
      '    // Datos y razones actualizados en el momento de la exportación',
      `    window.INITIAL_PMO_DATA = ${safeRawData};`,
      `    window.PMO_PRELOADED_REASONS = ${safeReasons};`,
      `    window.PMO_LAST_MODIFIED_DATE = ${safeDate};`,
      '    try {',
      '      localStorage.setItem("pmo_custom_reasons", JSON.stringify(window.PMO_PRELOADED_REASONS));',
      '      localStorage.setItem("pmo_last_modified_date", window.PMO_LAST_MODIFIED_DATE);',
      '    } catch(e) {}',
      `  ${sClose}`,
      `  ${sOpen}`,
      appContent,
      `  ${sClose}`,
      ''
    ].join('\n');

    // Replace the script section at the bottom (using replacer function so $ in minified JS is treated literally)
    const scriptSectionRegex = /<!-- Bibliotecas Locales con Fallback CDN -->[\s\S]*?(?=<\/body>)/i;
    if (scriptSectionRegex.test(template)) {
      template = template.replace(scriptSectionRegex, () => embeddedScripts);
    } else {
      template = template.replace(/<\/body>/i, () => `${embeddedScripts}\n</body>`);
    }

    // Create and trigger download of index.html
    const blob = new Blob([template], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'index.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2500);

    showToast('¡Archivo index.html descargado con éxito! Listo para compartir y abrir localmente.');
  }

  /* ==========================================================================
     PRINT / PDF REPORT DOWNLOAD
     ========================================================================== */

  function triggerDownloadReport(section) {
    // Clean classes
    document.body.classList.remove('print-hubs-only', 'print-enlaces-only', 'print-noc-only', 'print-all-sections');

    if (section === 'HUBS') {
      document.body.classList.add('print-hubs-only');
    } else if (section === 'ENLACES') {
      document.body.classList.add('print-enlaces-only');
    } else if (section === 'NOC') {
      document.body.classList.add('print-noc-only');
    } else if (section === 'ALL') {
      document.body.classList.add('print-all-sections');
    }

    showToast(`Generando vista de descarga / impresión para ${section}...`);
    setTimeout(() => {
      window.print();
    }, 400);
  }

  // Ensure clean restoration after printing or canceling print dialog
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('print-hubs-only', 'print-enlaces-only', 'print-noc-only', 'print-all-sections');
  });

  /* ==========================================================================
     NAVIGATION & UI CONTROLLER
     ========================================================================== */

  function switchView(viewName) {
    state.currentView = viewName;
    if (window.location.hash !== `#${viewName}`) {
      window.location.hash = viewName;
    }

    // View sections
    document.querySelectorAll('.view-section').forEach(sec => {
      sec.classList.remove('active-view');
    });

    const activeSec = document.getElementById(`view-${viewName}`);
    if (activeSec) activeSec.classList.add('active-view');

    // Nav buttons
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    // Reset search
    state.searchQuery = '';
    const searchInputs = document.querySelectorAll('.view-search-input');
    searchInputs.forEach(inp => { inp.value = ''; });

    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Re-render if needed
    if (viewName === 'hubs') renderHubsView();
    else if (viewName === 'enlaces') renderEnlacesView();
    else if (viewName === 'noc') renderNocView();
    else renderMainDashboard();

    updateCharts();
  }

  function showToast(msg) {
    const toast = document.getElementById('toast-notification');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 3500);
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /* ==========================================================================
     EVENT LISTENERS INITIALIZATION
     ========================================================================== */

  function setupEventListeners() {
    // Navigation items
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        switchView(btn.dataset.view);
      });
    });

    // Back buttons
    document.querySelectorAll('.btn-back-general').forEach(btn => {
      btn.addEventListener('click', () => switchView('general'));
    });

    // Home Section cards redirect
    document.getElementById('btn-goto-hubs').addEventListener('click', () => switchView('hubs'));
    document.getElementById('btn-goto-enlaces').addEventListener('click', () => switchView('enlaces'));
    document.getElementById('btn-goto-noc').addEventListener('click', () => switchView('noc'));

    // File upload
    const fileInput = document.getElementById('excel-file-input');
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleExcelUpload(e.target.files[0]);
      }
    });

    // Drag and drop file support on document
    window.addEventListener('dragover', (e) => e.preventDefault(), false);
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleExcelUpload(e.dataTransfer.files[0]);
      }
    }, false);

    // HUBS Tabs
    document.querySelectorAll('.hubs-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.hubs-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.hubsTab = btn.dataset.tab;
        renderHubsView();
      });
    });

    // ENLACES Tabs
    document.querySelectorAll('.enlaces-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.enlaces-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.enlacesTab = btn.dataset.tab;
        renderEnlacesView();
      });
    });

    // NOC Department Filter reset buttons
    const btnClearNocFilter = document.getElementById('btn-clear-noc-filter');
    if (btnClearNocFilter) {
      btnClearNocFilter.addEventListener('click', () => {
        state.nocDeptFilter = null;
        renderNocView();
      });
    }

    const btnClearNocUrgentFilter = document.getElementById('btn-clear-noc-urgent-filter');
    if (btnClearNocUrgentFilter) {
      btnClearNocUrgentFilter.addEventListener('click', () => {
        state.nocDeptFilter = null;
        renderNocView();
      });
    }

    // Live search input
    document.querySelectorAll('.view-search-input').forEach(inp => {
      inp.addEventListener('input', (e) => {
        state.searchQuery = e.target.value;
        if (state.currentView === 'hubs') renderHubsView();
        else if (state.currentView === 'enlaces') renderEnlacesView();
        else if (state.currentView === 'noc') renderNocView();
      });
    });

    // Responsable filter dropdown (HUBS - selección directa sin teclear)
    const respSelect = document.getElementById('hubs-responsable-select');
    if (respSelect) {
      respSelect.addEventListener('change', (e) => {
        state.hubsResponsableFilter = e.target.value.trim();
        renderHubsView();
      });
    }

    const clearRespBtn = document.getElementById('btn-clear-responsable-filter');
    if (clearRespBtn) {
      clearRespBtn.addEventListener('click', () => {
        state.hubsResponsableFilter = '';
        if (respSelect) respSelect.value = '';
        renderHubsView();
      });
    }

    // Responsable filter dropdown (ENLACES - selección directa sin teclear)
    const enlaceRespSelect = document.getElementById('enlaces-responsable-select');
    if (enlaceRespSelect) {
      enlaceRespSelect.addEventListener('change', (e) => {
        state.enlacesResponsableFilter = e.target.value.trim();
        renderEnlacesView();
      });
    }

    const clearEnlaceRespBtn = document.getElementById('btn-clear-enlaces-responsable-filter');
    if (clearEnlaceRespBtn) {
      clearEnlaceRespBtn.addEventListener('click', () => {
        state.enlacesResponsableFilter = '';
        if (enlaceRespSelect) enlaceRespSelect.value = '';
        renderEnlacesView();
      });
    }

    // Responsable filter dropdown (NOC - selección directa sin teclear)
    const nocRespSelect = document.getElementById('noc-responsable-select');
    if (nocRespSelect) {
      nocRespSelect.addEventListener('change', (e) => {
        state.nocResponsableFilter = e.target.value.trim();
        renderNocView();
      });
    }

    const clearNocRespBtn = document.getElementById('btn-clear-noc-responsable-filter');
    if (clearNocRespBtn) {
      clearNocRespBtn.addEventListener('click', () => {
        state.nocResponsableFilter = '';
        if (nocRespSelect) nocRespSelect.value = '';
        renderNocView();
      });
    }

    // Google Sheets live sync
    const btnSyncSheets = document.getElementById('btn-sync-sheets');
    if (btnSyncSheets) {
      btnSyncSheets.addEventListener('click', () => syncDataFromGoogleSheets(true));
    }

    // Downloads / Print
    document.getElementById('btn-print-hubs').addEventListener('click', () => triggerDownloadReport('HUBS'));
    document.getElementById('btn-print-enlaces').addEventListener('click', () => triggerDownloadReport('ENLACES'));
    document.getElementById('btn-print-noc').addEventListener('click', () => triggerDownloadReport('NOC'));
    document.getElementById('btn-download-all').addEventListener('click', () => triggerDownloadReport('ALL'));

    // Excel direct export
    document.getElementById('btn-excel-hubs').addEventListener('click', () => exportSectionToExcel('HUBS'));
    document.getElementById('btn-excel-enlaces').addEventListener('click', () => exportSectionToExcel('ENLACES'));
    document.getElementById('btn-excel-noc').addEventListener('click', () => exportSectionToExcel('NOC'));
    document.getElementById('btn-excel-all').addEventListener('click', () => exportSectionToExcel('ALL'));

    // Standalone index.html export
    const btnExportStandalone = document.getElementById('btn-export-standalone-html');
    if (btnExportStandalone) {
      btnExportStandalone.addEventListener('click', exportStandaloneIndex);
    }
    const btnNavExportHtml = document.getElementById('btn-nav-export-html');
    if (btnNavExportHtml) {
      btnNavExportHtml.addEventListener('click', exportStandaloneIndex);
    }

    // Global clear filter functions
    window.clearHubsFilter = function() {
      state.hubsTaskFilter = null;
      state.hubsResponsableFilter = '';
      state.searchQuery = '';
      const rSel = document.getElementById('hubs-responsable-select');
      if (rSel) rSel.value = '';
      const searchInputs = document.querySelectorAll('.view-search-input');
      searchInputs.forEach(i => { i.value = ''; });
      renderHubsView();
    };

    window.clearEnlacesFilter = function() {
      state.enlacesTaskFilter = null;
      state.enlacesResponsableFilter = '';
      state.searchQuery = '';
      const rSel = document.getElementById('enlaces-responsable-select');
      if (rSel) rSel.value = '';
      const searchInputs = document.querySelectorAll('.view-search-input');
      searchInputs.forEach(i => { i.value = ''; });
      renderEnlacesView();
    };

    window.clearNocFilter = function() {
      state.nocDeptFilter = null;
      state.nocResponsableFilter = '';
      state.nocTaskFilter = null;
      state.searchQuery = '';
      const rSel = document.getElementById('noc-responsable-select');
      if (rSel) rSel.value = '';
      const searchInputs = document.querySelectorAll('.view-search-input');
      searchInputs.forEach(i => { i.value = ''; });
      renderNocView();
    };

    // HUBS KPI Filter buttons
    [
      'total',
      'completadas',
      'en_curso',
      'en_curso_ontime',
      'en_curso_late',
      'no_iniciadas',
      'no_iniciadas_ontime',
      'no_iniciadas_late'
    ].forEach(filterKey => {
      const btnId = filterKey === 'total' ? 'kpi-btn-hubs-total' : `kpi-btn-hubs-${filterKey.replace(/_/g, '-')}`;
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (filterKey === 'total') {
            state.hubsTaskFilter = null;
          } else {
            if (state.hubsTaskFilter === filterKey) {
              state.hubsTaskFilter = null; // Toggle off
            } else {
              state.hubsTaskFilter = filterKey;
            }
          }
          renderHubsView();
        });
      }
    });

    const clearHubsBtn = document.getElementById('btn-clear-hubs-filter');
    if (clearHubsBtn) {
      clearHubsBtn.addEventListener('click', window.clearHubsFilter);
    }
    const clearHubsBanner = document.getElementById('btn-clear-hubs-filter-banner');
    if (clearHubsBanner) {
      clearHubsBanner.addEventListener('click', window.clearHubsFilter);
    }

    // ENLACES KPI Filter buttons
    [
      'total',
      'completadas',
      'en_curso',
      'en_curso_ontime',
      'en_curso_late',
      'no_iniciadas',
      'no_iniciadas_ontime',
      'no_iniciadas_late'
    ].forEach(filterKey => {
      const btnId = filterKey === 'total' ? 'kpi-btn-enlaces-total' : `kpi-btn-enlaces-${filterKey.replace(/_/g, '-')}`;
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (filterKey === 'total') {
            state.enlacesTaskFilter = null;
          } else {
            if (state.enlacesTaskFilter === filterKey) {
              state.enlacesTaskFilter = null; // Toggle off
            } else {
              state.enlacesTaskFilter = filterKey;
            }
          }
          renderEnlacesView();
        });
      }
    });

    const clearEnlacesBtn = document.getElementById('btn-clear-enlaces-filter');
    if (clearEnlacesBtn) {
      clearEnlacesBtn.addEventListener('click', window.clearEnlacesFilter);
    }
    const clearEnlacesBanner = document.getElementById('btn-clear-enlaces-filter-banner');
    if (clearEnlacesBanner) {
      clearEnlacesBanner.addEventListener('click', window.clearEnlacesFilter);
    }

    // NOC KPI Filter buttons
    [
      'total',
      'completadas',
      'en_curso',
      'en_curso_ontime',
      'en_curso_late',
      'no_iniciadas',
      'no_iniciadas_ontime',
      'no_iniciadas_late'
    ].forEach(filterKey => {
      const btnId = filterKey === 'total' ? 'kpi-btn-noc-total' : `kpi-btn-noc-${filterKey.replace(/_/g, '-')}`;
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (filterKey === 'total') {
            state.nocTaskFilter = null;
          } else {
            if (state.nocTaskFilter === filterKey) {
              state.nocTaskFilter = null; // Toggle off
            } else {
              state.nocTaskFilter = filterKey;
            }
          }
          renderNocView();
        });
      }
    });

    const clearNocTaskBanner = document.getElementById('btn-clear-noc-task-filter-banner');
    if (clearNocTaskBanner) {
      clearNocTaskBanner.addEventListener('click', () => {
        state.nocTaskFilter = null;
        renderNocView();
      });
    }

    // Editable reason event delegation for HUBS, ENLACES, and NOC
    ['hubs-detailed-cards-container', 'enlaces-detailed-cards-container', 'view-noc'].forEach(containerId => {
      const container = document.getElementById(containerId);
      if (!container) return;

      container.addEventListener('input', (e) => {
        if (e.target && e.target.classList.contains('reason-edit-textarea')) {
          const textarea = e.target;
          const entityName = textarea.dataset.hub;
          const taskName = textarea.dataset.task;
          const newVal = textarea.value.trim();

          // Update in-memory models across all views & exports
          updateTaskReasonInMemory(entityName, taskName, newVal);

          // Update print-mode companion element
          const printSpan = textarea.parentElement.querySelector('.reason-print-only');
          if (printSpan) printSpan.textContent = newVal || '-';

          // Persist to localStorage
          saveCustomReason(entityName, taskName, newVal);
        }
      });

      container.addEventListener('change', (e) => {
        if (e.target && e.target.classList.contains('reason-edit-textarea')) {
          const textarea = e.target;
          textarea.classList.add('saved-pulse');
          setTimeout(() => textarea.classList.remove('saved-pulse'), 1200);
          showToast('Razón guardada correctamente');
        }
      });
    });

    // Hash navigation
    function handleHash() {
      const hash = window.location.hash.replace('#', '').trim();
      if (['general', 'hubs', 'enlaces', 'noc'].includes(hash)) {
        switchView(hash);
      }
    }
    window.addEventListener('hashchange', handleHash);

    // Initial check
    const initialHash = window.location.hash.replace('#', '').trim();
    if (['general', 'hubs', 'enlaces', 'noc'].includes(initialHash)) {
      state.currentView = initialHash;
    }
  }

  /* ==========================================================================
     STARTUP
     ========================================================================== */

  function initApp() {
    processData();
    setupEventListeners();
    renderApp();
    if (state.currentView !== 'general') {
      switchView(state.currentView);
    }
    // Sincronización automática en segundo plano con Google Sheets
    syncDataFromGoogleSheets(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }

})();
