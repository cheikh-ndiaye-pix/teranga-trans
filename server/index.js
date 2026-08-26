const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");
const admin = require("firebase-admin");
require("dotenv").config();

// Initialise Firebase Admin avec les credentials du projet
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

const PAYTECH_API_KEY = process.env.PAYTECH_API_KEY;
const PAYTECH_API_SECRET = process.env.PAYTECH_API_SECRET;
const PAYTECH_ENV = process.env.PAYTECH_ENV || "test";
const APP_BASE_URL = process.env.APP_BASE_URL;

// Vérifie le token Firebase envoyé par le client
async function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Non authentifié" });
  }
  const token = authHeader.split("Bearer ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Token invalide" });
  }
}

// 1. Créer un paiement PayTech
app.post("/api/create-payment", verifyAuth, async (req, res) => {
  const { amount, itemName, ref_command } = req.body;

  if (!amount || !itemName || !ref_command) {
    return res.status(400).json({ error: "amount, itemName et ref_command sont requis." });
  }

  try {
    const response = await fetch("https://paytech.sn/api/payment/request-payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API_KEY": PAYTECH_API_KEY,
        "API_SECRET": PAYTECH_API_SECRET,
      },
      body: JSON.stringify({
        item_name: itemName,
        item_price: amount,
        currency: "XOF",
        ref_command: ref_command,
        command_name: itemName,
        env: PAYTECH_ENV,
        ipn_url: `${APP_BASE_URL}/api/ipn`,
        success_url: `${APP_BASE_URL}/payment-success`,
        cancel_url: `${APP_BASE_URL}/payment-cancel`,
        // uid ET amount stockes ici : le webhook IPN ne peut PAS faire
        // confiance a item_price renvoye par PayTech pour le montant a
        // crediter (voir /api/ipn), donc on fige le montant ici, cote
        // serveur, au moment ou ON initie le paiement.
        custom_field: JSON.stringify({ uid: req.uid, amount }),
      }),
    });

    const result = await response.json();

    if (!response.ok || result.success !== 1) {
      return res.status(500).json({ error: "Erreur PayTech", details: result });
    }

    await db.collection("payments").doc(ref_command).set({
      uid: req.uid,
      amount,
      itemName,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true, redirect_url: result.redirect_url, token: result.token });
  } catch (error) {
    console.error("Erreur create-payment:", error);
    return res.status(500).json({ error: error.message });
  }
});

// 2. IPN PayTech (webhook, pas d'authentification client)
app.post("/api/ipn", async (req, res) => {
  try {
    const { type_event, ref_command, custom_field, api_key_sha256, api_secret_sha256 } = req.body;

    const expectedKeyHash = crypto.createHash("sha256").update(PAYTECH_API_KEY).digest("hex");
    const expectedSecretHash = crypto.createHash("sha256").update(PAYTECH_API_SECRET).digest("hex");

    if (api_key_sha256 !== expectedKeyHash || api_secret_sha256 !== expectedSecretHash) {
      console.error("IPN reçu avec des clés invalides !");
      return res.status(403).send("Forbidden");
    }

    if (!ref_command) return res.status(400).send("ref_command manquant");

    const paymentRef = db.collection("payments").doc(ref_command);
    const paymentSnap = await paymentRef.get();
    if (!paymentSnap.exists) {
      console.error("IPN reçu pour un paiement inconnu :", ref_command);
      return res.status(404).send("Paiement introuvable");
    }
    const custom = custom_field ? JSON.parse(custom_field) : {};
    // On ne fait JAMAIS confiance a un montant venu du corps de la requete
    // IPN : on recredite le montant qu'ON a nous-meme enregistre au moment
    // de la creation du paiement (payments/{ref_command}.amount), pas
    // item_price ni custom_field.amount qui pourraient etre falsifies.
    const amount = Number(paymentSnap.data().amount || 0);

    if (type_event === "sale_complete") {
      // Idempotence : si ce paiement a deja ete marque "completed" (IPN
      // rejoue par PayTech, retard reseau...), on ne recredite pas deux fois.
      if (paymentSnap.data().status === "completed") {
        return res.status(200).send("OK (déjà traité)");
      }
      await paymentRef.update({ status: "completed", completedAt: admin.firestore.FieldValue.serverTimestamp() });
      if (custom.uid && amount > 0) {
        // BUG CORRIGÉ : l'app lit/affiche le champ "solde", pas "walletBalance".
        // L'ancien code créditait un champ que personne ne lisait jamais.
        await db.collection("users").doc(custom.uid).set(
          { solde: admin.firestore.FieldValue.increment(amount) },
          { merge: true }
        );
        // Historique de recharge, lu par le client dans son portefeuille
        // (collection "rechargements", absente jusqu'ici -> historique
        // toujours vide).
        await db.collection("rechargements").add({
          clientId: custom.uid,
          montant: amount,
          statut: "validee",
          refCommand: ref_command,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } else if (type_event === "sale_canceled") {
      await paymentRef.update({ status: "canceled", canceledAt: admin.firestore.FieldValue.serverTimestamp() });
      if (custom.uid && amount > 0) {
        await db.collection("rechargements").add({
          clientId: custom.uid,
          montant: amount,
          statut: "echouee",
          refCommand: ref_command,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Erreur IPN:", error);
    return res.status(500).send("Erreur serveur");
  }
});

// 3. Payer depuis le wallet — supporte une offre (proposition) ou un trajet publié
app.post("/api/pay-from-wallet", verifyAuth, async (req, res) => {
  const { type, id, passagers } = req.body;
  const uid = req.uid;

  if (!type || !id) {
    return res.status(400).json({ error: "type et id sont requis." });
  }

  const userRef = db.collection("users").doc(uid);

  try {
    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error("Utilisateur introuvable.");
      const currentBalance = userDoc.data().solde || 0;

      if (type === "proposition") {
        const propRef = db.collection("propositions").doc(id);
        const propDoc = await transaction.get(propRef);
        if (!propDoc.exists) throw new Error("Offre introuvable.");
        const prop = propDoc.data();
        if (prop.clientId !== uid) throw new Error("Cette offre ne t'appartient pas.");
        if (prop.statut !== "en_attente") throw new Error("Cette offre n'est plus disponible.");

        const prix = Number(prop.prixTotal || 0);
        if (currentBalance < prix) throw new Error("Solde insuffisant.");

        const resRef = db.collection("reservations").doc(prop.reservationId);
        const resDoc = await transaction.get(resRef);
        if (!resDoc.exists || resDoc.data().statut !== "en_attente") {
          throw new Error("Cette demande n'est plus disponible.");
        }

        transaction.update(userRef, { solde: currentBalance - prix });
        transaction.update(resRef, {
          statut: "confirmee",
          chauffeurId: prop.chauffeurId,
          chauffeurNom: prop.chauffeurNom,
          chauffeurTelephone: prop.chauffeurTelephone || "",
          busId: prop.busId || null,
          busImmat: prop.busImmat || null,
          busEquipements: prop.busEquipements || null,
          prix: prix,
          commission: prop.commission,
          montantChauffeur: prop.prixPropose,
          paiementStatut: "paye",
          propositionId: id,
        });
        transaction.update(propRef, { statut: "acceptee" });
      } else if (type === "trajet") {
        const trajetRef = db.collection("trajetsProposes").doc(id);
        const trajetDoc = await transaction.get(trajetRef);
        if (!trajetDoc.exists) throw new Error("Trajet introuvable.");
        const trajet = trajetDoc.data();
        if (trajet.statut !== "ouvert") throw new Error("Ce trajet n'est plus disponible.");

        const prix = Number(trajet.prixTotal || 0);
        if (currentBalance < prix) throw new Error("Solde insuffisant.");
        if (!passagers || passagers <= 0 || passagers > trajet.placesDisponibles) {
          throw new Error("Nombre de passagers invalide.");
        }

        const resRef = db.collection("reservations").doc();
        transaction.set(resRef, {
          clientId: uid,
          typeEvenement: "Trajet proposé",
          dateEvenement: trajet.dateEvenement,
          lieuDepart: trajet.lieuDepart,
          lieuArrivee: trajet.lieuArrivee,
          nbPassagers: passagers,
          equipementsSouhaites: [],
          notes: "",
          statut: "confirmee",
          busId: trajet.busId || null,
          busImmat: trajet.busImmat || null,
          busEquipements: trajet.busEquipements || null,
          chauffeurId: trajet.chauffeurId,
          chauffeurNom: trajet.chauffeurNom,
          chauffeurTelephone: trajet.chauffeurTelephone || "",
          prix: prix,
          commission: trajet.commission,
          montantChauffeur: trajet.prixPropose,
          paiementStatut: "paye",
          trajetId: id,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        transaction.update(userRef, { solde: currentBalance - prix });
        transaction.update(trajetRef, { statut: "reserve" });
      } else {
        throw new Error("Type de paiement inconnu.");
      }
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Erreur pay-from-wallet:", error);
    return res.status(400).json({ error: error.message });
  }
});

// 4. Scan du billet QR par le chauffeur -> valide l'embarquement ET verse
//    sa part (montantChauffeur) sur son solde, en une seule transaction.
//    C'est CE endpoint qui garantit que l'argent du client ne va jamais
//    directement au chauffeur : il reste "en attente" sur la reservation
//    jusqu'a ce scan.
app.post("/api/scan-embarquement", verifyAuth, async (req, res) => {
  const { resId, token } = req.body;
  const uid = req.uid;

  if (!resId || !token) {
    return res.status(400).json({ error: "resId et token sont requis." });
  }

  try {
    let credited = 0;

    await db.runTransaction(async (transaction) => {
      const resRef = db.collection("reservations").doc(resId);
      const resDoc = await transaction.get(resRef);
      if (!resDoc.exists) throw new Error("Réservation introuvable.");
      const data = resDoc.data();

      if (data.chauffeurId !== uid) {
        throw new Error("Tu n'es pas le chauffeur assigné à cette réservation.");
      }
      if (data.qrToken !== token) {
        throw new Error("Billet invalide.");
      }
      if (data.embarquementValide) {
        throw new Error("Ce billet a déjà été scanné.");
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
        transaction.update(db.collection("users").doc(uid), {
          solde: admin.firestore.FieldValue.increment(part),
        });
        credited = part;
      }

      transaction.update(resRef, updatePayload);
    });

    return res.json({ success: true, credited });
  } catch (error) {
    console.error("Erreur scan-embarquement:", error);
    return res.status(400).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
