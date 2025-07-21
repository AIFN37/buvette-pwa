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
        initializeGuestApp(); // Déclenche une mise à jour complète de la liste des commandes du Guest
    }
});

// --- Logique du module GUEST ---
if (window.location.pathname.endsWith('guest.html')) {
    const createOrderSection = document.getElementById('create-order-section');
    const addOrderBtn = document.getElementById('add-order-btn');
    const cookingTypeRadios = document.querySelectorAll('input[name="cookingType"]');
    const ordersListSection = document.getElementById('orders-list-section');
    const guestOrdersList = document.getElementById('guest-orders-list');
    const validateAllOrdersBtn = document.getElementById('validate-all-orders-btn');
    const cancelAllOrdersBtn = document.getElementById('cancel-all-orders-btn');

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
        removeModalListeners(); // Ensure listeners are removed after action
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
        removeModalListeners(); // Ensure listeners are removed after action
    }

    /**
     * Attache les écouteurs d'événements à la modale.
     */
    function addModalListeners() {
        // Remove existing listeners first to prevent duplicates
        removeModalListeners(); // This ensures we only have one set of listeners at any time

        if (modalConfirmBtn) {
            modalConfirmBtn.addEventListener('click', handleConfirmClick);
            console.log("Confirm button listener attached.");
        }
        if (modalCancelBtn) {
            modalCancelBtn.addEventListener('click', handleCancelClick);
            console.log("Cancel button listener attached.");
        }
    }

    /**
     * Retire les écouteurs d'événements de la modale.
     */
    function removeModalListeners() {
        if (modalConfirmBtn) {
            modalConfirmBtn.removeEventListener('click', handleConfirmClick);
        }
        if (modalCancelBtn) {
            modalCancelBtn.removeEventListener('click', handleCancelClick);
        }
        console.log("Modal listeners removed.");
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

        // Attache les écouteurs pour cette instance de la modale
        addModalListeners();
    }


    /**
     * Rend la liste des commandes du Guest dans l'interface utilisateur.
     */
    function renderGuestOrders() {
        guestOrdersList.innerHTML = ''; // Nettoie la liste

        if (guestPins.length === 0) {
            guestOrdersList.innerHTML = '<p>Aucune commande ajoutée pour le moment.</p>';
            ordersListSection.style.display = 'none';
            validateAllOrdersBtn.style.display = 'none';
            cancelAllOrdersBtn.style.display = 'none';
            return;
        }

        ordersListSection.style.display = 'block'; // Affiche la section de la liste

        // Vérifie si toutes les commandes sont validées pour activer/désactiver les boutons globaux
        const hasUnvalidatedOrders = Object.values(guestOrdersData).some(order => order.status === 'client_draft');
        validateAllOrdersBtn.style.display = hasUnvalidatedOrders ? 'inline-block' : 'none';
        cancelAllOrdersBtn.style.display = hasUnvalidatedOrders ? 'inline-block' : 'none';


        guestPins.forEach(pin => {
            const order = guestOrdersData[pin];
            if (!order) return; // Si les données ne sont pas encore chargées, passe

            const orderItem = document.createElement('div');
            orderItem.classList.add('guest-order-item');
            orderItem.dataset.pin = pin;

            const cookingInfo = cookingTypesMap[order.cookingType] || { name: 'Inconnu', class: '' };

            let statusText = '';
            let statusClass = '';
            let enableButtons = false; // Par défaut, les boutons sont désactivés

            if (order.status === 'client_draft') {
                statusText = 'Brouillon';
                statusClass = 'client-draft';
                enableButtons = true; // Activer les boutons si en brouillon
            } else if (order.status === 'pending') {
                statusText = 'En préparation...';
                statusClass = 'pending';
            } else if (order.status === 'ready') {
                statusText = 'PRÊT !';
                statusClass = 'ready';
            } else if (order.status === 'relance') {
                statusText = 'Dépêchez-vous !';
                statusClass = 'relance';
            } else if (order.status === 'delivered') {
                statusText = 'Livré. Merci !';
                statusClass = 'delivered';
            } else if (order.status === 'lost_turn') {
                statusText = 'Tour perdu !';
                statusClass = 'lost-turn';
            }

            orderItem.innerHTML = `
                <span class="pin-display">${order.pin}</span>
                <span class="cooking-type ${cookingInfo.class}">${cookingInfo.name}</span>
                <span class="status-message ${statusClass}">${statusText}</span>
                <div class="action-buttons">
                    <button class="modify-btn" title="Modifier" ${enableButtons ? '' : 'disabled'}>
                        <i class="fas fa-pencil-alt"></i>
                    </button>
                    <button class="delete-btn" title="Supprimer" ${enableButtons ? '' : 'disabled'}>
                        <i class="fas fa-times"></i>
                    </button>
                    <button class="validate-single-btn" title="Valider cette commande" ${enableButtons ? '' : 'disabled'}>
                        <i class="fas fa-check"></i>
                    </button>
                </div>
            `;
            guestOrdersList.appendChild(orderItem);

            // Attacher les écouteurs d'événements aux boutons individuels
            if (enableButtons) {
                orderItem.querySelector('.modify-btn').addEventListener('click', () => editGuestOrder(pin));
                orderItem.querySelector('.delete-btn').addEventListener('click', () => deleteGuestOrder(pin));
                orderItem.querySelector('.validate-single-btn').addEventListener('click', () => validateSingleOrder(pin));
            }
        });
    }

    /**
     * Gère la création d'une nouvelle commande.
     */
    addOrderBtn.addEventListener('click', async () => {
        const selectedCookingType = document.querySelector('input[name="cookingType"]:checked').value;
        const newPin = generatePin();
        const fcmToken = await requestNotificationPermissionAndGetToken();

        const newOrder = {
            pin: newPin,
            fcmToken: fcmToken || null,
            status: "client_draft", // Nouveau statut : brouillon client
            createdAt: new Date(),
            cookingType: selectedCookingType,
            // Ajoutez d'autres détails de commande si un menu plus complexe est implémenté
        };

        try {
            const docRef = await addDoc(collection(db, "orders"), newOrder);
            console.log("Nouvelle commande brouillon enregistrée avec ID:", docRef.id, "et PIN:", newPin);

            // Ajoute le PIN à la liste locale et le sauvegarde
            guestPins.push(newPin);
            localStorage.setItem(LOCAL_STORAGE_PINS_KEY, JSON.stringify(guestPins));

            // Démarre l'écoute pour cette nouvelle commande
            startListeningToGuestOrder(docRef.id, newPin);

            renderGuestOrders(); // Met à jour l'affichage
        } catch (error) {
            console.error("Erreur lors de la création de la commande brouillon :", error);
            // Modified: Add onCancelCallback to navigate to index.html
            showConfirmationModal("Impossible d'ajouter la commande. Vérifiez votre connexion ou les règles Firestore.", () => {}, () => { window.location.href = 'index.html'; });
        }
    });

    /**
     * Gère la modification d'une commande existante (en brouillon).
     * Pour l'instant, cela permettrait de changer la cuisson.
     * @param {string} pinToEdit - Le PIN de la commande à modifier.
     */
    function editGuestOrder(pinToEdit) {
        const order = guestOrdersData[pinToEdit];
        if (!order || order.status !== 'client_draft') {
            showConfirmationModal("Cette commande ne peut pas être modifiée car elle n'est pas en brouillon.", () => {});
            return;
        }

        showConfirmationModal(`Modifier la cuisson pour le PIN ${pinToEdit} (actuel: ${order.cookingType}). Entrez BC, AP, S ou B:`, async () => {
            const newCookingTypeInput = prompt(`Entrez le nouveau type de cuisson (BC, AP, S ou B) pour ${pinToEdit}:`);
            if (newCookingTypeInput && ['BC', 'AP', 'S', 'B'].includes(newCookingTypeInput.toUpperCase())) {
                const newCookingType = newCookingTypeInput.toUpperCase();
                const orderId = order.id; // Utilise l'ID stocké dans guestOrdersData

                if (orderId) {
                    try {
                        await updateDoc(doc(db, "orders", orderId), { cookingType: newCookingType });
                        console.log(`Cuisson du PIN ${pinToEdit} mise à jour.`);
                        // L'UI sera mise à jour via l'onSnapshot
                    } catch (error) {
                        console.error("Erreur mise à jour cuisson :", error);
                        showConfirmationModal("Impossible de modifier la cuisson.", () => {});
                    }
                }
            } else if (newCookingTypeInput !== null) { // Si l'utilisateur n'a pas annulé le prompt
                showConfirmationModal("Type de cuisson invalide. Veuillez entrer BC, AP, S ou B.", () => {});
            }
        });
    }


    /**
     * Gère la suppression d'une commande (en brouillon).
     * @param {string} pinToDelete - Le PIN de la commande à supprimer.
     */
    function deleteGuestOrder(pinToDelete) {
        const order = guestOrdersData[pinToDelete];
        if (!order || order.status !== 'client_draft') {
            showConfirmationModal("Cette commande ne peut pas être supprimée car elle n'est pas en brouillon.", () => {});
            return;
        }

        showConfirmationModal(`Voulez-vous vraiment supprimer la commande ${pinToDelete} ?`, async () => {
            const orderIdToDelete = order.id; // Utilise l'ID stocké dans guestOrdersData

            if (orderIdToDelete) {
                try {
                    // Désabonner l'écoute Firestore avant de supprimer
                    if (unsubscribeGuestOrders[orderIdToDelete]) {
                        unsubscribeGuestOrders[orderIdToDelete]();
                        delete unsubscribeGuestOrders[orderIdToDelete];
                    }

                    await deleteDoc(doc(db, "orders", orderIdToDelete));
                    console.log(`Commande ${pinToDelete} supprimée de Firestore.`);

                    // Supprimer le PIN de la liste locale
                    guestPins = guestPins.filter(p => p !== pinToDelete);
                    localStorage.setItem(LOCAL_STORAGE_PINS_KEY, JSON.stringify(guestPins));

                    delete guestOrdersData[pinToDelete]; // Supprime les données de l'objet local

                    renderGuestOrders(); // Met à jour l'affichage
                } catch (error) {
                    console.error("Erreur lors de la suppression de la commande :", error);
                    showConfirmationModal("Impossible de supprimer la commande. Veuillez réessayer.", () => {});
                }
            }
        });
    }

    /**
     * Valide une seule commande (passe de client_draft à pending).
     * @param {string} pinToValidate - Le PIN de la commande à valider.
     */
    function validateSingleOrder(pinToValidate) {
        const order = guestOrdersData[pinToValidate];
        if (!order || order.status !== 'client_draft') {
            showConfirmationModal("Cette commande ne peut pas être validée car elle n'est pas en brouillon.", () => {});
            return;
        }

        showConfirmationModal(`Voulez-vous valider la commande ${pinToValidate} ? Elle sera envoyée à la buvette.`, async () => {
            const orderIdToValidate = order.id; // Utilise l'ID stocké dans guestOrdersData
            if (orderIdToValidate) {
                try {
                    await updateDoc(doc(db, "orders", orderIdToValidate), { status: "pending" });
                    console.log(`Commande ${pinToValidate} validée et envoyée à la buvette.`);
                    // L'UI sera mise à jour via l'onSnapshot
                } catch (error) {
                    console.error("Erreur lors de la validation de la commande :", error);
                    showConfirmationModal("Impossible de valider la commande. Veuillez réessayer.", () => {});
                }
            }
        });
    }

    /**
     * Valide toutes les commandes en brouillon.
     */
    validateAllOrdersBtn.addEventListener('click', () => {
        const unvalidatedPins = guestPins.filter(pin => guestOrdersData[pin] && guestOrdersData[pin].status === 'client_draft');

        if (unvalidatedPins.length === 0) {
            showConfirmationModal("Aucune commande en brouillon à valider.", () => {});
            return;
        }

        showConfirmationModal(`Voulez-vous valider toutes vos ${unvalidatedPins.length} commandes en brouillon ?`, async () => {
            for (const pin of unvalidatedPins) {
                const orderId = guestOrdersData[pin].id; // Utilise l'ID stocké dans guestOrdersData
                if (orderId) {
                    try {
                        await updateDoc(doc(db, "orders", orderId), { status: "pending" });
                        console.log(`Commande ${pin} validée.`);
                    } catch (error) {
                        console.error(`Erreur lors de la validation de la commande ${pin}:`, error);
                        // Ne pas bloquer la boucle pour une seule erreur
                    }
                }
            }
            // L'UI sera mise à jour via les onSnapshot individuels
        });
    });

    /**
     * Annule toutes les commandes en brouillon.
     */
    cancelAllOrdersBtn.addEventListener('click', () => {
        const unvalidatedPins = guestPins.filter(pin => guestOrdersData[pin] && guestOrdersData[pin].status === 'client_draft');

        if (unvalidatedPins.length === 0) {
            showConfirmationModal("Aucune commande en brouillon à annuler.", () => {});
            return;
        }

        showConfirmationModal(`Voulez-vous annuler toutes vos ${unvalidatedPins.length} commandes en brouillon ?`, async () => {
            for (const pin of unvalidatedPins) {
                const orderId = guestOrdersData[pin].id; // Utilise l'ID stocké dans guestOrdersData
                if (orderId) {
                    try {
                        // Désabonner l'écoute Firestore avant de supprimer
                        if (unsubscribeGuestOrders[orderId]) {
                            unsubscribeGuestOrders[orderId]();
                            delete unsubscribeGuestOrders[orderId];
                        }
                        await deleteDoc(doc(db, "orders", orderId));
                        console.log(`Commande ${pin} annulée et supprimée.`);
                        // Supprimer le PIN de la liste locale
                        guestPins = guestPins.filter(p => p !== pin);
                    } catch (error) {
                        console.error(`Erreur lors de l'annulation de la commande ${pin}:`, error);
                        // Ne pas bloquer la boucle pour une seule erreur
                    }
                }
            }
            localStorage.setItem(LOCAL_STORAGE_PINS_KEY, JSON.stringify(guestPins));
            guestOrdersData = {}; // Réinitialise les données locales
            renderGuestOrders(); // Met à jour l'affichage
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
                renderGuestOrders(); // Met à jour l'affichage
            }
        }, (error) => {
            console.error(`Erreur lors de l'écoute de la commande ${pin} (${orderId}) :`, error);
            // Modified: Add onCancelCallback to navigate to index.html
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
    const authSection = document.getElementById('auth-section');
    const managerDashboard = document.getElementById('manager-dashboard');
    const managerPinInput = document.getElementById('manager-pin-input');
    const managerLoginBtn = document.getElementById('manager-login-btn');
    const authErrorMessage = document.getElementById('auth-error-message');
    const ordersList = document.getElementById('orders-list');
    const pinSearchInput = document.getElementById('pin-search-input');

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

            // Appliquer la classe de statut pour le fond
            let statusClass = '';
            // Le manager peut voir les commandes en brouillon des clients
            if (order.status === 'client_draft') {
                statusClass = 'status-pending'; // Ou une autre couleur si vous voulez les distinguer
            } else if (order.status === 'pending') {
                statusClass = 'status-pending';
            } else if (order.status === 'ready') {
                statusClass = 'status-ready';
            } else if (order.status === 'relance') {
                statusClass = 'status-relance';
            } else if (order.status === 'delivered') {
                statusClass = 'status-delivered';
            } else if (order.status === 'lost_turn') {
                statusClass = 'status-delivered'; // Afficher comme livré/terminé pour le manager
            }
            orderItem.classList.add(statusClass);

            // Récupérer le nom complet de la cuisson et sa classe de couleur
            const cookingName = cookingAbbrMap[order.cookingType] || 'N/A';
            const cookingColorClass = cookingColorClasses[order.cookingType] || '';

            let displayStatusText = order.status.replace('_', ' ');
            if (order.status === 'client_draft') {
                displayStatusText = 'Brouillon Client'; // Texte plus explicite pour le manager
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
                // Le manager ne peut pas modifier les commandes en brouillon du client directement
                if (order.status === 'client_draft') {
                    alert("Cette commande est encore en brouillon client et ne peut pas être traitée par la buvette.");
                    return;
                } else if (order.status === 'pending') {
                    // Passe à READY, la Cloud Function va envoyer la 1ère notification
                    await updateDoc(orderRef, {
                        status: "ready",
                        readyTimestamp: Date.now(), // Enregistre le timestamp de la mise en prêt
                        relanceCount: 0 // Réinitialise le compteur de relance
                    });
                    console.log(`Commande ${order.pin} marquée comme PRÊTE.`);
                } else if (order.status === 'ready' || order.status === 'relance') {
                    // Passe à DELIVERED
                    await updateDoc(orderRef, { status: "delivered" });
                    console.log(`Commande ${order.pin} marquée comme LIVRÉE.`);
                }
                // Si le statut est déjà 'delivered' ou 'lost_turn', on ne fait rien au clic pour l'instant
            });
            ordersList.appendChild(orderItem);
        });
    }


    /**
     * Démarre l'écoute en temps réel des commandes dans Firestore pour le Manager.
     */
    function startOrderListener() {
        let unsubscribeOrders = null; // Pour pouvoir désabonner l'écoute

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

            activeOrders.sort((a, b) => {
                // Ordre spécifique pour les statuts actifs
                const statusOrder = { 'client_draft': 1, 'pending': 2, 'ready': 3, 'relance': 4 };
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

            allOrders = activeOrders.concat(deliveredAndLostOrders); // Stocke toutes les commandes récupérées

            // Rend la liste avec le terme de recherche actuel
            renderOrdersList(allOrders, pinSearchInput.value.trim().toUpperCase());
        }, (error) => {
            console.error("Erreur lors de l'écoute des commandes Firestore :", error);
            ordersList.innerHTML = '<p class="error-message">Erreur de chargement des commandes. Vérifiez les règles Firestore.</p>';
        });
    }

    // Gérer la recherche : déclenche un nouveau rendu de la liste filtrée
    pinSearchInput.addEventListener('input', () => {
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
