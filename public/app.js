import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { getFirestore, collection, addDoc, onSnapshot, doc, updateDoc, deleteDoc, query, where, orderBy, limit, getDoc, setDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-firestore.js";
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-messaging.js";
import { firebaseConfig } from './firebase-config.js'; // Chemin corrigé si firebase-config.js est dans le dossier public

// --- Initialisation Firebase ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const messaging = getMessaging(app);

// --- Constantes de Configuration (AJUSTEZ CELLES-CI SI BESOIN) ---
const MANAGER_PIN_DOC_ID = "managerPinConfig"; // Document ID pour le PIN Manager dans Firestore
const MANAGER_DEFAULT_PIN = "1234"; // PIN par défaut si non trouvé dans Firestore (À CHANGER EN PRODUCTION !)
const RELANCE_INTERVAL_MS = 30 * 1000; // 30 secondes
const MAX_RELANCES = 3; // 3 relances = 90 secondes avant perte de tour
const LOCAL_STORAGE_PINS_KEY = 'buvettePwaGuestPins'; // Clé pour stocker un tableau de PINs dans le localStorage du Guest

// --- Fonctions Utilitaires Générales ---

/**
 * Génère un PIN alphanumérique de 4 caractères.
 * @returns {string} Le PIN généré.
 */
function generatePin() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 4; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

/**
 * Demande la permission de notification et obtient le jeton FCM de l'appareil.
 * @returns {Promise<string|null>} Le jeton FCM si la permission est accordée, sinon null.
 */
async function requestNotificationPermissionAndGetToken() {
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            console.log('Permission de notification accordée.');
            // REMPLACEZ 'VOTRE_CLE_VAPID_PUBLIQUE' PAR VOTRE VRAIE CLÉ VAPID PUBLIQUE DEPUIS LA CONSOLE FIREBASE !
            // Exemple: const token = await getToken(messaging, { vapidKey: 'BOfarRrQ23arrM__eUBYL4RcP_wJDiP6gMRX8hqxwk8K4SeN1mSYqIplsq4nm0lXcMnJjHED6HSHB_J2iovTgAY' });
            const token = await getToken(messaging, { vapidKey: 'BOfarRrQ23arrM__eUBYL4RcP_wJDiP6gMRX8hqxwk8K4SeN1mSYqIplsq4nm0lXcMnJjHED6HSHB_J2iovTgAY' });
            console.log('Jeton FCM :', token);
            return token;
        } else {
            console.warn('Permission de notification refusée.');
            return null;
        }
    } catch (error) {
        console.error('Erreur lors de la demande de permission de notification ou de l\'obtention du jeton FCM :', error);
        return null;
    }
}

/**
 * Joue un son de notification.
 */
function playNotificationSound() {
    const audio = new Audio('/sounds/notification.mp3'); // Assurez-vous que ce fichier existe
    audio.play().catch(e => console.error("Erreur lecture son :", e));
}

// Écoute des messages FCM en premier plan (quand la PWA est ouverte et en focus)
onMessage(messaging, (payload) => {
    console.log('Message FCM reçu en premier plan :', payload);

    // Afficher la notification native du navigateur
    const notificationTitle = payload.notification.title;
    const notificationOptions = {
        body: payload.notification.body,
        icon: '/images/icon-192x192.png' // Assurez-vous d'avoir cette icône
    };
    new Notification(notificationTitle, notificationOptions);

    // Jouer le son
    playNotificationSound();

    // Mettre à jour l'interface du Guest si c'est la page active et que le PIN correspond
    if (window.location.pathname.endsWith('guest.html')) {
        // Déclenche une mise à jour complète de la liste des commandes du Guest
        // Cela va re-rendre toutes les commandes et mettre à jour les statuts/comptes à rebours
        initializeGuestApp();
    }
});

// --- Logique du module GUEST ---
if (window.location.pathname.endsWith('guest.html')) {
    // NOUVEAUX ÉLÉMENTS DOM POUR LE GUEST (selon guest.html refactorisé)
    const pinInputSection = document.getElementById('pin-input-section');
    const guestPinInput = document.getElementById('guest-pin-input');
    const addPinBtn = document.getElementById('add-pin-btn');
    const pinErrorMessage = document.getElementById('pin-error-message');
    const guestOrdersDisplay = document.getElementById('guest-orders-display');
    const guestOrdersList = document.getElementById('guest-orders-list');
    const clearAllPinsBtn = document.getElementById('clear-all-pins-btn');

    // MODAL ELEMENTS - Déclarées en const car ce sont des références fixes aux éléments DOM
    const confirmationModal = document.getElementById('confirmation-modal');
    const modalMessage = document.getElementById('modal-message');
    const modalConfirmBtn = document.getElementById('modal-confirm-btn');
    const modalCancelBtn = document.getElementById('modal-cancel-btn');

    // Variables pour stocker les callbacks actuels de la modale
    let currentOnConfirmCallback = null;
    let currentOnCancelCallback = null;

    let guestPins = []; // Tableau pour stocker les PINs du client
    let guestOrdersData = {}; // Objet pour stocker les données complètes des commandes par PIN
    let unsubscribeGuestOrders = {}; // Objet pour stocker les fonctions de désabonnement par PIN
    let countdownIntervals = {}; // Objet pour stocker les intervalles de compte à rebours par PIN

    // Mappage des abréviations de cuisson aux noms complets et classes CSS
    const cookingTypesMap = {
        'BC': { name: 'Bien Cuit', class: 'bc' },
        'AP': { name: 'À Point', class: 'ap' },
        'S': { name: 'Saignant', class: 's' },
        'B': { name: 'Bleu', class: 'b' }
    };

    /**
     * Gère le clic sur le bouton Confirmer de la modale.
     */
    function handleConfirmClick() {
        console.log("handleConfirmClick triggered."); // Debug log
        confirmationModal.style.display = 'none';
        if (currentOnConfirmCallback) {
            currentOnConfirmCallback();
        }
        // Réinitialise les callbacks après exécution
        currentOnConfirmCallback = null;
        currentOnCancelCallback = null;
    }

    /**
     * Gère le clic sur le bouton Annuler de la modale.
     */
    function handleCancelClick() {
        console.log("handleCancelClick triggered."); // Debug log
        confirmationModal.style.display = 'none';
        if (currentOnCancelCallback) {
            currentOnCancelCallback();
        }
        // Réinitialise les callbacks après exécution
        currentOnConfirmCallback = null;
        currentOnCancelCallback = null;
    }

    // Attache les écouteurs d'événements aux boutons de la modale une seule fois au chargement du script
    // Ces écouteurs resteront actifs et appelleront les callbacks stockés dans currentOnConfirmCallback/currentOnCancelCallback
    if (modalConfirmBtn && modalCancelBtn) {
        modalConfirmBtn.addEventListener('click', handleConfirmClick);
        modalCancelBtn.addEventListener('click', handleCancelClick);
        console.log("Modal listeners attached globally.");
    } else {
        console.error("Un ou plusieurs boutons de la modale (confirmer/annuler) n'ont pas été trouvés. Impossible d'attacher les écouteurs.");
    }


    /**
     * Affiche la modale de confirmation et gère les actions.
     * @param {string} message - Le message à afficher dans la modale.
     * @param {Function} onConfirmCallback - La fonction à exécuter si l'utilisateur confirme.
     * @param {Function} [onCancelCallback] - La fonction à exécuter si l'utilisateur annule (optionnel).
     */
    function showConfirmationModal(message, onConfirmCallback, onCancelCallback = () => {}) {
        modalMessage.innerText = message;
        confirmationModal.style.display = 'flex'; // Affiche la modale

        console.log("Modal affichée. Attente d'interaction..."); // Debug log

        // Stocke les callbacks pour les gestionnaires globaux
        currentOnConfirmCallback = onConfirmCallback;
        currentOnCancelCallback = onCancelCallback;
    }


    /**
     * Rend la liste des commandes du Guest dans l'interface utilisateur.
     */
    function renderGuestOrders() {
        guestOrdersList.innerHTML = ''; // Nettoie la liste

        if (guestPins.length === 0) {
            guestOrdersList.innerHTML = '<p>Aucune commande ajoutée pour le moment.</p>';
            guestOrdersDisplay.style.display = 'none'; // Cache la section d'affichage complète
            return;
        }

        guestOrdersDisplay.style.display = 'block'; // Affiche la section d'affichage

        // Tri des commandes pour l'affichage (les commandes actives d'abord, par createdAt)
        const sortedOrders = Object.values(guestOrdersData).sort((a, b) => {
            // Ordre des statuts actifs
            const statusOrder = { 'client_draft': 1, 'pending': 2, 'ready': 3, 'relance': 4, 'delivered': 5, 'lost_turn': 6 };
            const statusA = statusOrder[a.status] || 99;
            const statusB = statusOrder[b.status] || 99;

            if (statusA !== statusB) {
                return statusA - statusB;
            }
            // Si les statuts sont identiques, trier par createdAt
            const aTime = a.createdAt ? (a.createdAt.toDate ? a.createdAt.toDate().getTime() : a.createdAt) : 0;
            const bTime = b.createdAt ? (b.createdAt.toDate ? b.createdAt.toDate().getTime() : b.createdAt) : 0;
            return aTime - bTime;
        });


        sortedOrders.forEach(order => {
            const orderItem = document.createElement('div');
            orderItem.classList.add('guest-order-item'); // Classe pour le style
            orderItem.dataset.pin = order.pin; // Stocke le PIN comme attribut de données

            const cookingInfo = cookingTypesMap[order.cookingType] || { name: 'Inconnu', class: '' };

            let statusText = '';
            let statusClass = '';
            let countdownHtml = ''; // Pour le compte à rebours
            const lastUpdateTimestamp = order.createdAt ? new Date(order.createdAt.toDate ? order.createdAt.toDate() : order.createdAt).toLocaleString() : 'N/A';


            if (order.status === 'client_draft') {
                statusText = 'Brouillon';
                statusClass = 'client-draft';
            } else if (order.status === 'pending') {
                statusText = 'En préparation...';
                statusClass = 'pending';
            } else if (order.status === 'ready') {
                statusText = 'PRÊT !';
                statusClass = 'ready';
                countdownHtml = `<span class="countdown-timer" id="countdown-${order.pin}"></span>`;
                startCountdown(order.pin, order.readyTimestamp); // Démarre/met à jour le compte à rebours
            } else if (order.status === 'relance') {
                statusText = 'Dépêchez-vous !';
                statusClass = 'relance';
                countdownHtml = `<span class="countdown-timer" id="countdown-${order.pin}"></span>`;
                startCountdown(order.pin, order.readyTimestamp); // Démarre/met à jour le compte à rebours
            } else if (order.status === 'delivered') {
                statusText = 'Livré. Merci !';
                statusClass = 'delivered';
                stopCountdown(order.pin); // Arrête le compte à rebours si livré
            } else if (order.status === 'lost_turn') {
                statusText = 'Tour perdu !';
                statusClass = 'lost-turn';
                stopCountdown(order.pin); // Arrête le compte à rebours si tour perdu
            }

            // Structure comme décrit : PIN (2 lignes), Cuisson, Statut + Timestamp, Compte à rebours
            orderItem.innerHTML = `
                <div class="order-grid">
                    <div class="pin-cell">
                        <span class="pin-display-large">${order.pin}</span>
                    </div>
                    <div class="cooking-cell">
                        <span class="cooking-type ${cookingInfo.class}">${cookingInfo.name}</span>
                    </div>
                    <div class="status-cell">
                        <span class="status-message ${statusClass}">${statusText}</span>
                        <span class="timestamp-small">MàJ: ${lastUpdateTimestamp}</span>
                    </div>
                    <div class="countdown-cell">
                        ${countdownHtml}
                    </div>
                </div>
            `;
            guestOrdersList.appendChild(orderItem);
        });
    }

    /**
     * Démarre le compte à rebours pour une commande spécifique.
     * @param {string} pin - Le PIN de la commande.
     * @param {object} readyTimestamp - Le timestamp Firestore (ou ms) quand la commande est devenue prête.
     */
    function startCountdown(pin, readyTimestamp) {
        // Efface tout intervalle existant pour ce PIN
        if (countdownIntervals[pin]) {
            clearInterval(countdownIntervals[pin]);
        }

        const startTime = readyTimestamp.toMillis ? readyTimestamp.toMillis() : readyTimestamp; // Gère les timestamps Firebase

        countdownIntervals[pin] = setInterval(() => {
            const now = Date.now();
            const elapsed = now - startTime;
            const remaining = Math.max(0, (RELANCE_INTERVAL_MS * MAX_RELANCES) - elapsed);

            const seconds = Math.floor(remaining / 1000);
            const countdownElement = document.getElementById(`countdown-${pin}`);

            if (countdownElement) {
                countdownElement.innerText = `${seconds}s`;
                if (seconds <= 0) {
                    stopCountdown(pin);
                    // La fonction Cloud gérera le changement de statut vers 'lost_turn'
                }
            } else {
                // Élément non trouvé, arrête l'intervalle pour éviter les fuites de mémoire
                stopCountdown(pin);
            }
        }, 1000);
    }

    /**
     * Arrête le compte à rebours pour un PIN donné.
     * @param {string} pin - Le PIN de la commande.
     */
    function stopCountdown(pin) {
        if (countdownIntervals[pin]) {
            clearInterval(countdownIntervals[pin]);
            delete countdownIntervals[pin];
        }
    }

    /**
     * Gère l'ajout d'un PIN par le client.
     */
    addPinBtn.addEventListener('click', async () => {
        const pin = guestPinInput.value.trim().toUpperCase();
        pinErrorMessage.innerText = ''; // Efface les erreurs précédentes

        if (pin.length !== 4) {
            pinErrorMessage.innerText = 'Le PIN doit contenir 4 caractères.';
            return;
        }

        if (guestPins.includes(pin)) {
            pinErrorMessage.innerText = 'Ce PIN est déjà suivi sur cet appareil.';
            return;
        }

        // Vérifier si le PIN existe dans Firestore
        const q = query(collection(db, "orders"), where("pin", "==", pin), limit(1));
        try {
            const querySnapshot = await getDocs(q);
            if (querySnapshot.empty) {
                pinErrorMessage.innerText = 'PIN non trouvé. Veuillez vérifier.';
                return;
            }

            const docSnapshot = querySnapshot.docs[0];
            const orderId = docSnapshot.id;

            // Ajouter le PIN à la liste locale et le sauvegarder
            guestPins.push(pin);
            localStorage.setItem(LOCAL_STORAGE_PINS_KEY, JSON.stringify(guestPins));

            // Démarrer l'écoute pour cette nouvelle commande
            startListeningToGuestOrder(orderId, pin);

            guestPinInput.value = ''; // Efface l'entrée
            renderGuestOrders(); // Met à jour l'affichage
            requestNotificationPermissionAndGetToken(); // Demande les permissions si ce n'est pas déjà fait
        } catch (error) {
            console.error("Erreur lors de la vérification du PIN :", error);
            showConfirmationModal("Erreur lors de la vérification du PIN. Veuillez réessayer.", () => {}, () => { window.location.href = 'index.html'; });
        }
    });

    /**
     * Gère le nettoyage de tous les PINs suivis par le client.
     */
    clearAllPinsBtn.addEventListener('click', () => {
        if (guestPins.length === 0) {
            showConfirmationModal("Aucun PIN à nettoyer.", () => {});
            return;
        }

        showConfirmationModal("Voulez-vous vraiment effacer tous les PINs suivis sur cet appareil ?", () => {
            // Désabonner toutes les écoutes Firestore
            for (const orderId in unsubscribeGuestOrders) {
                if (unsubscribeGuestOrders[orderId]) {
                    unsubscribeGuestOrders[orderId]();
                }
            }
            unsubscribeGuestOrders = {}; // Réinitialise l'objet

            // Arrêter tous les comptes à rebours
            for (const pin in countdownIntervals) {
                stopCountdown(pin);
            }
            countdownIntervals = {}; // Réinitialise l'objet

            guestPins = []; // Vide le tableau de PINs
            guestOrdersData = {}; // Vide les données des commandes
            localStorage.removeItem(LOCAL_STORAGE_PINS_KEY); // Supprime du localStorage

            renderGuestOrders(); // Met à jour l'affichage (devrait afficher "Aucune commande...")
            console.log("Tous les PINs et données locales du Guest ont été nettoyés.");
        });
    });


    /**
     * Démarre l'écoute Firestore pour une commande spécifique du Guest.
     * @param {string} orderId - L'ID du document Firestore.
     * @param {string} pin - Le PIN de la commande.
     */
    function startListeningToGuestOrder(orderId, pin) {
        // Si une écoute existe déjà pour cet ID, la désabonner d'abord
        if (unsubscribeGuestOrders[orderId]) {
            unsubscribeGuestOrders[orderId]();
        }

        unsubscribeGuestOrders[orderId] = onSnapshot(doc(db, "orders", orderId), (docSnapshot) => {
            if (docSnapshot.exists()) {
                const orderData = docSnapshot.data();
                guestOrdersData[pin] = { ...orderData, id: docSnapshot.id }; // Stocke les données complètes avec l'ID
                renderGuestOrders(); // Re-rend la liste entière avec les données mises à jour
            } else {
                // La commande a été supprimée de Firestore (par exemple, par le Manager ou une annulation)
                console.log(`Commande ${pin} (${orderId}) n'existe plus dans Firestore.`);
                guestPins = guestPins.filter(p => p !== pin); // Supprime le PIN de la liste locale
                localStorage.setItem(LOCAL_STORAGE_PINS_KEY, JSON.stringify(guestPins));
                delete guestOrdersData[pin]; // Supprime les données de l'objet local
                stopCountdown(pin); // Arrête le compte à rebours associé
                renderGuestOrders(); // Met à jour l'affichage
            }
        }, (error) => {
            console.error(`Erreur lors de l'écoute de la commande ${pin} (${orderId}) :`, error);
            showConfirmationModal("Erreur de connexion à une commande. Veuillez réessayer.", () => {}, () => { window.location.href = 'index.html'; });
        });
    }

    /**
     * Initialise l'application Guest : charge les PINs stockés et démarre les écoutes Firestore.
     */
    async function initializeGuestApp() {
        // Récupère les PINs stockés
        const storedPins = JSON.parse(localStorage.getItem(LOCAL_STORAGE_PINS_KEY) || '[]');
        guestPins = storedPins; // Met à jour la liste globale des PINs

        // Pour chaque PIN, démarre une écoute Firestore
        // Utilise Promise.all pour attendre que toutes les requêtes soient terminées
        const promises = guestPins.map(async (pin) => {
            const q = query(collection(db, "orders"), where("pin", "==", pin), limit(1));
            try {
                const querySnapshot = await getDocs(q); // Utilise getDocs pour une requête ponctuelle
                if (!querySnapshot.empty) {
                    const docSnapshot = querySnapshot.docs[0];
                    startListeningToGuestOrder(docSnapshot.id, pin);
                } else {
                    console.warn(`PIN ${pin} trouvé dans localStorage mais pas de commande correspondante dans Firestore. Suppression.`);
                    return pin; // Retourne le PIN pour le filtrer plus tard
                }
            } catch (error) {
                console.error(`Erreur lors de la recherche de la commande pour le PIN ${pin}:`, error);
                return pin; // Retourne le PIN pour le filtrer en cas d'erreur
            }
            return null; // Pas d'erreur, pas de PIN à filtrer
        });

        const pinsToRemove = (await Promise.all(promises)).filter(p => p !== null);

        if (pinsToRemove.length > 0) {
            guestPins = guestPins.filter(p => !pinsToRemove.includes(p));
            localStorage.setItem(LOCAL_STORAGE_PINS_KEY, JSON.stringify(guestPins));
        }

        renderGuestOrders(); // Rend la liste initiale (peut être vide)
    }

    // Lancer l'initialisation de l'application Guest au chargement de la page
    initializeGuestApp();
}

// --- Logique du module MANAGER ---
if (window.location.pathname.endsWith('manager.html')) {
    // Nouveaux éléments DOM pour le Manager (à ajouter dans manager.html)
    const createOrderSection = document.getElementById('create-order-section');
    const newPinDisplay = document.getElementById('new-pin-display');
    const generatePinBtn = document.getElementById('generate-pin-btn');
    const cookingTypeRadios = document.querySelectorAll('input[name="cookingType"]');
    const createOrderBtn = document.getElementById('create-order-btn');
    const managerOrderCreationMessage = document.getElementById('manager-order-creation-message');


    const authSection = document.getElementById('auth-section');
    const managerDashboard = document.getElementById('manager-dashboard');
    const managerPinInput = document.getElementById('manager-pin-input');
    const managerLoginBtn = document.getElementById('manager-login-btn');
    const authErrorMessage = document.getElementById('auth-error-message');
    const ordersList = document.getElementById('orders-list');
    const pinSearchInput = document.getElementById('pin-search-input');

    // MODAL ELEMENTS (références globales, mais ajoutées ici pour clarté dans le module Manager)
    const confirmationModal = document.getElementById('confirmation-modal');
    const modalMessage = document.getElementById('modal-message');
    const modalConfirmBtn = document.getElementById('modal-confirm-btn');
    const modalCancelBtn = document.getElementById('modal-cancel-btn');

    // Variables pour stocker les callbacks actuels de la modale (pour le Manager aussi)
    let currentOnConfirmCallback = null;
    let currentOnCancelCallback = null;

    // Fonctions de gestion de la modale (répétées ici pour la clarté, mais pourraient être globales si elles sont les mêmes)
    function handleManagerConfirmClick() {
        console.log("handleManagerConfirmClick triggered.");
        confirmationModal.style.display = 'none';
        if (currentOnConfirmCallback) {
            currentOnConfirmCallback();
        }
        currentOnConfirmCallback = null;
        currentOnCancelCallback = null;
    }

    function handleManagerCancelClick() {
        console.log("handleManagerCancelClick triggered.");
        confirmationModal.style.display = 'none';
        if (currentOnCancelCallback) {
            currentOnCancelCallback();
        }
        currentOnConfirmCallback = null;
        currentOnCancelCallback = null;
    }

    // Attache les écouteurs pour la modale du Manager une seule fois
    if (modalConfirmBtn && modalCancelBtn) {
        modalConfirmBtn.addEventListener('click', handleManagerConfirmClick);
        modalCancelBtn.addEventListener('click', handleManagerCancelClick);
        console.log("Manager Modal listeners attached globally.");
    } else {
        console.error("Un ou plusieurs boutons de la modale du Manager (confirmer/annuler) n'ont pas été trouvés. Impossible d'attacher les écouteurs.");
    }

    // Fonction showConfirmationModal spécifique ou réutilisée (ici, réutilisée)
    function showManagerConfirmationModal(message, onConfirmCallback, onCancelCallback = () => {}) {
        modalMessage.innerText = message;
        confirmationModal.style.display = 'flex';
        currentOnConfirmCallback = onConfirmCallback;
        currentOnCancelCallback = onCancelCallback;
        console.log("Manager Modal affichée. Attente d'interaction...");
    }


    const cookingAbbrMap = {
        'BC': 'Bien Cuit',
        'AP': 'À Point',
        'S': 'Saignant',
        'B': 'Bleu'
    };
    const cookingColorClasses = { // Pour le style CSS
        'BC': 'bc',
        'AP': 'ap',
        'S': 's',
        'B': 'b'
    };

    let managerPin = MANAGER_DEFAULT_PIN; // PIN par défaut, sera mis à jour depuis Firestore
    let allOrders = []; // Nouvelle variable pour stocker toutes les commandes récupérées
    let currentGeneratedPin = null; // Pour stocker le PIN généré pour la nouvelle commande

    /**
     * Charge le PIN Manager depuis Firestore ou le crée s'il n'existe pas.
     */
    async function loadManagerPin() {
        const docRef = doc(db, "config", MANAGER_PIN_DOC_ID);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            managerPin = docSnap.data().pin;
            console.log("PIN Manager chargé depuis Firestore:", managerPin);
        } else {
            // Créer le document avec le PIN par défaut si non trouvé
            await setDoc(docRef, { pin: MANAGER_DEFAULT_PIN });
            console.log("PIN Manager par défaut créé dans Firestore:", MANAGER_DEFAULT_PIN);
        }
    }

    /**
     * Affiche le tableau de bord Manager après authentification.
     */
    function showManagerDashboard() {
        authSection.style.display = 'none';
        managerDashboard.style.display = 'block';
        startOrderListener(); // Démarrer l'écoute des commandes
        // Initialiser la section de création de commande
        if (generatePinBtn) {
            generatePinBtn.addEventListener('click', () => {
                currentGeneratedPin = generatePin();
                newPinDisplay.innerText = currentGeneratedPin;
                createOrderBtn.disabled = false; // Activer le bouton de création
            });
        }
        if (createOrderBtn) {
            createOrderBtn.addEventListener('click', createManagerOrder);
        }
    }

    // Gérer la connexion
    managerLoginBtn.addEventListener('click', async () => {
        await loadManagerPin(); // Assurez-vous d'avoir le PIN à jour
        if (managerPinInput.value === managerPin) {
            showManagerDashboard();
        } else {
            authErrorMessage.innerText = "Code PIN incorrect. Veuillez réessayer.";
        }
    });

    /**
     * Crée une nouvelle commande client depuis le Manager.
     */
    async function createManagerOrder() {
        if (!currentGeneratedPin) {
            managerOrderCreationMessage.innerText = "Veuillez générer un PIN d'abord.";
            return;
        }

        const selectedCookingType = document.querySelector('input[name="cookingType"]:checked');
        if (!selectedCookingType) {
            managerOrderCreationMessage.innerText = "Veuillez sélectionner un mode de cuisson.";
            return;
        }

        const newOrder = {
            pin: currentGeneratedPin,
            fcmToken: null, // Le client ajoutera son token lors de la connexion
            status: "pending", // La commande est directement "en préparation"
            createdAt: new Date(),
            cookingType: selectedCookingType.value,
            // Ajoutez d'autres détails de commande si un menu plus complexe est implémenté
        };

        try {
            await addDoc(collection(db, "orders"), newOrder);
            managerOrderCreationMessage.innerText = `Commande ${currentGeneratedPin} créée avec succès !`;
            console.log("Nouvelle commande Manager enregistrée avec PIN:", currentGeneratedPin);
            currentGeneratedPin = null; // Réinitialiser le PIN généré
            newPinDisplay.innerText = 'Générez un PIN';
            createOrderBtn.disabled = true; // Désactiver le bouton de création
            // L'UI sera mise à jour via l'onSnapshot du manager dashboard
        } catch (error) {
            console.error("Erreur lors de la création de la commande par le Manager :", error);
            managerOrderCreationMessage.innerText = "Erreur lors de la création de la commande. Vérifiez Firestore.";
        }
    }


    // Écoute des commandes en temps réel et affichage
    let unsubscribeOrders = null; // Pour pouvoir désabonner l'écoute

    /**
     * Démarre l'écoute en temps réel des commandes dans Firestore pour le Manager.
     */
    function startOrderListener() {
        if (unsubscribeOrders) {
            unsubscribeOrders(); // Désabonner si déjà actif
        }

        const ordersCollectionRef = collection(db, "orders");
        // Trier par statut (client_draft, pending, ready, relance d'abord, puis delivered/lost_turn)
        // et ensuite par createdAt pour les commandes en cours.
        const q = query(ordersCollectionRef, orderBy("status"), orderBy("createdAt", "asc"));

        unsubscribeOrders = onSnapshot(q, (snapshot) => {
            let activeOrders = [];
            let deliveredAndLostOrders = [];

            snapshot.docs.forEach(doc => {
                const order = { id: doc.id, ...doc.data() };
                if (order.status === 'delivered' || order.status === 'lost_turn') {
                    deliveredAndLostOrders.push(order);
                } else {
                    activeOrders.push(order);
                }
            });

            // Retrier les commandes actives par createdAt pour s'assurer que les plus anciennes sont en haut
            activeOrders.sort((a, b) => {
                const aTime = a.createdAt ? (a.createdAt.toDate ? a.createdAt.toDate().getTime() : a.createdAt) : 0;
                const bTime = b.createdAt ? (b.createdAt.toDate ? b.createdAt.toDate().getTime() : b.createdAt) : 0;
                return aTime - bTime;
            });

            // Combiner les listes (actives d'abord, puis livrées/perdues)
            allOrders = activeOrders.concat(deliveredAndLostOrders); // Stocke toutes les commandes récupérées

            renderOrdersList(allOrders, pinSearchInput.value.trim().toUpperCase());
        }, (error) => {
            console.error("Erreur lors de l'écoute des commandes Firestore :", error);
            ordersList.innerHTML = '<p class="error-message">Erreur de chargement des commandes. Vérifiez les règles Firestore.</p>';
        });
    }

    /**
     * Fonction pour rendre la liste des commandes dans l'UI du Manager.
     * @param {Array<Object>} ordersToRender - Les commandes à afficher.
     * @param {string} searchTerm - Le terme de recherche actuel.
     */
    function renderOrdersList(ordersToRender, searchTerm = '') {
        ordersList.innerHTML = ''; // Nettoyer la liste

        const filteredOrders = searchTerm
            ? ordersToRender.filter(order => order.pin && order.pin.includes(searchTerm)) // Ajout de order.pin pour s'assurer qu'il existe
            : ordersToRender;

        if (filteredOrders.length === 0 && searchTerm) {
            ordersList.innerHTML = `<p>Aucun PIN '${searchTerm}' trouvé.</p>`;
            return;
        } else if (filteredOrders.length === 0 && !searchTerm) {
            ordersList.innerHTML = '<p>Aucune commande en cours.</p>';
            return;
        }

        filteredOrders.forEach(order => {
            const orderItem = document.createElement('div');
            orderItem.classList.add('order-item');
            orderItem.dataset.id = order.id; // Pour référence facile au document Firestore

            // Appliquer la classe de statut pour la couleur de fond
            let statusClass = '';
            if (order.status === 'client_draft') {
                statusClass = 'status-client-draft'; // Nouveau statut visuel pour le manager
            } else if (order.status === 'pending') {
                statusClass = 'status-pending';
            } else if (order.status === 'ready') {
                statusClass = 'status-ready';
            } else if (order.status === 'relance') {
                statusClass = 'status-relance';
            } else if (order.status === 'delivered') {
                statusClass = 'status-delivered';
            } else if (order.status === 'lost_turn') {
                statusClass = 'status-lost-turn'; // Nouveau statut visuel pour le manager
            }
            orderItem.classList.add(statusClass);

            // Récupérer le nom complet de la cuisson et sa classe de couleur
            const cookingName = cookingAbbrMap[order.cookingType] || 'N/A';
            const cookingColorClass = cookingColorClasses[order.cookingType] || '';

            let displayStatusText = order.status.replace('_', ' ');
            if (order.status === 'client_draft') {
                displayStatusText = 'Brouillon Client'; // Texte plus explicite pour le manager
            } else if (order.status === 'lost_turn') {
                displayStatusText = 'Tour Perdu';
            }


            // Le contenu de la ligne : PIN + Type de Cuisson (Abréviation colorée)
            orderItem.innerHTML = `
                <span class="pin">${order.pin}</span>
                <span class="cooking-abbr ${cookingColorClass}">${order.cookingType}</span>
                <span class="status-text">${displayStatusText}</span>
            `;

            // Logique de clic pour changer le statut
            orderItem.addEventListener('click', async () => {
                const orderRef = doc(db, "orders", order.id);
                if (order.status === 'client_draft') {
                    // Le manager peut valider une commande brouillon pour la passer en pending
                    showManagerConfirmationModal(`Voulez-vous valider la commande brouillon ${order.pin} et la passer en préparation ?`, async () => {
                         await updateDoc(orderRef, { status: "pending" });
                         console.log(`Commande ${order.pin} validée par le manager et passée en préparation.`);
                    });
                } else if (order.status === 'pending') {
                    // Passe à READY, la Cloud Function va envoyer la 1ère notification
                    showManagerConfirmationModal(`Voulez-vous marquer la commande ${order.pin} comme PRÊTE ?`, async () => {
                        await updateDoc(orderRef, {
                            status: "ready",
                            readyTimestamp: Date.now(), // Enregistre le timestamp de la mise en prêt
                            relanceCount: 0 // Réinitialise le compteur de relance
                        });
                        console.log(`Commande ${order.pin} marquée comme PRÊTE.`);
                    });
                } else if (order.status === 'ready' || order.status === 'relance') {
                    // Passe à DELIVERED
                    showManagerConfirmationModal(`Voulez-vous marquer la commande ${order.pin} comme LIVRÉE ?`, async () => {
                        await updateDoc(orderRef, { status: "delivered" });
                        console.log(`Commande ${order.pin} marquée comme LIVRÉE.`);
                    });
                } else if (order.status === 'delivered' || order.status === 'lost_turn') {
                    // Optionnel: Supprimer la commande une fois livrée/perdue
                    showManagerConfirmationModal(`Voulez-vous archiver/supprimer la commande ${order.pin} (statut: ${displayStatusText}) ?`, async () => {
                        await deleteDoc(orderRef);
                        console.log(`Commande ${order.pin} archivée/supprimée.`);
                    });
                }
            });
            ordersList.appendChild(orderItem);
        });
    }

    // Gérer la recherche
    pinSearchInput.addEventListener('input', () => {
        // La recherche est gérée en filtrant la liste `allOrders` et en re-rendant.
        renderOrdersList(allOrders, pinSearchInput.value.trim().toUpperCase());
    });

    // Charger le PIN Manager au démarrage de la page Manager
    loadManagerPin();
}


// --- Enregistrement du Service Worker (pour les notifications en arrière-plan) ---
// Ce code doit être au tout début du fichier app.js et exécuté pour toutes les pages.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/firebase-messaging-sw.js')
      .then((registration) => {
        console.log('Service Worker enregistré avec succès:', registration);
      })
      .catch((error) => {
        console.error('Échec de l\'enregistrement du Service Worker:', error);
      });
  });
}
