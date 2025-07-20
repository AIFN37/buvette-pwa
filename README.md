# La Table de Foulques Nerra

Application Progressive Web App (PWA) pour la gestion des commandes de repas dans une buvette de fête rurale.

## Fonctionnalités

### Module Guest (Client)

- Scan de QR code pour obtenir un PIN unique.
- Affichage du PIN, du type de cuisson et du statut de la commande.
- Compte à rebours de 90 secondes une fois le plat prêt.
- Notifications push et sonnerie lorsque le plat est prêt ou en relance.
- Gestion de la "perte de tour" après plusieurs relances non récupérées.

### Module Manager

- Authentification simple par code PIN.
- Liste des commandes en cours, triées par ancienneté.
- Affichage du PIN, du type de cuisson (abréviation colorée) et du statut.
- Changement de statut de commande en un clic (En Préparation -> Prêt -> Livré).
- Système de relance automatique des notifications (toutes les 30s) pour les plats prêts non récupérés.
- Gestion de la "perte de tour" et remise en file d'attente pour les plats non réclamés.
- Zone de recherche pour trouver une commande par PIN.

## Technologies Utilisées

- **Frontend:** HTML, CSS, JavaScript (PWA)
- **Backend/Base de données/Notifications:** Firebase (Firestore, Cloud Messaging, Cloud Functions)
- **Déploiement Frontend:** Netlify
- **Scan QR Code:** html5-qrcode

## Configuration et Déploiement

Voir les instructions de déploiement spécifiques pour Firebase et Netlify.
