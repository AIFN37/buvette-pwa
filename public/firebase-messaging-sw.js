// public/firebase-messaging-sw.js
// IMPORTANT : Ce fichier DOIT être à la racine de votre dossier "public"
// pour que le Service Worker ait la portée correcte.

// Importez les scripts Firebase nécessaires via importScripts.
// Ces scripts rendent les objets 'firebase' et 'firebase.messaging' disponibles globalement.
importScripts('https://www.gstatic.com/firebasejs/10.4.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.4.0/firebase-messaging-compat.js');

// Pour importer la configuration depuis firebase-config.js qui utilise 'export',
// nous devons utiliser une approche différente dans le Service Worker.
// Nous allons faire une requête fetch pour charger le contenu du fichier
// et l'évaluer dans le contexte du Service Worker.
// C'est une solution de contournement pour les limitations d'import de modules ES dans les Service Workers.
fetch('./firebase-config.js')
    .then(response => response.text())
    .then(text => {
        // Évalue le texte du fichier pour rendre firebaseConfig disponible globalement
        // Cela est sûr car nous contrôlons le contenu de firebase-config.js
        eval(text);

        // Initialisez l'application Firebase APRÈS que firebaseConfig soit disponible.
        self.firebase.initializeApp(firebaseConfig);

        // Récupérez l'instance de Messaging.
        const messaging = self.firebase.messaging();

        // Gérer les messages en arrière-plan (quand l'app n'est pas ouverte/en focus).
        messaging.onBackgroundMessage((payload) => {
            console.log('[firebase-messaging-sw.js] Message d\'arrière-plan reçu :', payload);

            const notificationTitle = payload.notification.title;
            const notificationOptions = {
                body: payload.notification.body,
                icon: '/images/icon-192x192.png',
                data: payload.data
            };

            self.registration.showNotification(notificationTitle, notificationOptions);
        });

        // Gérer le clic sur la notification
        self.addEventListener('notificationclick', (event) => {
            event.notification.close();

            const data = event.notification.data;
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

    })
    .catch(error => {
        console.error('Erreur lors du chargement ou de l\'évaluation de firebase-config.js dans le Service Worker:', error);
    });

