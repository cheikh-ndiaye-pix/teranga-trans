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
        custom_field: JSON.stringify({ uid: req.uid }),
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
    const { type_event, ref_command, item_price, custom_field, api_key_sha256, api_secret_sha256 } = req.body;

    const expectedKeyHash = crypto.createHash("sha256").update(PAYTECH_API_KEY).digest("hex");
    const expectedSecretHash = crypto.createHash("sha256").update(PAYTECH_API_SECRET).digest("hex");

    if (api_key_sha256 !== expectedKeyHash || api_secret_sha256 !== expectedSecretHash) {
      console.error("IPN reçu avec des clés invalides !");
      return res.status(403).send("Forbidden");
    }

    if (!ref_command) return res.status(400).send("ref_command manquant");

    const paymentRef = db.collection("payments").doc(ref_command);
    const custom = custom_field ? JSON.parse(custom_field) : {};

    if (type_event === "sale_complete") {
      await paymentRef.update({ status: "completed", completedAt: admin.firestore.FieldValue.serverTimestamp() });
      if (custom.uid) {
        await db.collection("users").doc(custom.uid).set(
          { walletBalance: admin.firestore.FieldValue.increment(Number(item_price)) },
          { merge: true }
        );
      }
    } else if (type_event === "sale_canceled") {
      await paymentRef.update({ status: "canceled", canceledAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Erreur IPN:", error);
    return res.status(500).send("Erreur serveur");
  }
});

// 3. Payer une réservation depuis le wallet
app.post("/api/pay-from-wallet", verifyAuth, async (req, res) => {
  const { reservationId, amount } = req.body;
  const uid = req.uid;

  if (!reservationId || !amount) {
    return res.status(400).json({ error: "reservationId et amount sont requis." });
  }

  const userRef = db.collection("users").doc(uid);
  const reservationRef = db.collection("reservations").doc(reservationId);

  try {
    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error("Utilisateur introuvable.");

      const currentBalance = userDoc.data().walletBalance || 0;
      if (currentBalance < amount) throw new Error("Solde insuffisant.");

      transaction.update(userRef, { walletBalance: admin.firestore.FieldValue.increment(-amount) });
      transaction.update(reservationRef, {
        status: "paid",
        paidVia: "wallet",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Erreur pay-from-wallet:", error);
    return res.status(400).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));