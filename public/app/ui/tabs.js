// Tabs UI para sistema_de_grabado_laserv1
// Extraído del script embebido (2025-12-18)

function setupTabs() {
    const tabs = document.querySelectorAll('.tab');
    const contents = document.querySelectorAll('.tab-content');

    function activateTab(tabName) {
        tabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === tabName));
        contents.forEach(c => c.classList.toggle('active', c.id === tabName));

        // Actualizar el texto del encabezado según la pestaña activa (láser / pavonado)
        const headerMainTitle = document.getElementById('header-main-title');
        const reportCardTitle = document.getElementById('report-card-title');
        if (tabName === 'reporte-pavonado') {
            if (headerMainTitle) headerMainTitle.textContent = 'Registro Pavonado';
            if (reportCardTitle) reportCardTitle.textContent = 'Registro Pavonado';
        } else if (tabName === 'reporte') {
            if (headerMainTitle) headerMainTitle.textContent = 'Registro Grabado Láser';
            if (reportCardTitle) reportCardTitle.textContent = 'Registro Grabado Láser';
        }

        // Cuando se active la pestaña 'reporte', ejecutar las acciones específicas
        // NOTA: no añadimos/removemos una clase 'report-view' porque el encabezado
        // debe permanecer oculto en la vista web y solo mostrarse al imprimir.
        if (tabName === 'reporte') {
            try { loadReportData(); } catch (e) {}
            try { createCharts(); } catch (e) {}
        }

        if (tabName === 'reporte-pavonado') {
            try { loadReportDataPavonado(); } catch (e) {}
            try { createChartsPavonado(); } catch (e) {}
        }

        if (tabName === 'whatsapp') {
            try { loadWhatsAppStatus(); } catch (e) {}
            try { if (typeof loadWhatsAppGroups === 'function') loadWhatsAppGroups(); } catch (e) {}
            try { if (typeof loadWhatsAppLogs === 'function') loadWhatsAppLogs(); } catch (e) {}
            try { if (typeof refreshWhatsAppControls === 'function') refreshWhatsAppControls(); } catch (e) {}
        }
        if (tabName === 'lotes') {
            try { renderLotes(); } catch (e) {}
        }
        if (tabName === 'historial-reportes') {
            try { if (typeof window.loadHistorialReportes === 'function') window.loadHistorialReportes(); } catch (e) {}
        }
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', function () {
            const tabId = this.getAttribute('data-tab');
            activateTab(tabId);
        });
    });

    // Activar la pestaña inicial (la que tenga class 'active' en el HTML) o la primera
    const initial = document.querySelector('.tab.active') || tabs[0];
    if (initial) activateTab(initial.getAttribute('data-tab'));
}
