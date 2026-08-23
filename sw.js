// Teranga Trans — Service Worker
// Objectif : permettre aux utilisateurs (PWA ajoutee a l'ecran d'accueil) de
// recevoir automatiquement les nouvelles versions de l'app, au lieu de rester
// bloques sur une ancienne copie mise en cache par le telephone.
//
// A CHAQUE DEPLOIEMENT : incrementez CACHE_VERSION ci-dessous. C'est ce qui
// force le navigateur a considerer qu'une nouvelle version existe.
const CACHE_VERSION = 'teranga-trans-v2';

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.jpg',
  './auth-bg.jpg',
  './hero-bus.jpg'
];

// INSTALL : met en cache les fichiers de base de la nouvelle version, PUIS
// active immediatement cette nouvelle version (skipWaiting automatique).
// Les utilisateurs n'ont plus rien a cliquer : des qu'une nouvelle version
// est deployee, elle prend le controle toute seule au prochain chargement.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

// ACTIVATE : supprime les anciens caches (versions precedentes) et prend le
// controle immediatement des pages ouvertes.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// FETCH : strategie "network-first" pour le HTML (toujours essayer d'aller
// chercher la derniere version sur le serveur ; si hors-ligne, on retombe sur
// le cache). Pour les autres ressources (images, manifest), on privilegie le
// cache pour la vitesse, avec mise a jour en arriere-plan.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const isNavigation = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  if (isNavigation) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, resClone));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, resClone));
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
