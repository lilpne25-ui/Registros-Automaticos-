// Toast Notifications - Sistema de notificaciones
// Extraído para modularización (2025-12-18)

(function(global) {
    'use strict';
    
    /**
     * Muestra una notificación toast en la esquina inferior derecha
     * @param {string} message - Mensaje a mostrar
     * @param {string} type - Tipo: 'info', 'success', 'warning', 'error'
     * @param {number} duration - Duración en ms (default: 2000)
     */
    function showNotification(message, type = 'info', duration = 2000) {
        // Crear contenedor si no existe
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        // Crear elemento de notificación
        const notification = document.createElement('div');
        notification.className = `toast-notification ${type}`;
        notification.textContent = message;

        // Agregar a contenedor
        container.appendChild(notification);

        // Forzar reflow para activar animación slideInUp
        void notification.offsetHeight;

        // Remover notificación después de duration
        setTimeout(() => {
            notification.classList.add('closing');
            setTimeout(() => {
                notification.remove();
            }, 300); // Tiempo de animación slideOutDown
        }, duration);
    }
    
    // Exponer globalmente
    global.showNotification = showNotification;
    
    // También en window.App.ui
    if (!global.App) global.App = {};
    if (!global.App.ui) global.App.ui = {};
    global.App.ui.showNotification = showNotification;
    
    console.log('✅ [Toast] Módulo de notificaciones inicializado');
    
})(typeof window !== 'undefined' ? window : this);
