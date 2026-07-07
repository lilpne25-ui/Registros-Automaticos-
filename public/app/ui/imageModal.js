// Modal de imagen ampliada (global, usado por onclick/ondblclick inline)
// Extraído del script embebido (2025-12-18)

function openImageModal(src) {
    try {
        const modal = document.getElementById('image-modal');
        const img = document.getElementById('image-modal-img');
        if (!modal || !img) return;
        img.src = src;
        modal.setAttribute('aria-hidden', 'false');
    } catch (e) {
        console.error('Error abriendo modal de imagen:', e);
    }
}

function closeImageModal() {
    try {
        const modal = document.getElementById('image-modal');
        const img = document.getElementById('image-modal-img');
        if (!modal || !img) return;
        img.src = '';
        modal.setAttribute('aria-hidden', 'true');
    } catch (e) {
        console.error('Error cerrando modal de imagen:', e);
    }
}
