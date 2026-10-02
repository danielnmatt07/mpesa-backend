const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin (handles both Render and local environment)
const secretPath = fs.existsSync("/etc/secrets/serviceAccountKey.json")
  ? "/etc/secrets/serviceAccountKey.json"
  : "./serviceAccountKey.json";

const serviceAccount = require(secretPath);

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

// 1. Initiate STK Push Endpoint
app.post("/api/initiate-stk", async (req, res) => {
  try {
    const { bookingId, phone, amount } = req.body;
    if (!phone || !amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid parameters." });
    }

    let formattedPhone = phone.replace(/[^0-9]/g, "");
    if (formattedPhone.startsWith("0")) formattedPhone = "254" + formattedPhone.slice(1);
    if (!formattedPhone.startsWith("254")) formattedPhone = "254" + formattedPhone;

    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    const shortCode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const callbackUrl = process.env.MPESA_CALLBACK_URL;
    const accountRef = process.env.MPESA_ACCOUNT_REF || "BRAIDWITHELL";

    const authHeader = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const tokenRes = await axios.get(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: `Basic ${authHeader}` } }
    );
    const accessToken = tokenRes.data.access_token;

    const date = new Date();
    const timestamp =
      date.getFullYear() +
      ("0" + (date.getMonth() + 1)).slice(-2) +
      ("0" + date.getDate()).slice(-2) +
      ("0" + date.getHours()).slice(-2) +
      ("0" + date.getMinutes()).slice(-2) +
      ("0" + date.getSeconds()).slice(-2);

    const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString("base64");

    const stkPayload = {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: shortCode,
      PhoneNumber: formattedPhone,
      CallBackURL: callbackUrl,
      AccountReference: accountRef,
      TransactionDesc: `Booking ${bookingId}`
    };

    const response = await axios.post(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      stkPayload,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    await db.collection("bookings").doc(bookingId).set({
      paymentStatus: "awaiting_payment",
      paymentPhone: formattedPhone,
      checkoutRequestId: response.data.CheckoutRequestID,
      merchantRequestId: response.data.MerchantRequestID,
      requestedAmount: Math.round(amount),
      requestedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ success: true, checkoutRequestId: response.data.CheckoutRequestID });
  } catch (error) {
    console.error("STK Push Error:", error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// 2. Webhook Callback Endpoint
app.post("/api/mpesa-callback", async (req, res) => {
  try {
    const callbackData = req.body.Body.stkCallback;
    const checkoutRequestId = callbackData.CheckoutRequestID;
    const resultCode = callbackData.ResultCode;

    const snapshot = await db.collection("bookings")
      .where("checkoutRequestId", "==", checkoutRequestId)
      .limit(1)
      .get();

    if (snapshot.empty) return res.status(404).send("Not Found");

    const bookingDoc = snapshot.docs[0];
    const bookingData = bookingDoc.data();

    if (resultCode === 0) {
      const metadata = callbackData.CallbackMetadata.Item;
      const amountPaid = metadata.find(i => i.Name === "Amount").Value;
      const mpesaReceipt = metadata.find(i => i.Name === "MpesaReceiptNumber").Value;

      const currentPaid = bookingData.amountPaid || 0;
      const newTotalPaid = currentPaid + amountPaid;
      const totalPrice = bookingData.price || 0;
      const newAmountDue = Math.max(0, totalPrice - newTotalPaid);

      const paymentLog = {
        amount: amountPaid,
        method: "mpesa",
        receipt: mpesaReceipt,
        phone: bookingData.paymentPhone,
        date: new Date().toISOString()
      };

      await bookingDoc.ref.update({
        paymentStatus: newAmountDue === 0 ? "paid" : "partially_paid",
        amountPaid: newTotalPaid,
        amountDue: newAmountDue,
        paymentHistory: FieldValue.arrayUnion(paymentLog)
      });
    } else {
      await bookingDoc.ref.update({ paymentStatus: "failed" });
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Callback Error:", err);
    res.status(500).send("Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));