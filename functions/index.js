const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch"); // si erreur, fais "npm install node-fetch@2" dans functions/

admin.initializeApp();
const db = admin.firestore();

// Clés PayTech depuis les variables d'environnement (.env)
const PAYTECH_API_KEY = process.env.PAYTECH_API_KEY;
const PAYTECH_API_SECRET = process.env.PAYTECH_API_SECRET;
const PAYTECH_ENV = process.env.PAYTECH_ENV || "test"; // "test" ou "prod"
const APP_BASE_URL = process.env.APP_BASE_URL;

/**
 * 1. createPaytechPayment
 * Fonction callable : le client l'appelle pour démarrer un paiement PayTech.
 * Attend { amount, itemName, ref_command } depuis le client.
 */
exports.createPaytechPayment = functions.https.onCall(async (data, context) => {
  // Vérifie que l'utilisateur est connecté
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Tu dois être connecté pour effectuer un paiement."
    );
  }

  const { amount, itemName, ref_command } = data;

  if (!amount || !itemName || !ref_command) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "amount, itemName et ref_command sont requis."
    );
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
        ipn_url: `${APP_BASE_URL}/paytechIPN`, // adapte si l'URL de la function diffère
        success_url: `${APP_BASE_URL}/payment-success`,
        cancel_url: `${APP_BASE_URL}/payment-cancel`,
        custom_field: JSON.stringify({ uid: context.auth.uid }),
      }),
    });

    const result = await response.json();

    if (!response.ok || result.success !== 1) {
      throw new functions.https.HttpsError(
        "internal",
        "Erreur PayTech: " + JSON.stringify(result)
      );
    }

    // Enregistre la tentative de paiement dans Firestore
    await db.collection("payments").doc(ref_command).set({
      uid: context.auth.uid,
      amount,
      itemName,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      redirect_url: result.redirect_url,
      token: result.token,
    };
  } catch (error) {
    console.error("Erreur createPaytechPayment:", error);
    throw new functions.https.HttpsError("internal", error.message);
  }
});

/**
 * 2. paytechIPN
 * Fonction HTTP (pas callable) : PayTech appelle cette URL après un paiement
 * pour confirmer le statut (succès ou échec).
 */
exports.paytechIPN = functions.https.onRequest(async (req, res) => {
  try {
    const {
      type_event,
      ref_command,
      item_price,
      custom_field,
      api_key_sha256,
      api_secret_sha256,
    } = req.body;

    // Vérification de sécurité : PayTech envoie le hash de tes clés
    const crypto = require("crypto");
    const expectedKeyHash = crypto.createHash("sha256").update(PAYTECH_API_KEY).digest("hex");
    const expectedSecretHash = crypto.createHash("sha256").update(PAYTECH_API_SECRET).digest("hex");

    if (api_key_sha256 !== expectedKeyHash || api_secret_sha256 !== expectedSecretHash) {
      console.error("IPN reçu avec des clés invalides !");
      return res.status(403).send("Forbidden");
    }

    if (!ref_command) {
      return res.status(400).send("ref_command manquant");
    }

    const paymentRef = db.collection("payments").doc(ref_command);
    const custom = custom_field ? JSON.parse(custom_field) : {};

    if (type_event === "sale_complete") {
      // Paiement réussi
      await paymentRef.update({
        status: "completed",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Crédite le solde de l'utilisateur si c'est un rechargement de wallet
      if (custom.uid) {
        const userRef = db.collection("users").doc(custom.uid);
        await userRef.set(
          {
            walletBalance: admin.firestore.FieldValue.increment(Number(item_price)),
          },
          { merge: true }
        );
      }
    } else if (type_event === "sale_canceled") {
      await paymentRef.update({
        status: "canceled",
        canceledAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Erreur paytechIPN:", error);
    return res.status(500).send("Erreur serveur");
  }
});

/**
 * 3. payReservationFromWallet
 * Fonction callable : paie une réservation directement depuis le solde
 * (wallet) de l'utilisateur, sans passer par PayTech.
 */
exports.payReservationFromWallet = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Tu dois être connecté."
    );
  }

  const { reservationId, amount } = data;
  const uid = context.auth.uid;

  if (!reservationId || !amount) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "reservationId et amount sont requis."
    );
  }

  const userRef = db.collection("users").doc(uid);
  const reservationRef = db.collection("reservations").doc(reservationId);

  try {
    // Transaction pour éviter les doubles paiements / soldes incohérents
    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        throw new functions.https.HttpsError("not-found", "Utilisateur introuvable.");
      }

      const currentBalance = userDoc.data().walletBalance || 0;

      if (currentBalance < amount) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Solde insuffisant."
        );
      }

      // Débite le solde
      transaction.update(userRef, {
        walletBalance: admin.firestore.FieldValue.increment(-amount),
      });

      // Marque la réservation comme payée
      transaction.update(reservationRef, {
        status: "paid",
        paidVia: "wallet",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return { success: true };
  } catch (error) {
    console.error("Erreur payReservationFromWallet:", error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError("internal", error.message);
  }
})