import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import {
    getFirestore, collection, addDoc, onSnapshot, doc, updateDoc, deleteDoc, query, where,
    orderBy, limit, getDoc, setDoc, getDocs
} from "https://www.gstatic.com/firebasejs/10.4.0/firebase-firestore.js";
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-messaging.js";
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const messaging = getMessaging(app);

const MANAGER_PIN_DOC_ID = "managerPinConfig";
const MANAGER_DEFAULT_PIN = "1234";
const RELANCE_INTERVAL_MS = 30 * 1000;
const MAX_RELANCES = 3;
const LOCAL_STORAGE_PINS_KEY = 'buvettePwaGuestPins';

function generatePin() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 4; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

async function requestNotificationPermissionAndGetToken() {
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            const token = await getToken(messaging, {
                vapidKey: 'BOfarRrQ23arrM__eUBYL4RcP_wJDiP6gMRX8hqxwk8K4SeN1mSYqIplsq4nm0lXcMnJjHED6HSHB_J2iovTgAY'
            });
            return token;
        } else {
            return null;
        }
    } catch (error) {
        console.error('Erreur FCM :', error);
        return null;
    }
}

function playNotificationSound() {
    const audio = new Audio('/sounds/notification.mp3');
    audio.play().catch(e => console.error("Erreur lecture son :", e));
}

onMessage(messaging, (payload) => {
    const { title, body } = payload.notification;
    new Notification(title, { body, icon: '/images/icon-192x192.png' });
    playNotificationSound();
    if (window.location.pathname.endsWith('guest.html')) {
        initializeGuestApp();
    }
});

function encodePins(pins) {
    return btoa(JSON.stringify(pins));
}

function decodePins(encoded) {
    try {
        return JSON.parse(atob(encoded));
    } catch (e) {
        return [];
    }
}

function showSafeModal(message, onConfirm = () => {}, onCancel = null) {
    const confirmationModal = document.getElementById('confirmation-modal');
    const modalMessage = document.getElementById('modal-message');
    const modalConfirmBtn = document.getElementById('modal-confirm-btn');
    const modalCancelBtn = document.getElementById('modal-cancel-btn');

    if (!confirmationModal || !modalMessage || !modalConfirmBtn) {
        alert(message);
        onConfirm();
        return;
    }

    modalMessage.innerText = message;
    confirmationModal.style.display = 'flex';

    const confirmListener = () => {
        confirmationModal.style.display = 'none';
        modalConfirmBtn.removeEventListener('click', confirmListener);
        modalCancelBtn?.removeEventListener('click', cancelListener);
        onConfirm();
    };

    const cancelListener = () => {
        confirmationModal.style.display = 'none';
        modalConfirmBtn.removeEventListener('click', confirmListener);
        modalCancelBtn?.removeEventListener('click', cancelListener);
        if (onCancel) onCancel();
    };

    modalConfirmBtn.addEventListener('click', confirmListener);
    if (modalCancelBtn) modalCancelBtn.addEventListener('click', cancelListener);
}

if (window.location.pathname.endsWith('manager.html')) {
    document.addEventListener('DOMContentLoaded', () => {
        const managerPinInput = document.getElementById('manager-pin-input');
        const managerLoginBtn = document.getElementById('manager-login-btn');

        if (managerPinInput && managerLoginBtn) {
            managerPinInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    managerLoginBtn.click();
                }
            });
        }
    });
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/firebase-messaging-sw.js')
            .then(reg => console.log('Service Worker enregistré :', reg))
            .catch(err => console.error('Erreur enregistrement SW :', err));
    });
}
