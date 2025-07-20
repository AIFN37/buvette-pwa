import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { getFirestore, collection, addDoc, onSnapshot, doc, updateDoc, query, where, orderBy, limit, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-firestore.js";
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-messaging.js";
// L'importation de html5-qrcode-scanner n'est plus nécessaire car le scanner QR a été retiré du module Guest.
// import { Html5QrcodeScanner } from "../node_modules/html5-qrcode/esm/html5-qrcode-scanner.js";
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
const LOCAL_STORAGE_PIN_KEY = 'buvettePwaGuestPin'; // Clé pour stocker le PIN dans le localStorage du Guest

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
        const pinDisplay = document.getElementById('pin-display');
        if (pinDisplay && payload.data && payload.data.pin === pinDisplay.innerText) {
            updateGuestUIForNotification(payload.data.status, payload.data.countdownStart);
        }
    }
});

// --- Logique du module GUEST ---
if (window.location.pathname.endsWith('guest.html')) {
    const initialMessage = document.getElementById('initial-message');
    const orderDetailsSection = document.getElementById('order-details');
    const pinDisplay = document.getElementById('pin-display');
    const cookingTypeDisplay = document.getElementById('cooking-type-display');
    const statusMessage = document.getElementById('status-message');
    const countdownDisplay = document.getElementById('countdown-display');

    let currentPin = null;
    let countdownInterval = null;
    let unsubscribeOrderListener = null; // Pour désabonner l'écoute Firestore

    // Mappage des abréviations de cuisson aux noms complets et classes CSS
    const cookingTypesMap = {
        'BC': { name: 'Bien Cuit', class: 'bc' },
        'AP': { name: 'À Point', class: 'ap' },
        'S': { name: 'Saignant', class: 's' },
        'B': { name: 'Bleu', class: 'b' }
    };

    /**
     * Met à jour l'interface utilisateur du Guest en fonction des données de la commande.
     * @param {Object} order - L'objet commande de Firestore.
     */
    function updateGuestUI(order) {
        if (!order) return;

        pinDisplay.innerText = order.pin;
        currentPin = order.pin; // Met à jour le PIN actuel

        const cookingInfo = cookingTypesMap[order.cookingType] || { name: 'Inconnu', class: '' };
        cookingTypeDisplay.innerText = `Cuisson : ${cookingInfo.name}`;
        cookingTypeDisplay.className = `cooking-type ${cookingInfo.class}`;

        statusMessage.classList.remove('pending', 'ready', 'relance', 'delivered', 'lost-turn');
        if (order.status === 'pending') {
            statusMessage.innerText = "Votre commande est en préparation...";
            statusMessage.classList.add('pending');
            stopCountdown();
            countdownDisplay.style.display = 'none';
        } else if (order.status === 'ready') {
            statusMessage.innerText = "Votre plat est PRÊT et vous attend !";
            statusMessage.classList.add('ready');
            startCountdown(order.readyTimestamp); // Démarrer le compte à rebours
            countdownDisplay.style.display = 'block';
        } else if (order.status === 'relance') {
             statusMessage.innerText = "Dépêchez-vous ça refroidit !";
             statusMessage.classList.add('relance');
             startCountdown(order.readyTimestamp);
             countdownDisplay.style.display = 'block';
        } else if (order.status === 'delivered') {
            statusMessage.innerText = "Votre plat a été livré. Merci !";
            statusMessage.classList.add('delivered');
            stopCountdown();
            countdownDisplay.style.display = 'none';
        } else if (order.status === 'lost_turn') {
             statusMessage.innerText = "Attention ! Vous avez perdu votre tour, votre plat a été livré à une autre personne.";
             statusMessage.classList.add('lost-turn');
             stopCountdown();
             countdownDisplay.style.display = 'none';
             // Après un court délai, le Guest repasse en mode "pending"
             setTimeout(() => {
                 statusMessage.innerText = "Votre commande est en préparation...";
                 statusMessage.classList.add('pending');
                 statusMessage.classList.remove('lost-turn');
                 // Recharger les données de la commande pour refléter le changement de statut
                 if (currentPin) {
                    // Re-attacher l'écoute pour s'assurer que l'UI se met à jour si la fonction Cloud
                    // remet la commande en "pending" après un "lost_turn".
                    startOrderListener(currentPin);
                 }
             }, 5000); // Reste en mode "perdu son tour" pendant 5 secondes
        }

        // Afficher les détails de la commande et masquer le message initial
        initialMessage.style.display = 'none';
        orderDetailsSection.style.display = 'block';
    }

    /**
     * Met à jour l'UI du Guest suite à une notification FCM.
     * @param {string} status - Le nouveau statut de la commande.
     * @param {number} countdownStart - Le timestamp de début du compte à rebours.
     */
    function updateGuestUIForNotification(status, countdownStart) {
        if (status === 'ready') {
            statusMessage.innerText = "Votre plat est PRÊT et vous attend !";
            statusMessage.classList.add('ready');
            statusMessage.classList.remove('pending', 'relance', 'delivered', 'lost-turn');
            startCountdown(countdownStart);
            countdownDisplay.style.display = 'block';
        } else if (status === 'relance') {
            statusMessage.innerText = "Dépêchez-vous ça refroidit !";
            statusMessage.classList.add('relance');
            statusMessage.classList.remove('pending', 'ready', 'delivered', 'lost-turn');
            startCountdown(countdownStart);
            countdownDisplay.style.display = 'block';
        } else if (status === 'lost_turn') {
            statusMessage.innerText = "Attention ! Vous avez perdu votre tour, votre plat a été livré à une autre personne.";
            statusMessage.classList.add('lost-turn');
            statusMessage.classList.remove('pending', 'ready', 'relance', 'delivered');
            stopCountdown();
            countdownDisplay.style.display = 'none';
            setTimeout(() => {
                // Simuler le fait de repasser en préparation après avoir perdu son tour
                statusMessage.innerText = "Votre commande est en préparation...";
                statusMessage.classList.add('pending');
                statusMessage.classList.remove('lost-turn');
                // Recharger les données de la commande pour refléter le changement de statut
                if (currentPin) {
                    startOrderListener(currentPin); // Re-attacher l'écoute
                }
            }, 5000); // Reste en mode "perdu son tour" pendant 5 secondes
        }
    }

    /**
     * Démarre le compte à rebours pour les commandes prêtes.
     * @param {number} readyTimestamp - Le timestamp (en ms) quand la commande est devenue prête.
     */
    function startCountdown(readyTimestamp) {
        stopCountdown(); // S'assurer qu'aucun autre compte à rebours ne tourne
        const startTime = readyTimestamp.toMillis ? readyTimestamp.toMillis() : readyTimestamp; // Gérer les timestamps Firebase

        countdownInterval = setInterval(() => {
            const now = Date.now();
            const elapsed = now - startTime;
            const remaining = Math.max(0, (RELANCE_INTERVAL_MS * MAX_RELANCES) - elapsed); // Total 90s

            const seconds = Math.floor(remaining / 1000);
            countdownDisplay.innerText = `${seconds}s`;

            if (seconds <= 0) {
                stopCountdown();
                // La logique de perte de tour est gérée par la Cloud Function
                // L'UI du Guest sera mise à jour via onSnapshot ou onMessage
            }
        }, 1000);
    }

    /**
     * Arrête le compte à rebours.
     */
    function stopCountdown() {
        if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
    }

    /**
     * Démarre l'écoute Firestore pour une commande spécifique.
     * @param {string} pin - Le PIN de la commande à écouter.
     */
    function startOrderListener(pin) {
        if (unsubscribeOrderListener) {
            unsubscribeOrderListener(); // Désabonner l'écoute précédente si elle existe
        }
        unsubscribeOrderListener = onSnapshot(query(collection(db, "orders"), where("pin", "==", pin), limit(1)), (snapshot) => {
            if (snapshot.empty) {
                console.log("Commande non trouvée pour le PIN stocké, création d'une nouvelle.");
                createNewOrder(); // Si le PIN stocké ne correspond à aucune commande, créer une nouvelle
            } else {
                snapshot.docChanges().forEach(change => {
                    if (change.type === "added" || change.type === "modified") {
                        updateGuestUI(change.doc.data());
                    }
                });
            }
        }, (error) => {
            console.error("Erreur lors de l'écoute de la commande existante :", error);
            initialMessage.innerText = "Erreur de connexion à la commande. Veuillez réessayer.";
            // Optionnel : Forcer la création d'une nouvelle commande en cas d'erreur grave
            // createNewOrder();
        });
    }

    /**
     * Initialise l'application Guest : tente de récupérer un PIN existant ou en crée un nouveau.
     */
    async function initializeGuestApp() {
        let storedPin = localStorage.getItem(LOCAL_STORAGE_PIN_KEY);

        if (storedPin) {
            currentPin = storedPin;
            pinDisplay.innerText = currentPin;
            initialMessage.innerText = `Reconnexion à votre commande ${currentPin}...`;
            startOrderListener(currentPin); // Tenter de se connecter à la commande existante
        } else {
            createNewOrder(); // Si aucun PIN stocké, créer une nouvelle commande
        }
    }

    /**
     * Crée une nouvelle commande dans Firestore.
     */
    async function createNewOrder() {
        initialMessage.innerText = "Génération de votre nouvelle commande...";
        currentPin = generatePin(); // Générer un PIN unique
        localStorage.setItem(LOCAL_STORAGE_PIN_KEY, currentPin); // Stocker le nouveau PIN

        const fcmToken = await requestNotificationPermissionAndGetToken();

        // Choix du menu et cuisson (simplifié pour le prototype)
        // En production, ce serait une interface utilisateur pour le client.
        const menuItems = [
            { name: "Steak", price: 10, cookingTypes: ['BC', 'AP', 'S', 'B'] },
            { name: "Frites", price: 5 },
            { name: "Boisson", price: 3 }
        ];
        const selectedMenu = [menuItems[0], menuItems[1]]; // Exemple: Steak + Frites
        const totalAmount = selectedMenu.reduce((sum, item) => sum + item.price, 0);
        const randomCookingType = menuItems[0].cookingTypes[Math.floor(Math.random() * menuItems[0].cookingTypes.length)]; // Choix aléatoire

        const newOrder = {
            pin: currentPin,
            fcmToken: fcmToken || null, // Peut être null si notifications refusées
            status: "pending", // pending, ready, relance, delivered, lost_turn
            createdAt: new Date(),
            menu: selectedMenu.map(item => ({ name: item.name, price: item.price })),
            total: totalAmount,
            cookingType: randomCookingType // Enregistrement du type de cuisson
        };

        try {
            const docRef = await addDoc(collection(db, "orders"), newOrder);
            console.log("Nouvelle commande enregistrée avec ID:", docRef.id, "et PIN:", currentPin);

            // Écouter les mises à jour de cette nouvelle commande spécifique
            startOrderListener(currentPin);
            updateGuestUI(newOrder); // Afficher immédiatement la commande générée
        } catch (error) {
            console.error("Erreur lors de la création de la commande :", error);
            initialMessage.innerText = "Impossible de créer la commande. Veuillez vérifier votre connexion ou les règles Firestore.";
        }
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

    // Écoute des commandes en temps réel et affichage
    let unsubscribeOrders = null; // Pour pouvoir désabonner l'écoute

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
            if (order.status === 'pending') {
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


            // Le contenu de la ligne : PIN + Type de Cuisson (Abréviation colorée)
            orderItem.innerHTML = `
                <span class="pin">${order.pin}</span>
                <span class="cooking-abbr ${cookingColorClass}">${order.cookingType}</span>
                <span class="status-text">${order.status.replace('_', ' ')}</span>
            `;

            // Logique de clic pour changer le statut
            orderItem.addEventListener('click', async () => {
                const orderRef = doc(db, "orders", order.id);
                if (order.status === 'pending') {
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
        if (unsubscribeOrders) {
            unsubscribeOrders(); // Désabonner si déjà actif
        }

        const ordersCollectionRef = collection(db, "orders");
        // Trier par statut (pending/ready/relance d'abord, puis delivered/lost_turn)
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
