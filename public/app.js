import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { getFirestore, collection, addDoc, onSnapshot, doc, updateDoc, deleteDoc, query, where, orderBy, limit, getDoc, setDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-firestore.js";
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-messaging.js";
import { firebaseConfig } from './firebase-config.js'; // Chemin corrigé : le fichier firebase-config.js est dans le même dossier 'public'

// --- Initialisation Firebase ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const messaging = getMessaging(app);

// --- Constantes de Configuration (AJUSTEZ CELLES-CI SI BESOIN) ---
const MANAGER_PIN_DOC_ID = "managerPinConfig"; // Document ID pour la référence Manager dans Firestore
const MANAGER_DEFAULT_PIN = "1234"; // Référence Manager par défaut si non trouvée dans Firestore (À CHANGER EN PRODUCTION !)
const RELANCE_INTERVAL_MS = 30 * 1000; // 30 secondes
const MAX_RELANCES = 3; // 3 relances = 90 secondes avant perte de tour
const LOCAL_STORAGE_PINS_KEY = 'buvettePwaGuestPins'; // Clé pour stocker un tableau de références dans le localStorage du Guest

// --- Fonctions Utilitaires Générales ---

/**
 * Génère une référence alphanumérique de 4 caractères.
 * @returns {string} La référence générée.
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

    // Mettre à jour l'interface du Guest si c'est la page active et que la référence de commande correspond
    if (window.location.pathname.endsWith('guest.html')) {
        // Déclenche une mise à jour complète de la liste des commandes du Guest
        // Cela va re-rendre toutes les commandes et mettre à jour les statuts/comptes à rebours
        initializeGuestApp();
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
    });

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

    // Nouveaux éléments DOM pour la création de commande
    const createOrderSection = document.getElementById('create-order-section');
    const newPinDisplay = document.getElementById('new-pin-display');
    const generatePinBtn = document.getElementById('generate-pin-btn');
    const clientNameInput = document.getElementById('client-name-input'); // Nouveau champ pour le nom du client
    const cookingTypeRadios = document.querySelectorAll('input[name="cookingType"]');
    const createOrderBtn = document.getElementById('create-order-btn');
    const managerOrderCreationMessage = document.getElementById('manager-order-creation-message');

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

    // Mappage des abréviations de cuisson aux noms complets et classes CSS pour les pastilles
    const cookingTypesColors = {
        'B': { name: 'Bleu', color: '#17a2b8' }, // Cyan/Teal
        'S': { name: 'Saignant', color: '#dc3545' }, // Red
        'AP': { name: 'À Point', color: '#ffb6c1' }, // Pink
        'BC': { name: 'Bien Cuit', color: '#8b4513' } // SaddleBrown
    };

    const cookingAbbrMap = {
        'BC': 'Bien Cuit',
        'AP': 'À Point',
        'S': 'Saignant',
        'B': 'Bleu'
    };
    const cookingColorClasses = { // Pour le style CSS existant, à conserver pour la compatibilité
        'BC': 'bc',
        'AP': 'ap',
        'S': 's',
        'B': 'b'
    };

    let managerPin = MANAGER_DEFAULT_PIN; // Référence Manager par défaut, sera mis à jour depuis Firestore
    let allOrders = []; // Nouvelle variable pour stocker toutes les commandes récupérées

    // Map to store current UI state of cooking type and status for each order being edited
    // Key: order.id, Value: { originalCookingType, currentCookingType, originalStatus, currentStatus, originalClientName, currentClientName, originalPin, currentPin }
    const orderEditState = new Map();

    /**
     * Charge la Référence Manager depuis Firestore ou la crée s'il n'existe pas.
     */
    async function loadManagerPin() {
        const docRef = doc(db, "config", MANAGER_PIN_DOC_ID);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            managerPin = docSnap.data().pin;
            console.log("Manager PIN chargé depuis Firestore:", managerPin); // Debug log
        } else {
            // Créer le document avec la Référence par défaut si non trouvé
            await setDoc(docRef, { pin: MANAGER_DEFAULT_PIN });
            managerPin = MANAGER_DEFAULT_PIN; // Ensure managerPin is set locally after creation
            console.log("Default Manager PIN created in Firestore:", MANAGER_DEFAULT_PIN); // Debug log
        }
    }

    /**
     * Affiche le tableau de bord Manager après authentification.
     */
    function showManagerDashboard() {
        console.log("Attempting to show manager dashboard."); // Debug log
        if (authSection) authSection.style.display = 'none';
        if (managerDashboard) managerDashboard.style.display = 'block';
        console.log("Auth section display:", authSection ? authSection.style.display : 'N/A'); // Debug log
        console.log("Manager dashboard display:", managerDashboard ? managerDashboard.style.display : 'N/A'); // Debug log

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
        console.log("Manager login button clicked."); // Debug log
        await loadManagerPin(); // Assurez-vous d'avoir la référence à jour
        const enteredPin = managerPinInput.value.trim(); // Trim whitespace
        console.log("Entered PIN:", enteredPin); // Debug log
        console.log("Stored Manager PIN:", managerPin); // Debug log

        if (enteredPin === managerPin) {
            console.log("PIN matched. Showing dashboard."); // Debug log
            showManagerDashboard();
        } else {
            console.log("PIN mismatch. Displaying error."); // Debug log
            authErrorMessage.innerText = "Référence Manager incorrecte. Veuillez réessayer.";
        }
    });

    /**
     * Crée une nouvelle commande client depuis le Manager.
     */
    async function createManagerOrder() {
        if (!currentGeneratedPin) {
            managerOrderCreationMessage.innerText = "Veuillez générer un N° de commande d'abord.";
            return;
        }

        const selectedCookingType = document.querySelector('input[name="cookingType"]:checked');
        if (!selectedCookingType) {
            managerOrderCreationMessage.innerText = "Veuillez sélectionner un mode de cuisson.";
            return;
        }

        const clientName = clientNameInput.value.trim(); // Récupérer le nom du client

        const newOrder = {
            pin: currentGeneratedPin,
            fcmToken: null, // Le client ajoutera son token lors de la connexion
            status: "pending", // La commande est directement "en préparation"
            createdAt: new Date(),
            cookingType: selectedCookingType.value,
            clientName: clientName === '' ? 'N/A' : clientName, // Ajouter le nom du client
            // Ajoutez d'autres détails de commande si un menu plus complexe est implémenté
        };

        try {
            await addDoc(collection(db, "orders"), newOrder);
            managerOrderCreationMessage.innerText = `Commande avec N° ${currentGeneratedPin} pour ${clientName || 'N/A'} créée avec succès !`;
            console.log("Nouvelle commande Manager enregistrée avec N°:", currentGeneratedPin, "et client:", clientName);
            currentGeneratedPin = null; // Réinitialiser la référence générée
            newPinDisplay.innerText = 'Générer un N° de commande'; // Mise à jour du libellé
            clientNameInput.value = ''; // Réinitialiser le champ nom client
            createOrderBtn.disabled = true; // Désactiver le bouton de création
            // L'UI sera mise à jour via l'onSnapshot du manager dashboard
        } catch (error) {
            console.error("Erreur lors de la création de la commande par le Manager :", error);
            managerOrderCreationMessage.innerText = "Erreur lors de la création de la commande. Vérifiez Firestore.";
        }
    }

    /**
     * Met à jour l'état visuel et fonctionnel du bouton "Valider" et "Annuler" pour une commande.
     * Le bouton est actif si des modifications sont détectées par rapport à l'état initial stocké dans orderEditState.
     * @param {string} orderId - L'ID de la commande.
     */
    function checkAndToggleValidateButton(orderId) {
        const orderItemElement = document.querySelector(`.order-item[data-id="${orderId}"]`);
        if (!orderItemElement) return;

        const validateBtn = orderItemElement.querySelector('.validate-order-btn');
        const cancelBtn = orderItemElement.querySelector('.cancel-changes-btn');

        const editState = orderEditState.get(orderId);
        if (!editState) {
            // No edit state means no changes, disable buttons
            validateBtn.disabled = true;
            cancelBtn.disabled = true;
            return;
        }

        const hasChanges = (editState.currentCookingType !== editState.originalCookingType) ||
                           (editState.currentStatus !== editState.originalStatus) ||
                           (editState.currentClientName !== editState.originalClientName) ||
                           (editState.currentPin !== editState.originalPin); // Check PIN changes

        validateBtn.disabled = !hasChanges;
        cancelBtn.disabled = !hasChanges;
    }

    /**
     * Gère la sélection d'une pastille de cuisson.
     * @param {string} orderId - L'ID de la commande.
     * @param {string} selectedCookingType - Le type de cuisson sélectionné (BC, AP, S, B).
     * @param {HTMLElement} clickedPastille - L'élément DOM de la pastille cliquée.
     */
    function handleCookingTypeSelection(orderId, selectedCookingType, clickedPastille) {
        const orderItemElement = document.querySelector(`.order-item[data-id="${orderId}"]`);
        if (!orderItemElement) return;

        // Remove 'selected' class and check icon from all pastilles for this order
        orderItemElement.querySelectorAll('.cooking-pastille').forEach(pastille => {
            pastille.classList.remove('selected');
            const checkIcon = pastille.querySelector('.fa-check');
            if (checkIcon) checkIcon.remove();
        });

        // Add 'selected' class and check icon to the clicked pastille
        clickedPastille.classList.add('selected');
        const checkIcon = document.createElement('i');
        checkIcon.classList.add('fas', 'fa-check');
        clickedPastille.appendChild(checkIcon);

        // Update the temporary state for this order
        const currentEditState = orderEditState.get(orderId);
        if (currentEditState) {
            currentEditState.currentCookingType = selectedCookingType;
        } else {
            // Fallback: re-initialize edit state (should not happen if renderOrdersList initializes correctly)
            const order = allOrders.find(o => o.id === orderId);
            if (order) {
                orderEditState.set(order.id, {
                    originalCookingType: order.cookingType,
                    originalStatus: order.status,
                    originalClientName: order.clientName,
                    originalPin: order.pin,
                    currentCookingType: selectedCookingType,
                    currentStatus: order.status,
                    currentClientName: order.clientName,
                    currentPin: order.pin
                });
            }
        }

        checkAndToggleValidateButton(orderId);
    }

    /**
     * Gère le changement de statut via les boutons radio.
     * @param {string} orderId - L'ID de la commande.
     * @param {string} selectedStatus - Le statut sélectionné.
     */
    function handleStatusChange(orderId, selectedStatus) {
        const currentEditState = orderEditState.get(orderId);
        if (currentEditState) {
            currentEditState.currentStatus = selectedStatus;
        } else {
            // Fallback: re-initialize edit state (should not happen if renderOrdersList initializes correctly)
            const order = allOrders.find(o => o.id === orderId);
            if (order) {
                orderEditState.set(order.id, {
                    originalCookingType: order.cookingType,
                    originalStatus: order.status,
                    originalClientName: order.clientName,
                    originalPin: order.pin,
                    currentCookingType: order.cookingType,
                    currentStatus: selectedStatus,
                    currentClientName: order.clientName,
                    currentPin: order.pin
                });
            }
        }
        checkAndToggleValidateButton(orderId);
    }

    /**
     * Gère le changement du nom du client.
     * @param {string} orderId - L'ID de la commande.
     * @param {string} newClientName - Le nouveau nom du client.
     */
    function handleClientNameChange(orderId, newClientName) {
        const currentEditState = orderEditState.get(orderId);
        if (currentEditState) {
            currentEditState.currentClientName = newClientName.trim();
        } else {
            const order = allOrders.find(o => o.id === orderId);
            if (order) {
                orderEditState.set(order.id, {
                    originalCookingType: order.cookingType,
                    originalStatus: order.status,
                    originalClientName: order.clientName,
                    originalPin: order.pin,
                    currentCookingType: order.cookingType,
                    currentStatus: order.status,
                    currentClientName: newClientName.trim(),
                    currentPin: order.pin
                });
            }
        }
        checkAndToggleValidateButton(orderId);
    }

    /**
     * Gère le changement du PIN de la commande.
     * @param {string} orderId - L'ID de la commande.
     * @param {string} newPin - Le nouveau PIN.
     */
    function handlePinChange(orderId, newPin) {
        const currentEditState = orderEditState.get(orderId);
        if (currentEditState) {
            currentEditState.currentPin = newPin.trim().toUpperCase();
        } else {
            const order = allOrders.find(o => o.id === orderId);
            if (order) {
                orderEditState.set(order.id, {
                    originalCookingType: order.cookingType,
                    originalStatus: order.status,
                    originalClientName: order.clientName,
                    originalPin: order.pin,
                    currentCookingType: order.cookingType,
                    currentStatus: order.status,
                    currentClientName: order.clientName,
                    currentPin: newPin.trim().toUpperCase()
                });
            }
        }
        checkAndToggleValidateButton(orderId);
    }

    /**
     * Fonction pour annuler les modifications sur une commande.
     * Revertit l'UI à l'état initial et désactive les boutons de validation/annulation.
     * @param {string} orderId - L'ID de la commande.
     */
    function cancelChanges(orderId) {
        const orderItemElement = document.querySelector(`.order-item[data-id="${orderId}"]`);
        if (!orderItemElement) return;

        const editState = orderEditState.get(orderId);
        if (!editState) return; // Nothing to cancel

        // Revert current state to original state in the map
        editState.currentCookingType = editState.originalCookingType;
        editState.currentStatus = editState.originalStatus;
        editState.currentClientName = editState.originalClientName;
        editState.currentPin = editState.originalPin;

        // Re-render this specific order item to reflect the reverted state
        // This is a bit of a hack as it re-renders only one item, but it's simpler than re-rendering the whole list.
        // A full re-render (calling renderOrdersList) would also work but might be less performant for single item changes.
        // For simplicity and consistency with onSnapshot, let's just trigger a full re-render
        renderOrdersList(allOrders, pinSearchInput.value.trim().toUpperCase());
        // The checkAndToggleValidateButton will be called during renderOrdersList, disabling the buttons
    }

    /**
     * Fonction pour valider les modifications de cuisson et/ou de statut.
     * @param {string} orderId - L'ID de la commande à valider.
     */
    async function validateOrder(orderId) {
        const orderRef = doc(db, "orders", orderId);
        const orderItemElement = document.querySelector(`.order-item[data-id="${orderId}"]`);
        if (!orderItemElement) {
            console.error(`Order item element not found for ID: ${orderId}`);
            showManagerConfirmationModal("Erreur: Élément de commande non trouvé. Impossible de valider.", () => {});
            return;
        }

        const editState = orderEditState.get(orderId);
        if (!editState) {
            showManagerConfirmationModal("Aucune modification détectée pour cette commande.", () => {});
            return;
        }

        const newCookingType = editState.currentCookingType;
        const newStatus = editState.currentStatus;
        const newClientName = editState.currentClientName === '' ? 'N/A' : editState.currentClientName; // Handle empty client name
        const newPin = editState.currentPin;

        if (!newCookingType || !newStatus || !newPin) {
            showManagerConfirmationModal("Veuillez sélectionner un type de cuisson, un statut et un N° de commande valide avant de valider.", () => {});
            return;
        }

        // --- Vérification d'unicité du PIN ---
        if (newPin !== editState.originalPin) { // Seulement si le PIN a été modifié
            const q = query(collection(db, "orders"), where("pin", "==", newPin));
            try {
                const querySnapshot = await getDocs(q);
                const existingOrderWithNewPin = querySnapshot.docs.find(doc => doc.id !== orderId);
                if (existingOrderWithNewPin) {
                    showManagerConfirmationModal(`Le N° de commande "${newPin}" est déjà utilisé par une autre commande. Veuillez en choisir un autre.`, () => {});
                    return;
                }
            } catch (error) {
                console.error("Erreur lors de la vérification d'unicité du PIN :", error);
                showManagerConfirmationModal("Erreur lors de la vérification du N° de commande. Veuillez réessayer.", () => {});
                return;
            }
        }
        // --- Fin Vérification d'unicité ---


        const updateData = {
            cookingType: newCookingType,
            status: newStatus,
            clientName: newClientName,
            pin: newPin // Mettre à jour le PIN
        };

        // Handle specific status transitions for timestamps/relanceCount
        if (newStatus === 'ready') {
            updateData.readyTimestamp = Date.now();
            updateData.relanceCount = 0;
        } else if (newStatus === 'pending') { // If moving to pending (e.g., from lost_turn or client_draft)
            updateData.readyTimestamp = null;
            updateData.relanceCount = 0;
        } else if (newStatus === 'delivered' || newStatus === 'lost_turn') {
            updateData.readyTimestamp = null;
            updateData.relanceCount = 0;
        }

        try {
            await updateDoc(orderRef, updateData);
            console.log(`Commande ${orderId} mise à jour (Cuisson: ${newCookingType}, Statut: ${newStatus}, Client: ${newClientName}, PIN: ${newPin}).`);
            orderEditState.delete(orderId); // Clear edit state after successful save
            // The onSnapshot listener will trigger renderOrdersList, which will then disable the buttons
            // as the Firestore data now matches the "original" state.
        } catch (error) {
            console.error("Erreur lors de la validation de la commande :", error);
            showManagerConfirmationModal("Erreur lors de la validation de la commande. Veuillez réessayer.", () => {});
        }
    }

    /**
     * Fonction pour supprimer une commande.
     * @param {string} orderId - L'ID de la commande à supprimer.
     */
    function deleteOrder(orderId) {
        showManagerConfirmationModal(`Voulez-vous vraiment supprimer la commande ${orderId} ? Cette action est irréversible.`, async () => {
            try {
                await deleteDoc(doc(db, "orders", orderId));
                console.log(`Commande ${orderId} supprimée.`);
                orderEditState.delete(orderId); // Remove from edit state if deleted
                // L'UI sera mise à jour via l'onSnapshot
            } catch (error) {
                console.error("Erreur lors de la suppression de la commande :", error);
                showManagerConfirmationModal("Erreur lors de la suppression de la commande. Veuillez réessayer.", () => {});
            }
        });
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
                const statusOrder = { 'client_draft': 1, 'pending': 2, 'ready': 3, 'relance': 4 };
                const statusA = statusOrder[a.status] || 99;
                const statusB = statusOrder[b.status] || 99;

                if (statusA !== statusB) {
                    return statusA - statusB;
                }
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
            ? ordersToRender.filter(order =>
                (order.pin && order.pin.includes(searchTerm)) ||
                (order.clientName && order.clientName.toUpperCase().includes(searchTerm)) // Nouvelle condition de recherche
              )
            : ordersToRender;

        if (filteredOrders.length === 0 && searchTerm) {
            ordersList.innerHTML = `<p>Aucune commande trouvée pour '${searchTerm}'.</p>`;
            return;
        } else if (filteredOrders.length === 0 && !searchTerm) {
            ordersList.innerHTML = '<p>Aucune commande en cours.</p>';
            return;
        }

        filteredOrders.forEach(order => {
            const orderItem = document.createElement('div');
            orderItem.classList.add('order-item');
            orderItem.dataset.id = order.id;

            // Initialize or update orderEditState for this order
            let editState = orderEditState.get(order.id);
            if (!editState) {
                // If this order is new to our local edit state, initialize it with Firestore's current values
                editState = {
                    originalCookingType: order.cookingType,
                    originalStatus: order.status,
                    originalClientName: order.clientName || 'N/A', // Ensure it's never undefined
                    originalPin: order.pin,
                    currentCookingType: order.cookingType,
                    currentStatus: order.status,
                    currentClientName: order.clientName || 'N/A',
                    currentPin: order.pin
                };
                orderEditState.set(order.id, editState);
            } else {
                // If the Firestore data for this order has changed (e.g., from another manager or cloud function)
                // and it's different from our current local edits, then we should reset our local edits
                // to match the new Firestore data.
                if (editState.originalCookingType !== order.cookingType ||
                    editState.originalStatus !== order.status ||
                    editState.originalClientName !== (order.clientName || 'N/A') || // Compare with actual Firestore value
                    editState.originalPin !== order.pin) { // Compare with actual Firestore value

                    editState.originalCookingType = order.cookingType;
                    editState.originalStatus = order.status;
                    editState.originalClientName = order.clientName || 'N/A';
                    editState.originalPin = order.pin;
                    editState.currentCookingType = order.cookingType;
                    editState.currentStatus = order.status;
                    editState.currentClientName = order.clientName || 'N/A';
                    editState.currentPin = order.pin;
                }
            }


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

            // Générer les pastilles de cuisson en utilisant l'état actuel de modification
            let cookingPastillesHtml = '';
            for (const key in cookingTypesColors) {
                const cookingInfo = cookingTypesColors[key];
                const isSelected = editState.currentCookingType === key; // Use current edited cooking type
                cookingPastillesHtml += `
                    <span class="cooking-pastille ${isSelected ? 'selected' : ''}"
                          style="background-color: ${cookingInfo.color};"
                          data-cooking-type="${key}"
                          data-order-id="${order.id}"
                          title="${cookingInfo.name}">
                        ${isSelected ? '<i class="fas fa-check"></i>' : ''}
                    </span>
                `;
            }

            let displayStatusText = order.status.replace('_', ' ');
            if (order.status === 'client_draft') {
                displayStatusText = 'Brouillon Client'; // Texte plus explicite pour le manager
            } else if (order.status === 'lost_turn') {
                displayStatusText = 'Tour Perdu';
            }

            // Contenu de la ligne : Référence + Nom Client + Pastilles de cuisson + Radio boutons de statut + Boutons d'action
            orderItem.innerHTML = `
                <div class="order-info">
                    <input type="text" class="pin-input" value="${editState.currentPin}" data-order-id="${order.id}" maxlength="4">
                    <input type="text" class="client-name-input" value="${editState.currentClientName === 'N/A' ? '' : editState.currentClientName}" data-order-id="${order.id}" placeholder="Nom du client">
                </div>
                <div class="cooking-pastilles-container">
                    ${cookingPastillesHtml}
                </div>
                <div class="status-controls">
                    ${order.status === 'client_draft' ? `<span class="status-message ${statusClass}">${displayStatusText}</span>` : `
                        <label><input type="radio" name="status-${order.id}" value="pending" ${editState.currentStatus === 'pending' ? 'checked' : ''}> En préparation</label>
                        <label><input type="radio" name="status-${order.id}" value="ready" ${editState.currentStatus === 'ready' ? 'checked' : ''}> Prêt</label>
                        <label><input type="radio" name="status-${order.id}" value="delivered" ${editState.currentStatus === 'delivered' ? 'checked' : ''}> Livré</label>
                        <label><input type="radio" name="status-${order.id}" value="lost_turn" ${editState.currentStatus === 'lost_turn' ? 'checked' : ''}> Tour Perdu</label>
                    `}
                </div>
                <div class="order-actions">
                    <button class="action-btn cancel-changes-btn" data-id="${order.id}" title="Annuler les modifications" disabled>
                        <i class="fas fa-times"></i>
                    </button>
                    <button class="action-btn validate-order-btn" data-id="${order.id}" title="Appliquer statut et cuisson" disabled>
                        <i class="fas fa-check"></i>
                    </button>
                    <button class="action-btn delete-order-btn" data-id="${order.id}" title="Supprimer commande">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </div>
            `;

            ordersList.appendChild(orderItem);

            // Attacher les écouteurs d'événements aux pastilles
            orderItem.querySelectorAll('.cooking-pastille').forEach(pastille => {
                pastille.addEventListener('click', (e) => {
                    e.stopPropagation();
                    handleCookingTypeSelection(order.id, pastille.dataset.cookingType, pastille);
                });
            });

            // Attacher les écouteurs d'événements aux radio boutons de statut
            orderItem.querySelectorAll(`input[name="status-${order.id}"]`).forEach(radio => {
                radio.addEventListener('change', (e) => {
                    e.stopPropagation();
                    handleStatusChange(order.id, radio.value);
                });
            });

            // Attacher les écouteurs d'événements aux champs de texte (PIN et Nom Client)
            const pinInput = orderItem.querySelector('.pin-input');
            const clientNameInput = orderItem.querySelector('.client-name-input');

            if (pinInput) {
                pinInput.addEventListener('input', (e) => {
                    e.target.value = e.target.value.toUpperCase(); // Force uppercase
                    handlePinChange(order.id, e.target.value);
                });
            }
            if (clientNameInput) {
                clientNameInput.addEventListener('input', (e) => {
                    handleClientNameChange(order.id, e.target.value);
                });
            }

            // Attacher les écouteurs d'événements aux boutons d'action
            const cancelBtn = orderItem.querySelector('.cancel-changes-btn');
            const validateBtn = orderItem.querySelector('.validate-order-btn');
            const deleteBtn = orderItem.querySelector('.delete-order-btn');

            if (cancelBtn) {
                cancelBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    cancelChanges(order.id);
                });
            }
            if (validateBtn) {
                validateBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    validateOrder(order.id);
                });
            }
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteOrder(order.id);
                });
            }

            // Initialisez l'état des boutons Valider/Annuler après le rendu
            checkAndToggleValidateButton(order.id);
        });
    }

    // Gérer la recherche
    pinSearchInput.addEventListener('input', () => {
        // La recherche est gérée en filtrant la liste `allOrders` et en re-rendant.
        renderOrdersList(allOrders, pinSearchInput.value.trim().toUpperCase());
    });

    // Charger la Référence Manager au démarrage de la page Manager
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
