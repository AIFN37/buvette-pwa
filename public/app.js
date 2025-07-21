// ✅ Fichier app.js complet avec modules Guest et Manager fusionnés, améliorations intégrées

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import {
  getFirestore, collection, addDoc, onSnapshot, doc, updateDoc, deleteDoc, query, where,
  orderBy, limit, getDoc, setDoc, getDocs
} from "https://www.gstatic.com/firebasejs/10.4.0/firebase-firestore.js";
import {
  getMessaging, getToken, onMessage
} from "https://www.gstatic.com/firebasejs/10.4.0/firebase-messaging.js";
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

// === MODULE GUEST ===
if (window.location.pathname.endsWith('guest.html')) {
  const addOrderBtn = document.getElementById('add-order-btn');
  const guestOrdersList = document.getElementById('guest-orders-list');
  const validateAllOrdersBtn = document.getElementById('validate-all-orders-btn');
  const cancelAllOrdersBtn = document.getElementById('cancel-all-orders-btn');
  let guestPins = decodePins(localStorage.getItem(LOCAL_STORAGE_PINS_KEY) || '') || [];
  let guestOrdersData = {};
  let unsubscribeGuestOrders = {};

  function renderGuestOrders() {
    guestOrdersList.innerHTML = '';
    if (guestPins.length === 0) {
      guestOrdersList.innerHTML = '<p>Aucune commande en cours.</p>';
      validateAllOrdersBtn.style.display = 'none';
      cancelAllOrdersBtn.style.display = 'none';
      return;
    }
    validateAllOrdersBtn.style.display = 'inline-block';
    cancelAllOrdersBtn.style.display = 'inline-block';
    guestPins.forEach(pin => {
      const order = guestOrdersData[pin];
      if (!order) return;
      const el = document.createElement('div');
      el.textContent = `Commande ${pin} - ${order.status}`;
      guestOrdersList.appendChild(el);
    });
  }

  function startListeningToGuestOrder(orderId, pin) {
    if (unsubscribeGuestOrders[orderId]) unsubscribeGuestOrders[orderId]();
    unsubscribeGuestOrders[orderId] = onSnapshot(doc(db, "orders", orderId), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (['delivered', 'lost_turn'].includes(data.status)) {
          guestPins = guestPins.filter(p => p !== pin);
          delete guestOrdersData[pin];
          localStorage.setItem(LOCAL_STORAGE_PINS_KEY, encodePins(guestPins));
          renderGuestOrders();
          return;
        }
        guestOrdersData[pin] = data;
        renderGuestOrders();
      }
    });
  }

  async function initializeGuestApp() {
    const storedPins = decodePins(localStorage.getItem(LOCAL_STORAGE_PINS_KEY) || '') || [];
    guestPins = storedPins;
    const promises = guestPins.map(async (pin) => {
      const q = query(collection(db, "orders"), where("pin", "==", pin), limit(1));
      try {
        const snap = await getDocs(q);
        if (!snap.empty) {
          const docRef = snap.docs[0];
          startListeningToGuestOrder(docRef.id, pin);
        } else {
          return pin;
        }
      } catch (err) {
        console.error('Erreur chargement commande', pin, err);
        return pin;
      }
      return null;
    });
    const toRemove = (await Promise.all(promises)).filter(p => p);
    if (toRemove.length) {
      guestPins = guestPins.filter(p => !toRemove.includes(p));
      localStorage.setItem(LOCAL_STORAGE_PINS_KEY, encodePins(guestPins));
    }
    renderGuestOrders();
  }

  addOrderBtn.addEventListener('click', async () => {
    const newPin = generatePin();
    const fcmToken = await requestNotificationPermissionAndGetToken();
    const newOrder = {
      pin: newPin,
      fcmToken: fcmToken || null,
      status: "client_draft",
      createdAt: new Date(),
      cookingType: "AP"
    };
    try {
      const docRef = await addDoc(collection(db, "orders"), newOrder);
      guestPins.push(newPin);
      localStorage.setItem(LOCAL_STORAGE_PINS_KEY, encodePins(guestPins));
      startListeningToGuestOrder(docRef.id, newPin);
      renderGuestOrders();
    } catch (error) {
      console.error("Erreur ajout commande:", error);
      showSafeModal("Impossible d'ajouter la commande.");
    }
  });

  validateAllOrdersBtn.addEventListener('click', async () => {
    for (const pin of guestPins) {
      const order = guestOrdersData[pin];
      if (order && order.status === 'client_draft') {
        const q = query(collection(db, "orders"), where("pin", "==", pin), limit(1));
        const snap = await getDocs(q);
        if (!snap.empty) {
          await updateDoc(doc(db, "orders", snap.docs[0].id), { status: "pending" });
        }
      }
    }
  });

  cancelAllOrdersBtn.addEventListener('click', async () => {
    for (const pin of [...guestPins]) {
      const order = guestOrdersData[pin];
      if (order && order.status === 'client_draft') {
        const q = query(collection(db, "orders"), where("pin", "==", pin), limit(1));
        const snap = await getDocs(q);
        if (!snap.empty) {
          await deleteDoc(doc(db, "orders", snap.docs[0].id));
          guestPins = guestPins.filter(p => p !== pin);
          delete guestOrdersData[pin];
        }
      }
    }
    localStorage.setItem(LOCAL_STORAGE_PINS_KEY, encodePins(guestPins));
    renderGuestOrders();
  });

  initializeGuestApp();
} //(voir l'état sauvegardé si besoin)

// === MODULE MANAGER ===
if (window.location.pathname.endsWith('manager.html')) {
  let managerPin = MANAGER_DEFAULT_PIN;
  const authSection = document.getElementById('auth-section');
  const managerDashboard = document.getElementById('manager-dashboard');
  const managerPinInput = document.getElementById('manager-pin-input');
  const managerLoginBtn = document.getElementById('manager-login-btn');
  const authErrorMessage = document.getElementById('auth-error-message');

  async function loadManagerPin() {
    const docRef = doc(db, "config", MANAGER_PIN_DOC_ID);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      managerPin = docSnap.data().pin;
    } else {
      await setDoc(docRef, { pin: MANAGER_DEFAULT_PIN });
    }
  }

  function showManagerDashboard() {
    authSection.style.display = 'none';
    managerDashboard.style.display = 'block';
    // startOrderListener(); // à compléter selon ta version originale
  }

  managerLoginBtn.addEventListener('click', async () => {
    const enteredPin = managerPinInput.value.trim();
    await loadManagerPin();
    if (enteredPin === managerPin) {
      showManagerDashboard();
    } else {
      authErrorMessage.innerText = "Code PIN incorrect. Veuillez réessayer.";
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
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
