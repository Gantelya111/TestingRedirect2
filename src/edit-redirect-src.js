import { startNodePromise, getRedirect, updateRedirect } from './p2p.js';

// Дебаг імпорту
console.log('DEBUG: Imports in edit-redirect-src.js:', {
    startNodePromise: !!startNodePromise,
    getRedirect: typeof getRedirect,
    updateRedirect: typeof updateRedirect
});

// Показує повідомлення в UI
function showMessage(messagesDiv, text, type = 'info') {
    console.log('DEBUG: Showing message:', text, 'Type:', type);
    const alertClass = type === 'error' ? 'alert-danger' : (type === 'success' ? 'alert-success' : 'alert-info');
    messagesDiv.innerHTML = `<div class="alert ${alertClass}">${text}</div>`;
    if (type !== 'error') setTimeout(() => messagesDiv.innerHTML = '', 5000);
}

// Ініціалізація редагування редиректу
async function initializeEditRedirect() {
    console.log('DEBUG: Initializing edit redirect');
    const editForm = document.getElementById('edit-redirect-form');
    const messagesDiv = document.getElementById('messages');
    const p2pStatusDiv = document.getElementById('p2p-status');

    if (!editForm || !messagesDiv || !p2pStatusDiv) {
        console.error('DEBUG: Missing DOM elements:', {
            editForm: !!editForm,
            messagesDiv: !!messagesDiv,
            p2pStatusDiv: !!p2pStatusDiv
        });
        if (messagesDiv) showMessage(messagesDiv, 'Error: Page elements not found', 'error');
        return;
    }

    // Запускаємо P2P-вузол
    try {
        await startNodePromise;
        console.log('DEBUG: P2P node initialized');
        p2pStatusDiv.textContent = 'P2P Status: Connected';
    } catch (err) {
        console.error('DEBUG: Error initializing P2P:', err);
        p2pStatusDiv.textContent = 'P2P Status: No network connection';
        showMessage(messagesDiv, `Error initializing P2P: ${err.message}`, 'error');
    }

    // Отримуємо shortCode із URL
    const urlParams = new URLSearchParams(window.location.search);
    const shortCode = urlParams.get('code');
    if (!shortCode) {
        showMessage(messagesDiv, 'Error: No redirect code provided', 'error');
        return;
    }

    // Завантажуємо редирект
    try {
        const redirect = await getRedirect(shortCode);
        if (!redirect) {
            showMessage(messagesDiv, `Redirect /r/${shortCode} not found`, 'error');
            return;
        }
        document.getElementById('destination_url').value = redirect.destinationUrl;
        document.getElementById('description').value = redirect.description || '';
    } catch (err) {
        console.error('DEBUG: Error loading redirect:', err);
        showMessage(messagesDiv, `Error loading redirect: ${err.message}`, 'error');
    }

    // Обробник форми редагування
    editForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        console.log('DEBUG: Handling edit redirect form submit');
        const newUrl = document.getElementById('destination_url').value.trim();
        const newDescription = document.getElementById('description').value.trim();
        const password = document.getElementById('password').value;

        try {
            await updateRedirect(shortCode, newUrl, newDescription, password);
            showMessage(messagesDiv, `Redirect /r/${shortCode} updated`, 'success');
            editForm.reset();
        } catch (err) {
            console.error('DEBUG: Error updating redirect:', err);
            showMessage(messagesDiv, `Error: ${err.message}`, 'error');
        }
    });
}

// Запускаємо ініціалізацію
try {
    initializeEditRedirect();
} catch (err) {
    console.error('DEBUG: Error initializing edit redirect:', err);
    const messagesDiv = document.getElementById('messages');
    if (messagesDiv) {
        showMessage(messagesDiv, `Error initializing edit redirect: ${err.message}`, 'error');
    }
}