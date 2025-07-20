// public/firebase-messaging-sw.js
// IMPORTANT : Ce fichier DOIT être à la racine de votre dossier "public"
// pour que le Service Worker ait la portée correcte.

// Importez les scripts Firebase nécessaires via importScripts.
// Ces scripts rendent les objets 'firebase' et 'firebase.messaging' disponibles globalement.
importScripts('https://www.gstatic.com/firebasejs/10.4.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.4.0/firebase-messaging-compat.js');

// La configuration Firebase doit être disponible globalement pour le Service Worker.
// Nous allons la récupérer via un importScripts de firebase-config.js
// Assurez-vous que firebase-config.js ne contient que l'objet 'firebaseConfig' et PAS de 'export'.
importScripts('./firebase-config.js'); // Le chemin est relatif au Service Worker (dans le même dossier 'public')

// Initialisez l'application Firebase dans le Service Worker.
// L'objet 'firebaseConfig' est maintenant disponible globalement grâce à l'importScripts ci-dessus.
self.firebase.initializeApp(firebaseConfig);

// Récupérez l'instance de Messaging.
const messaging = self.firebase.messaging();

// Gérer les messages en arrière-plan (quand l'app n'est pas ouverte/en focus).
messaging.onBackgroundMessage((payload) => {
    console.log('[firebase-messaging-sw.js] Message d\'arrière-plan reçu :', payload);

    // Personnalisez ici l'affichage de la notification
    const notificationTitle = payload.notification.title;
    const notificationOptions = {
        body: payload.notification.body,
        icon: '/images/icon-192x192.png', // Chemin vers l'icône de votre PWA
        data: payload.data // Inclure les données pour pouvoir les utiliser au clic
    };

    // Affichez la notification.
    self.registration.showNotification(notificationTitle, notificationOptions);

    // Note : Jouer une sonnerie directement depuis le Service Worker pour les notifications
    // en arrière-plan est très limité et dépend du système d'exploitation et du navigateur.
    // La plupart du temps, le système gère sa propre sonnerie par défaut pour les notifications.
});

// Optionnel : Gérer le clic sur la notification
self.addEventListener('notificationclick', (event) => {
    event.notification.close(); // Ferme la notification

    const data = event.notification.data; // Récupère les données passées avec la notification

    // Ouvrir la PWA sur la page du Guest avec le PIN spécifique
    const urlToOpen = new URL('/guest.html', self.location.origin).href;

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if (client.url.includes(urlToOpen) && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen);
            }
            return null;
        })
    );
});
