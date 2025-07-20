import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js';
import {
  getFirestore,
  collection,
  addDoc,
  onSnapshot,
  doc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  getDoc,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.4.0/firebase-firestore.js';
import {
  getMessaging,
  getToken,
  onMessage,
} from 'https://www.gstatic.com/firebasejs/10.4.0/firebase-messaging.js';
import { Html5QrcodeScanner } from '../node_modules/html5-qrcode/esm/html5-qrcode-scanner.js'; // Chemin pour HTML5-QRCode
import { firebaseConfig } from '../firebase-config.js';

// --- Initialisation Firebase ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const messaging = getMessaging(app);

// --- Constantes de Configuration (AJUSTEZ CELLES-CI SI BESOIN) ---
const MANAGER_PIN_DOC_ID = 'managerPinConfig'; // Document ID pour le PIN Manager dans Firestore
const MANAGER_DEFAULT_PIN = '3369'; // PIN accès Manager par défaut si non trouvé dans Firestore (à changer !)
const RELANCE_INTERVAL_MS = 30 * 1000; // 30 secondes
const MAX_RELANCES = 3; // 3 relances = 90 secondes

// --- Fonctions Utilitaires Générales ---

// Génère un PIN alphanumérique de 4 caractères
function generatePin() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// Fonction pour demander la permission de notification et obtenir le jeton FCM
async function requestNotificationPermissionAndGetToken() {
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      console.log('Permission de notification accordée.');
      // VAPID Key: REMPLACEZ PAR VOTRE CLÉ VAPID PUBLIQUE (celle que vous avez copiée de Firebase)
      const token = await getToken(messaging, {
        vapidKey:
          'BOfarRrQ23arrM__eUBYL4RcP_wJDiP6gMRX8hqxwk8K4SeN1mSYqIplsq4nm0lXcMnJjHED6HSHB_J2iovTgAY',
      });
      console.log('Jeton FCM :', token);
      return token;
    } else {
      console.warn('Permission de notification refusée.');
      return null;
    }
  } catch (error) {
    console.error('Erreur lors de la demande de permission de notification :', error);
    return null;
  }
}

// Jouer une sonnerie (vérifiez que le fichier existe dans public/sounds/)
function playNotificationSound() {
  const audio = new Audio('/sounds/notification.mp3');
  audio.play().catch((e) => console.error('Erreur lecture son :', e));
}

// Écoute des messages FCM en premier plan (quand la PWA est ouverte)
onMessage(messaging, (payload) => {
  console.log('Message FCM reçu en premier plan :', payload);

  // Afficher la notification native du navigateur
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/images/icon-192x192.png', // Assurez-vous d'avoir cette icône
  };
  new Notification(notificationTitle, notificationOptions);

  // Jouer le son
  playNotificationSound();

  // Mettre à jour l'interface du Guest si c'est la page active
  if (window.location.pathname.endsWith('guest.html')) {
    const pinDisplay = document.getElementById('pin-display');
    if (pinDisplay && payload.data && payload.data.pin === pinDisplay.innerText) {
      updateGuestUIForNotification(payload.data.status, payload.data.countdownStart);
    }
  }
});

// --- Logique du module GUEST ---
if (window.location.pathname.endsWith('guest.html')) {
  const qrReaderElement = document.getElementById('qr-reader');
  const scanHint = document.getElementById('scan-hint');
  const orderDetailsSection = document.getElementById('order-details');
  const pinDisplay = document.getElementById('pin-display');
  const cookingTypeDisplay = document.getElementById('cooking-type-display');
  const statusMessage = document.getElementById('status-message');
  const countdownDisplay = document.getElementById('countdown-display');

  let currentPin = null;
  let countdownInterval = null;

  // Affichage des infos de cuisson
  const cookingTypesMap = {
    BC: { name: 'Bien Cuit', class: 'bc' },
    AP: { name: 'À Point', class: 'ap' },
    S: { name: 'Saignant', class: 's' },
    B: { name: 'Bleu', class: 'b' },
  };

  // Fonction pour mettre à jour l'UI du Guest
  function updateGuestUI(order) {
    if (!order) return;

    // Mise à jour du PIN
    pinDisplay.innerText = order.pin;
    currentPin = order.pin; // Mettre à jour le PIN actuel

    // Mise à jour du type de cuisson
    const cookingInfo = cookingTypesMap[order.cookingType] || { name: 'Inconnu', class: '' };
    cookingTypeDisplay.innerText = `Cuisson : ${cookingInfo.name}`;
    cookingTypeDisplay.className = `cooking-type ${cookingInfo.class}`;

    // Mise à jour du statut et des couleurs
    statusMessage.classList.remove('pending', 'ready', 'relance', 'delivered', 'lost-turn');
    if (order.status === 'pending') {
      statusMessage.innerText = 'Votre commande est en préparation...';
      statusMessage.classList.add('pending');
      stopCountdown();
      countdownDisplay.style.display = 'none';
    } else if (order.status === 'ready') {
      statusMessage.innerText = 'Votre plat est PRÊT et vous attend !';
      statusMessage.classList.add('ready');
      startCountdown(order.readyTimestamp); // Démarrer le compte à rebours
      countdownDisplay.style.display = 'block';
    } else if (order.status === 'relance') {
      // Statut relance géré par la Cloud Function pour le Manager, pas pour le Guest directement
      statusMessage.innerText = 'Dépêchez-vous ça refroidit !';
      statusMessage.classList.add('relance');
      startCountdown(order.readyTimestamp);
      countdownDisplay.style.display = 'block';
    } else if (order.status === 'delivered') {
      statusMessage.innerText = 'Votre plat a été livré. Merci !';
      statusMessage.classList.add('delivered');
      stopCountdown();
      countdownDisplay.style.display = 'none';
    } else if (order.status === 'lost_turn') {
      // Nouveau statut pour perte de tour
      statusMessage.innerText =
        'Attention ! Vous avez perdu votre tour, votre plat a été livré à une autre personne.';
      statusMessage.classList.add('lost-turn');
      stopCountdown();
      countdownDisplay.style.display = 'none';
      // Après un court délai, le Guest repasse en mode "pending"
      setTimeout(() => {
        statusMessage.innerText = 'Votre commande est en préparation...';
        statusMessage.classList.add('pending');
        statusMessage.classList.remove('lost-turn');
      }, 5000); // Reste en mode "perdu son tour" pendant 5 secondes
    }

    // Afficher les détails de la commande et masquer le lecteur QR
    qrReaderElement.style.display = 'none';
    scanHint.style.display = 'none';
    orderDetailsSection.style.display = 'block';
  }

  // Fonction pour mettre à jour l'UI du Guest suite à une notification FCM
  function updateGuestUIForNotification(status, countdownStart) {
    if (status === 'ready') {
      statusMessage.innerText = 'Votre plat est PRÊT et vous attend !';
      statusMessage.classList.add('ready');
      statusMessage.classList.remove('pending', 'relance', 'delivered', 'lost-turn');
      startCountdown(countdownStart);
      countdownDisplay.style.display = 'block';
    } else if (status === 'relance') {
      statusMessage.innerText = 'Dépêchez-vous ça refroidit !';
      statusMessage.classList.add('relance');
      statusMessage.classList.remove('pending', 'ready', 'delivered', 'lost-turn');
      startCountdown(countdownStart);
      countdownDisplay.style.display = 'block';
    } else if (status === 'lost_turn') {
      statusMessage.innerText =
        'Attention ! Vous avez perdu votre tour, votre plat a été livré à une autre personne.';
      statusMessage.classList.add('lost-turn');
      statusMessage.classList.remove('pending', 'ready', 'relance', 'delivered');
      stopCountdown();
      countdownDisplay.style.display = 'none';
      setTimeout(() => {
        // Simuler le fait de repasser en préparation après avoir perdu son tour
        statusMessage.innerText = 'Votre commande est en préparation...';
        statusMessage.classList.add('pending');
        statusMessage.classList.remove('lost-turn');
        // Recharger les données de la commande pour refléter le changement de statut
        if (currentPin) {
          onSnapshot(
            query(collection(db, 'orders'), where('pin', '==', currentPin), limit(1)),
            (snapshot) => {
              snapshot.docChanges().forEach((change) => {
                if (change.type === 'modified') {
                  updateGuestUI(change.doc.data());
                }
              });
            }
          );
        }
      }, 5000); // Reste en mode "perdu son tour" pendant 5 secondes
    }
  }

  // Compte à rebours
  function startCountdown(readyTimestamp) {
    stopCountdown(); // S'assurer qu'aucun autre compte à rebours ne tourne
    const startTime = readyTimestamp.toMillis ? readyTimestamp.toMillis() : readyTimestamp; // Gérer les timestamps Firebase

    countdownInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - startTime;
      const remaining = Math.max(0, RELANCE_INTERVAL_MS * MAX_RELANCES - elapsed); // Total 90s

      const seconds = Math.floor(remaining / 1000);
      countdownDisplay.innerText = `${seconds}s`;

      if (seconds <= 0) {
        stopCountdown();
        // La logique de perte de tour est gérée par la Cloud Function
        // L'UI du Guest sera mise à jour via onSnapshot ou onMessage
      }
    }, 1000);
  }

  function stopCountdown() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }

  // Initialisation du lecteur QR code
  const html5QrCodeScanner = new Html5QrcodeScanner(
    'qr-reader',
    { fps: 10, qrbox: { width: 250, height: 250 } },
    false
  );

  function onScanSuccess(decodedText, decodedResult) {
    html5QrCodeScanner.clear(); // Arrêter le scanner
    qrReaderElement.style.display = 'none';
    scanHint.style.display = 'none';
    orderDetailsSection.style.display = 'block';

    // Pour ce prototype, le QR code déclenche la création d'une nouvelle commande
    // et l'obtention d'un PIN.
    // En vrai, le QR code pourrait contenir un ID de commande pré-existante.
    currentPin = generatePin(); // Générer un PIN unique
    pinDisplay.innerText = currentPin;

    // Choix du menu et cuisson (simplifié pour le prototype)
    // Ici, un choix aléatoire pour les tests. En production, ce serait une interface utilisateur.
    const menuItems = [
      { name: 'Steak', price: 10, cookingTypes: ['BC', 'AP', 'S', 'B'] },
      { name: 'Frites', price: 5 },
      { name: 'Boisson', price: 3 },
    ];
    const selectedMenu = [menuItems[0], menuItems[1]]; // Exemple: Steak + Frites
    const totalAmount = selectedMenu.reduce((sum, item) => sum + item.price, 0);
    const randomCookingType =
      menuItems[0].cookingTypes[Math.floor(Math.random() * menuItems[0].cookingTypes.length)]; // Choix aléatoire

    requestNotificationPermissionAndGetToken().then(async (fcmToken) => {
      if (fcmToken) {
        const newOrder = {
          pin: currentPin,
          fcmToken: fcmToken,
          status: 'pending', // pending, ready, relance, delivered, lost_turn
          createdAt: new Date(),
          menu: selectedMenu.map((item) => ({ name: item.name, price: item.price })),
          total: totalAmount,
          cookingType: randomCookingType, // Enregistrement du type de cuisson
        };

        const docRef = await addDoc(collection(db, 'orders'), newOrder);
        console.log('Nouvelle commande enregistrée avec ID:', docRef.id, 'et PIN:', currentPin);

        // Écouter les mises à jour de cette commande spécifique
        onSnapshot(doc(db, 'orders', docRef.id), (docSnapshot) => {
          if (docSnapshot.exists()) {
            updateGuestUI(docSnapshot.data());
          }
        });

        updateGuestUI(newOrder); // Afficher immédiatement la commande générée
      } else {
        statusMessage.innerText =
          'Veuillez activer les notifications pour être averti de votre commande.';
      }
    });
  }

  function onScanError(errorMessage) {
    console.warn(`Erreur de scan : ${errorMessage}`);
    // Afficher un message d'erreur plus convivial à l'utilisateur
    qrReaderElement.innerHTML = `<p>Erreur de caméra ou pas de QR code détecté.<br>Assurez-vous d'autoriser l'accès à la caméra.</p>`;
  }

  html5QrCodeScanner.render(onScanSuccess, onScanError);
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
    BC: 'Bien Cuit',
    AP: 'À Point',
    S: 'Saignant',
    B: 'Bleu',
  };
  const cookingColorClasses = {
    // Pour le style CSS
    BC: 'bc',
    AP: 'ap',
    S: 's',
    B: 'b',
  };

  let managerPin = MANAGER_DEFAULT_PIN; // PIN par défaut, sera mis à jour depuis Firestore

  // Charger le PIN Manager depuis Firestore
  async function loadManagerPin() {
    const docRef = doc(db, 'config', MANAGER_PIN_DOC_ID);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      managerPin = docSnap.data().pin;
      console.log('PIN Manager chargé depuis Firestore:', managerPin);
    } else {
      // Créer le document avec le PIN par défaut si non trouvé
      await setDoc(docRef, { pin: MANAGER_DEFAULT_PIN });
      console.log('PIN Manager par défaut créé dans Firestore:', MANAGER_DEFAULT_PIN);
    }
  }

  // Afficher l'interface Manager après authentification
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
      authErrorMessage.innerText = 'Code PIN incorrect. Veuillez réessayer.';
    }
  });

  // Écoute des commandes en temps réel et affichage
  let unsubscribeOrders = null; // Pour pouvoir désabonner l'écoute

  function startOrderListener() {
    if (unsubscribeOrders) {
      unsubscribeOrders(); // Désabonner si déjà actif
    }

    const ordersCollectionRef = collection(db, 'orders');
    // Trier par statut (pending/ready/relance d'abord, puis delivered/lost_turn)
    // et ensuite par createdAt pour les commandes en cours.
    const q = query(ordersCollectionRef, orderBy('status'), orderBy('createdAt', 'asc'));

    unsubscribeOrders = onSnapshot(q, (snapshot) => {
      let activeOrders = [];
      let deliveredAndLostOrders = [];

      snapshot.docs.forEach((doc) => {
        const order = { id: doc.id, ...doc.data() };
        if (order.status === 'delivered' || order.status === 'lost_turn') {
          deliveredAndLostOrders.push(order);
        } else {
          activeOrders.push(order);
        }
      });

      // Retrier les commandes actives par createdAt pour s'assurer que les plus anciennes sont en haut
      activeOrders.sort((a, b) => {
        const aTime = a.createdAt
          ? a.createdAt.toDate
            ? a.createdAt.toDate().getTime()
            : a.createdAt
          : 0;
        const bTime = b.createdAt
          ? b.createdAt.toDate
            ? b.createdAt.toDate().getTime()
            : b.createdAt
          : 0;
        return aTime - bTime;
      });

      // Combiner les listes (actives d'abord, puis livrées/perdues)
      const sortedOrders = activeOrders.concat(deliveredAndLostOrders);

      ordersList.innerHTML = ''; // Nettoyer la liste
      if (sortedOrders.length === 0) {
        ordersList.innerHTML = '<p>Aucune commande en cours.</p>';
        return;
      }

      // Gérer le filtre de recherche
      const searchTerm = pinSearchInput.value.trim().toUpperCase();
      const filteredOrders = searchTerm
        ? sortedOrders.filter((order) => order.pin.includes(searchTerm))
        : sortedOrders;

      if (filteredOrders.length === 0 && searchTerm) {
        ordersList.innerHTML = `<p>Aucun PIN '${searchTerm}' trouvé.</p>`;
        return;
      }

      filteredOrders.forEach((order) => {
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
          const orderRef = doc(db, 'orders', order.id);
          if (order.status === 'pending') {
            // Passe à READY, la Cloud Function va envoyer la 1ère notification
            await updateDoc(orderRef, {
              status: 'ready',
              readyTimestamp: Date.now(), // Enregistre le timestamp de la mise en prêt
              relanceCount: 0, // Réinitialise le compteur de relance
            });
            console.log(`Commande ${order.pin} marquée comme PRÊTE.`);
          } else if (order.status === 'ready' || order.status === 'relance') {
            // Passe à DELIVERED
            await updateDoc(orderRef, { status: 'delivered' });
            console.log(`Commande ${order.pin} marquée comme LIVRÉE.`);
          }
          // Si le statut est déjà 'delivered' ou 'lost_turn', on ne fait rien au clic pour l'instant
        });
        ordersList.appendChild(orderItem);
      });
    });
  }

  // Gérer la recherche
  pinSearchInput.addEventListener('input', () => {
    // La recherche est gérée directement par onSnapshot qui est réévalué
    // Pas besoin de rappeler startOrderListener, l'écoute en temps réel gérera la mise à jour de l'UI.
    // On force juste une mise à jour visuelle pour que le filtre soit appliqué immédiatement.
    const searchTerm = pinSearchInput.value.trim().toUpperCase();
    const orders = Array.from(ordersList.children);
    orders.forEach((item) => {
      const pin = item.querySelector('.pin').innerText;
      if (searchTerm === '' || pin.includes(searchTerm)) {
        item.style.display = '';
      } else {
        item.style.display = 'none';
      }
    });
    if (searchTerm !== '' && orders.filter((item) => item.style.display !== 'none').length === 0) {
      ordersList.innerHTML = `<p>Aucun PIN '${searchTerm}' trouvé.</p>`;
    } else if (searchTerm === '' && orders.length === 0) {
      ordersList.innerHTML = '<p>Aucune commande en cours.</p>';
    }
  });

  // Charger le PIN Manager au démarrage de la page Manager
  loadManagerPin();
}

// --- Enregistrement du Service Worker (pour les notifications en arrière-plan) ---
// Ce code doit être au tout début du fichier app.js et exécuté pour toutes les pages.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/firebase-messaging-sw.js')
      .then((registration) => {
        console.log('Service Worker enregistré avec succès:', registration);
      })
      .catch((error) => {
        console.error("Échec de l'enregistrement du Service Worker:", error);
      });
  });
}
