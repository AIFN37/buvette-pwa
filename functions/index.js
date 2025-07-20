// functions/index.js

// Importez les modules nécessaires pour les fonctions de 2ème génération
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onCall } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

// Importez spécifiquement Firestore pour l'accès à la base de données
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// Initialisez l'Admin SDK de Firebase
admin.initializeApp();

// Initialisez l'instance Firestore
const db = getFirestore();

// Définition de la fonction Cloud qui s'active lorsqu'une commande est mise à jour dans Firestore
// Cette fonction utilise le déclencheur onDocumentUpdated de la V2.
exports.sendNotificationOnOrderStatusChange = onDocumentUpdated(
  'orders/{orderId}', // Surveille les mises à jour dans la collection 'orders'
  async (event) => {
    // Vérifiez si le document avant et après la mise à jour existe
    if (!event.data || !event.data.before || !event.data.after) {
      console.log("Aucune donnée pour l'événement de mise à jour du document. Ignoré.");
      return null;
    }

    const newValue = event.data.after.data(); // Les nouvelles données du document
    const previousValue = event.data.before.data(); // Les anciennes données du document
    const orderId = event.params.orderId; // L'ID du document mis à jour (depuis les paramètres de l'événement)

    // --- Logique de gestion de la notification initiale "Plat prêt" ---
    // Vérifie si le statut est passé de "pending" à "ready"
    if (previousValue.status === 'pending' && newValue.status === 'ready') {
      const fcmToken = newValue.fcmToken; // Le jeton FCM de l'appareil du Guest
      const pin = newValue.pin; // Le code PIN de la commande

      if (!fcmToken) {
        console.log(
          `Pas de jeton FCM pour la commande PIN: ${pin}, impossible d'envoyer la notification initiale.`
        );
        return null;
      }

      const message = {
        notification: {
          title: 'Votre plat est PRÊT !',
          body: `Votre commande (PIN: ${pin}) est prête. Venez la récupérer !`,
        },
        data: {
          // Données personnalisées accessibles côté client
          pin: pin,
          status: 'ready',
          type: 'initial_ready', // Type de notification pour le client
        },
        token: fcmToken,
      };

      try {
        await admin.messaging().send(message);
        console.log(`Notification initiale "Plat prêt" envoyée pour le PIN: ${pin}`);

        // Mettre à jour la commande pour marquer l'heure de la première notification
        await db.collection('orders').doc(orderId).update({
          notificationSentAt: FieldValue.serverTimestamp(), // Enregistre l'heure du serveur
          notificationCount: 0, // Réinitialise le compteur de relances
        });
      } catch (error) {
        console.error(
          `Erreur lors de l'envoi de la notification initiale pour le PIN ${pin}:`,
          error
        );
      }
    }

    // --- Logique des relances de notification et "perte de tour" ---
    // Cette partie est cruciale. Elle s'active à chaque mise à jour.
    // On vérifie que la commande est "ready", qu'une notification a déjà été envoyée
    // et que le compteur de relances est dans la plage attendue.
    if (
      newValue.status === 'ready' &&
      newValue.notificationSentAt &&
      newValue.notificationCount !== undefined
    ) {
      const now = admin.firestore.Timestamp.now();
      const notificationSentAt = newValue.notificationSentAt;
      const notificationCount = newValue.notificationCount;

      // Calcule le temps écoulé depuis la première notification "plat prêt"
      const elapsedTimeSeconds = (now.toMillis() - notificationSentAt.toMillis()) / 1000;

      // Déclenche une relance toutes les 30 secondes, pour un maximum de 3 relances (soit 90 secondes au total)
      // La condition est `elapsedTimeSeconds >= 30 * (notificationCount + 1)` pour gérer les intervalles
      // Par exemple, si notificationCount est 0, on envoie à >= 30s. Si c'est 1, on envoie à >= 60s. Si c'est 2, on envoie à >= 90s.
      if (elapsedTimeSeconds >= 30 * (notificationCount + 1) && notificationCount < 3) {
        const fcmToken = newValue.fcmToken;
        const pin = newValue.pin;

        if (!fcmToken) {
          console.log(`Pas de jeton FCM pour le PIN ${pin}, relance non envoyée.`);
          return null;
        }

        let messageRelance = {};
        let newNotificationCount = notificationCount + 1;
        let updateData = { notificationCount: FieldValue.increment(1) };

        if (newNotificationCount < 3) {
          // Relance normale (1ère et 2ème relance)
          messageRelance = {
            notification: {
              title: 'Dépêchez-vous ça refroidit !',
              body: `Votre commande (PIN: ${pin}) est toujours prête. Venez vite !`,
            },
            data: {
              pin: pin,
              status: 'ready',
              type: 'reminder',
            },
            token: fcmToken,
          };
          console.log(`Relance ${newNotificationCount} envoyée pour le PIN: ${pin}`);
        } else {
          // 3ème relance : perte de tour
          messageRelance = {
            notification: {
              title: 'Attention ! Commande annulée.',
              body: `Votre commande (PIN: ${pin}) a été livrée à une autre personne. Veuillez repasser une commande.`,
            },
            data: {
              pin: pin,
              status: 'pending', // Le client repasse en attente sur son écran
              type: 'lost_turn',
            },
            token: fcmToken,
          };
          console.log(`Notification "Perte de tour" envoyée pour le PIN: ${pin}`);

          // Si c'est la 3ème relance, réinitialisez la commande
          updateData.status = 'pending'; // Repasse le statut en "En préparation"
          updateData.notificationSentAt = null; // Réinitialise le timer de notification
          updateData.notificationCount = 0; // Réinitialise le compteur
          updateData.createdAt = FieldValue.serverTimestamp(); // Met à jour l'heure de création pour la faire remonter
        }

        try {
          await admin.messaging().send(messageRelance);
          await db.collection('orders').doc(orderId).update(updateData);
          console.log(`Statut et compteur de relances mis à jour pour le PIN: ${pin}`);
        } catch (error) {
          console.error(`Erreur lors de l'envoi de la relance pour le PIN ${pin}:`, error);
        }
      }
    }

    return null;
  }
);

// --- Fonction Cloud pour gérer le PIN du Manager (utilisant la syntaxe V2 onCall) ---
// Cette fonction permet de définir ou de mettre à jour le code PIN du Manager dans Firestore.
// Elle sera appelée depuis votre frontend (Manager.html) pour vérifier et potentiellement modifier le PIN.
exports.setManagerPin = onCall(async (request) => {
  // Les données envoyées par le client sont dans request.data
  const newPin = request.data.pin;

  if (!newPin || typeof newPin !== 'string' || newPin.length !== 4) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Le PIN doit être une chaîne de 4 caractères.'
    );
  }

  try {
    await db.collection('settings').doc('managerPin').set({
      pin: newPin,
      lastUpdated: FieldValue.serverTimestamp(),
    });
    return { success: true, message: 'PIN du manager mis à jour.' };
  } catch (error) {
    // En cas d'erreur inattendue, renvoyez une erreur HTTPS standard
    throw new functions.https.HttpsError(
      'unknown',
      'Erreur lors de la mise à jour du PIN du manager.',
      error.message
    );
  }
});
