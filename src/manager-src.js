import { startNodePromise, createRedirect, getLocalRedirects, deleteRedirect, verifyRedirectPassword } from './p2p.js';

// Дебаг імпорту
console.log('DEBUG: Imports in manager-src.js:', {
    startNodePromise: !!startNodePromise,
    createRedirect: typeof createRedirect,
    getLocalRedirects: typeof getLocalRedirects,
    deleteRedirect: typeof deleteRedirect,
    verifyRedirectPassword: typeof verifyRedirectPassword,
    windowObject: typeof window,
    exportsObject: typeof exports
});

// Захешаний пароль
const MANAGER_PASSWORD_HASH = "0fc3eacd461c5c008aff6e351c44a57f:043b63104b06d8aa5584a5180542c50c551966958ef8be9f34d8e476494d8f00";

// Показує повідомлення в UI
function showMessage(messagesDiv, text, type = 'info') {
    console.log('DEBUG: Showing message:', text, 'Type:', type);
    const alertClass = type === 'error' ? 'alert-danger' : (type === 'success' ? 'alert-success' : 'alert-info');
    messagesDiv.innerHTML = `<div class="alert ${alertClass}">${text}</div>`;
    if (type !== 'error') setTimeout(() => messagesDiv.innerHTML = '', 5000);
}

// Показує спливаюче вікно з паролем редиректу
function showPasswordPopup(shortCode, password) {
    console.log('DEBUG: Showing password popup for:', shortCode);
    const popup = document.createElement("div");
    popup.style.position = "fixed";
    popup.style.top = "10px";
    popup.style.left = "50%";
    popup.style.transform = "translateX(-50%)";
    popup.style.backgroundColor = "#4CAF50";
    popup.style.color = "white";
    popup.style.padding = "15px";
    popup.style.borderRadius = "5px";
    popup.style.zIndex = "1000";
    popup.innerHTML = `
        <strong>Redirect /r/${shortCode} created!</strong><br>
        Password: <strong>${password}</strong><br>
        <small>(This will disappear in 20 seconds)</small>
    `;
    document.body.appendChild(popup);
    setTimeout(() => document.body.removeChild(popup), 20000);
}

// Блокує інтерактивні елементи
function disableInteractions(addForm, searchForm) {
    console.log('DEBUG: Disabling interactions');
    if (addForm) addForm.style.pointerEvents = 'none';
    if (searchForm) searchForm.style.pointerEvents = 'none';
    document.querySelectorAll('.delete-btn').forEach(btn => btn.disabled = true);
    document.querySelectorAll('.btn-warning').forEach(btn => btn.style.pointerEvents = 'none');
}

// Завантажує редиректи
async function loadRedirects(redirectsBody, searchQuery = "") {
    console.log('DEBUG: Loading redirects with query:', searchQuery);
    try {
        const redirects = await getLocalRedirects(searchQuery);
        redirectsBody.innerHTML = "";
        if (redirects.length === 0) {
            redirectsBody.innerHTML = `<tr><td colspan="4">No redirects found</td></tr>`;
            return;
        }
        redirects.forEach(r => {
            const row = document.createElement("tr");
            row.innerHTML = `
                <td><a href="/redirect.html?code=${r.shortCode}" target="_blank">/r/${r.shortCode}</a></td>
                <td>${r.destinationUrl}</td>
                <td>${r.description || ""}</td>
                <td>
                    <a href="/edit-redirect.html?code=${r.shortCode}" class="btn btn-warning btn-sm">Edit</a>
                    <button class="btn btn-danger btn-sm delete-btn" data-shortcode="${r.shortCode}">Delete</button>
                </td>
            `;
            redirectsBody.appendChild(row);
        });
    } catch (err) {
        console.error('DEBUG: Error loading redirects:', err);
        throw err;
    }
}

// Перевірка пароля
async function verifyManagerPassword(enteredPassword) {
    console.log('DEBUG: Attempting to verify manager password');
    try {
        const isValidPassword = await verifyRedirectPassword(enteredPassword, MANAGER_PASSWORD_HASH);
        console.log('DEBUG: Password verification result:', isValidPassword);
        return isValidPassword;
    } catch (err) {
        console.error('DEBUG: Error in verifyRedirectPassword:', err);
        throw err;
    }
}

// Ініціалізація менеджера
async function initializeManager() {
    console.log('DEBUG: Initializing manager');
    const addForm = document.getElementById("add-redirect-form");
    const searchForm = document.getElementById("search-form");
    const redirectsBody = document.getElementById("redirects-body");
    const messagesDiv = document.getElementById("messages");
    const p2pStatusDiv = document.getElementById("p2p-status");

    if (!addForm || !searchForm || !redirectsBody || !messagesDiv || !p2pStatusDiv) {
        console.error('DEBUG: Missing DOM elements:', {
            addForm: !!addForm,
            searchForm: !!searchForm,
            redirectsBody: !!redirectsBody,
            messagesDiv: !!messagesDiv,
            p2pStatusDiv: !!p2pStatusDiv
        });
        if (messagesDiv) showMessage(messagesDiv, 'Error: Page elements not found', 'error');
        return;
    }

    // Запускаємо синхронізацію
    console.log('DEBUG: Starting P2P synchronization');
    let isNetworkConnected = false;
    try {
        await startNodePromise;
        console.log('DEBUG: P2P node initialized');
        isNetworkConnected = true;
        p2pStatusDiv.textContent = 'P2P Status: Connected';
    } catch (err) {
        console.error('DEBUG: Error initializing P2P:', err);
        p2pStatusDiv.textContent = 'P2P Status: No network connection. Using local mode.';
        showMessage(messagesDiv, `Error initializing P2P: ${err.message}`, 'error');
    }

    // Завантажуємо редиректи
    try {
        await loadRedirects(redirectsBody);
        if (isNetworkConnected) {
            setInterval(() => loadRedirects(redirectsBody), 5000); // Оновлення кожні 5 секунд
        }
    } catch (err) {
        console.error('DEBUG: Error loading initial redirects:', err);
        showMessage(messagesDiv, `Error loading redirects: ${err.message}`, 'error');
    }

    // Запитуємо пароль
    let isAuthenticated = false;
    const enteredPassword = prompt("Enter the manager password:");
    if (!enteredPassword) {
        showMessage(messagesDiv, "No password provided. Access restricted.", 'error');
        disableInteractions(addForm, searchForm);
    } else {
        try {
            isAuthenticated = await verifyManagerPassword(enteredPassword);
            if (!isAuthenticated) {
                showMessage(messagesDiv, "Incorrect password. Access restricted.", 'error');
                disableInteractions(addForm, searchForm);
            } else {
                showMessage(messagesDiv, "Authentication successful!", 'success');
            }
        } catch (err) {
            showMessage(messagesDiv, "Error verifying password. Access restricted.", 'error');
            disableInteractions(addForm, searchForm);
        }
    }

    // Додаємо обробники подій тільки якщо аутентифіковано
    if (isAuthenticated) {
        console.log('DEBUG: Attaching event listeners');
        addForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            console.log('DEBUG: Handling add redirect form submit');
            const destinationUrl = document.getElementById("destination_url").value.trim();
            const description = document.getElementById("description").value.trim();
            try {
                const { shortCode, password } = await createRedirect(destinationUrl, description);
                showMessage(messagesDiv, `Redirect /r/${shortCode} created`, 'success');
                showPasswordPopup(shortCode, password);
                await loadRedirects(redirectsBody);
                addForm.reset();
            } catch (err) {
                console.error('DEBUG: Error creating redirect:', err);
                showMessage(messagesDiv, `Error: ${err.message}`, 'error');
            }
        });

        searchForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            console.log('DEBUG: Handling search form submit');
            const searchQuery = document.getElementById("search").value.trim();
            try {
                await loadRedirects(redirectsBody, searchQuery);
            } catch (err) {
                console.error('DEBUG: Error searching redirects:', err);
                showMessage(messagesDiv, `Error searching redirects: ${err.message}`, 'error');
            }
        });

        // Обробник для кнопок видалення
        redirectsBody.addEventListener("click", async (e) => {
            if (e.target.classList.contains("delete-btn")) {
                console.log('DEBUG: Handling delete button click');
                const shortCode = e.target.getAttribute("data-shortcode");
                const password = prompt(`Enter the password for /r/${shortCode} to delete:`);
                if (!password) {
                    showMessage(messagesDiv, "No password provided. Deletion cancelled.", 'error');
                    return;
                }
                try {
                    await deleteRedirect(shortCode, password);
                    showMessage(messagesDiv, `Redirect /r/${shortCode} deleted`, 'success');
                    await loadRedirects(redirectsBody);
                } catch (err) {
                    console.error('DEBUG: Error deleting redirect:', err);
                    showMessage(messagesDiv, `Error: ${err.message}`, 'error');
                }
            }
        });
    }
}

// Експортуємо функції для використання в інших модулях
export {
    verifyManagerPassword,
    initializeManager
};

// Запускаємо ініціалізацію
try {
    initializeManager();
} catch (err) {
    console.error('DEBUG: Error initializing manager:', err);
    const messagesDiv = document.getElementById("messages");
    if (messagesDiv) {
        showMessage(messagesDiv, `Error initializing manager: ${err.message}`, 'error');
    }
}