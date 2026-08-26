/* =========================================================
   POST /api/scan-embarquement
   A AJOUTER dans ton serveur Render (index.js), a cote de tes
   routes existantes /api/create-payment et /api/pay-from-wallet.

   Body attendu : { resId: string, token: string }
   Header requis : Authorization: Bearer <idToken Firebase>
   (c'est deja ce que fait callServer() cote client)

   Ce que ca fait, en UNE transaction atomique cote serveur
   (Admin SDK -> ignore firestore.rules, c'est normal et voulu
   car c'est un serveur de confiance) :
     1. Verifie le token Firebase -> recupere l'uid de l'appelant
     2. Verifie que l'appelant est bien le CHAUFFEUR assigne a
        cette reservation
     3. Verifie que le token du QR correspond exactement
     4. Verifie que le billet n'a pas deja ete scanne
        (anti-fraude / anti double-credit)
     5. Marque l'embarquement valide
     6. Credite le solde du chauffeur du montant montantChauffeur,
        UNE SEULE FOIS (paiementChauffeurVerse protege contre
        un rejeu de la requete)

   Adapte les noms (admin, db, requireAuth...) a ton fichier
   existant si tu as deja ces utilitaires ailleurs.
   ========================================================= */

const admin = require('firebase-admin'); // deja initialise ailleurs dans ton serveur
const db = admin.firestore();

// Si tu as deja un middleware d'auth (utilise par /api/pay-from-wallet
// par exemple), reutilise-le plutot que cette fonction.
async function getUidFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) throw new Error('Non authentifié.');
  const decoded = await admin.auth().verifyIdToken(match[1]);
  return decoded.uid;
}

// A monter dans ton app Express existante, ex:
// app.post('/api/scan-embarquement', handleScanEmbarquement);
async function handleScanEmbarquement(req, res) {
  try {
    const uid = await getUidFromRequest(req);
    const { resId, token } = req.body || {};
    if (!resId || !token) {
      return res.status(400).json({ error: 'resId et token requis.' });
    }

    let credited = 0;

    await db.runTransaction(async (tx) => {
      const resRef = db.collection('reservations').doc(resId);
      const resSnap = await tx.get(resRef);
      if (!resSnap.exists) throw new Error('Réservation introuvable.');
      const data = resSnap.data();

      // Seul le chauffeur assigné à CETTE réservation peut valider ce scan.
      if (data.chauffeurId !== uid) {
        throw new Error("Tu n'es pas le chauffeur assigné à cette réservation.");
      }
      if (data.qrToken !== token) {
        throw new Error('Billet invalide.');
      }
      if (data.embarquementValide) {
        throw new Error('Ce billet a déjà été scanné.');
      }

      const updatePayload = {
        embarquementValide: true,
        embarquementAt: admin.firestore.FieldValue.serverTimestamp(),
        embarquementPar: uid,
      };

      const part = Number(data.montantChauffeur || 0);
      const dejaVerse = !!data.paiementChauffeurVerse;

      if (!dejaVerse && part > 0) {
        updatePayload.paiementChauffeurVerse = true;
        tx.update(db.collection('users').doc(uid), {
          solde: admin.firestore.FieldValue.increment(part),
        });
        credited = part;
      }

      tx.update(resRef, updatePayload);
    });

    return res.json({ ok: true, credited });
  } catch (err) {
    console.error('Erreur /api/scan-embarquement', err);
    return res.status(400).json({ error: err.message || 'Scan impossible.' });
  }
}

module.exports = { handleScanEmbarquement };
