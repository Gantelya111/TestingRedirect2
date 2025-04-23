import { startNodePromise, createRedirect } from './p2p.js';
import { verifyManagerPassword, initializeManager } from './manager-src.js';

// Дебаг імпорту
console.log('DEBUG: Imports in p2p-app-src.js:', {
    startNodePromise: !!startNodePromise,
    createRedirect: typeof createRedirect,
    verifyManagerPassword: typeof verifyManagerPassword,
    initializeManager: typeof initializeManager
});

// Показує повідомлення в UI
function showMessage(messagesDiv, text, type = 'info') {
    console.log('DEBUG: Showing message:', text, 'Type:', type);
    const alertClass = type === 'error' ? 'alert-danger' : (type === 'success' ? 'alert-success' : 'alert-info');
    messagesDiv.innerHTML = `<div class="alert ${alertClass}">${text}</div>`;
    if (type !== 'error') setTimeout(() => messagesDiv.innerHTML = '', 5000);
}

// Ініціалізація додатка
async function initializeApp() {
    console.log('DEBUG: Initializing P2P app');
    const messagesDiv = document.getElementById('messages');
    const p2pStatusDiv = document.getElementById('p2p-status');

    if (!messagesDiv || !p2pStatusDiv) {
        console.error('DEBUG: Missing DOM elements:', {
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

    // Приклад використання verifyManagerPassword
    const testPassword = 'test123';
    try {
        const isValid = await verifyManagerPassword(testPassword);
        console.log('DEBUG: Manager password verification result:', isValid);
        showMessage(messagesDiv, `Password verification: ${isValid ? 'Valid' : 'Invalid'}`, isValid ? 'success' : 'error');
    } catch (err) {
        console.error('DEBUG: Error verifying password:', err);
        showMessage(messagesDiv, `Error verifying password: ${err.message}`, 'error');
    }

    // Виклик initializeManager (якщо потрібно)
    try {
        await initializeManager();
        console.log('DEBUG: Manager initialized');
    } catch (err) {
        console.error('DEBUG: Error initializing manager:', err);
        showMessage(messagesDiv, `Error initializing manager: ${err.message}`, 'error');
    }
}

// Запускаємо ініціалізацію
try {
    initializeApp();
} catch (err) {
    console.error('DEBUG: Error initializing app:', err);
    const messagesDiv = document.getElementById('messages');
    if (messagesDiv) {
        showMessage(messagesDiv, `Error initializing app: ${err.message}`, 'error');
    }
}