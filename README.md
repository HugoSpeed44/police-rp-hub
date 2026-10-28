# Pont API Render

Ce dossier est le backend à publier dans un dépôt GitHub dédié (les fichiers de ce dossier doivent être à la racine du dépôt). Il ne contient pas le site ni le bot Discord.

## Fichiers

- `server.js` : API HTTP, authentification par jeton et routes utilisées par le site.
- `db.js` : accès MySQL et initialisation des tables.
- `package.json` : dépendances et commande de démarrage.
- `render.yaml` : configuration Render sans identifiants.

## Variables Render

Renseigner `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` et `ALLOWED_ORIGIN` dans l'environnement Render. `ALLOWED_ORIGIN` doit être l'origine exacte du site InfinityFree, sans slash final. Ne jamais ajouter `.env` ni un mot de passe au dépôt.

Le compte utilisé pour se connecter au site doit exister dans `pm_officers` sur la base cible. Le service rend les endpoints utilisés par le site pour l'authentification, le pointage, les patrouilles et les casiers. Le bot Discord reste hébergé et configuré séparément.

Après création du service, copier son URL `onrender.com` dans `public/api-config.js` du site puis republier ce fichier et `public/app.js` sur InfinityFree.
