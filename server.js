// MALIK-MD Session ID Generator
// Pairing-code flow: user links WhatsApp via 8-digit code -> we upload
// creds.json to the owner's Mega account -> return "MALIK-MD~<fileId>#<key>".
require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Storage } = require("megajs");
const QRCode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SESSIONS_ROOT = path.join(__dirname, "sessions");
if (!fs.existsSync(SESSIONS_ROOT)) fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

// token -> { sock, phone, createdAt, done, status, sessionId, timeout }
const pending = new Map();

// ---- simple in-memory rate limit: 5 pair requests / IP / hour ----
const rateMap = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const arr = (rateMap.get(ip) || []).filter((t) => now - t < hour);
  if (arr.length >= 5) return true;
  arr.push(now);
  rateMap.set(ip, arr);
  return false;
}

function cleanup(token, reason) {
  const rec = pending.get(token);
  if (!rec) return;
  clearTimeout(rec.timeout);
  try {
    rec.sock?.ws?.close();
  } catch (_) {}
  try {
    rec.sock?.end?.();
  } catch (_) {}
  const dir = path.join(SESSIONS_ROOT, token);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
  pending.delete(token);
  console.log(`[cleanup] ${token}: ${reason}`);
}

async function uploadToMega(phone, buffer) {
  const email = process.env.MEGA_EMAIL;
  const password = process.env.MEGA_PASSWORD;
  if (!email || !password) throw new Error("MEGA_EMAIL / MEGA_PASSWORD not set");

  const storage = await new Promise((resolve, reject) => {
    const s = new Storage({ email, password }, (err) => {
      if (err) reject(err);
      else resolve(s);
    });
  });

  const name = `malik-md-creds-${phone}.json`;
  const file = await new Promise((resolve, reject) => {
    storage.upload(name, buffer).complete((err, f) => {
      if (err) reject(err);
      else resolve(f);
    });
  });

  const link = await file.link(); // https://mega.nz/file/<fileId>#<key>
  storage.close?.();
  const m = link.match(/mega\.nz\/file\/([^#]+)#(.+)$/);
  if (!m) throw new Error("Could not parse Mega link");
  return { fileId: m[1], key: m[2] };
}

// Shared connection watcher for both pairing modes (code + QR).
// QR string ko PNG data-URL mein badal kar record mein rakh deta hai,
// taa ke page polling se QR dikha sake. Connect hone par creds Mega
// par upload karke SESSION_ID bana deta hai.
function watchConnection(token, rec, sock, dir) {
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try {
        rec.qrImage = await QRCode.toDataURL(qr, { width: 264, margin: 2 });
      } catch (_) {}
    }
    if (connection === "open" && !rec.done) {
      rec.done = true;
      console.log(`[${token}] connected, uploading creds to Mega...`);
      try {
        const credsPath = path.join(dir, "creds.json");
        const buffer = fs.readFileSync(credsPath);
        const { fileId, key } = await uploadToMega(rec.phone || "qr", buffer);
        rec.sessionId = `MALIK-MD~${fileId}#${key}`;
        rec.status = "connected";
        console.log(`[${token}] session ID ready`);
      } catch (err) {
        console.error(`[${token}] Mega upload failed:`, err.message);
        rec.status = "error";
      }
      clearTimeout(rec.timeout);
      try {
        sock.ws?.close();
      } catch (_) {}
      try {
        sock.end?.();
      } catch (_) {}
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
      setTimeout(() => pending.delete(token), 10 * 60 * 1000);
    }
    if (connection === "close" && !rec.done) {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${token}] connection closed (${code})`);
      if (code === DisconnectReason.loggedOut) {
        rec.status = "expired";
        cleanup(token, "logged out");
      }
    }
  });
}

app.post("/api/pair", async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (rateLimited(ip)) {
      return res.status(429).json({ error: "Too many requests. Try again in an hour." });
    }

    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    if (!/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({ error: "Phone number must be 10-15 digits (e.g. 923001234567)." });
    }

    const token = crypto.randomBytes(4).toString("hex");
    const dir = path.join(SESSIONS_ROOT, token);
    fs.mkdirSync(dir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false, // deprecated in v7; pairing-code only
      browser: ["MALIK-MD Session", "Chrome", "1.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    sock.ev.on("creds.update", saveCreds);

    const rec = { sock, phone, createdAt: Date.now(), done: false, status: "waiting", sessionId: null };
    rec.timeout = setTimeout(() => {
      rec.status = "expired";
      cleanup(token, "timeout (4 min)");
    }, 4 * 60 * 1000);
    pending.set(token, rec);

    // If already registered (edge case), fail fast
    if (sock.authState?.creds?.registered) {
      cleanup(token, "already registered");
      return res.status(400).json({ error: "This session is already registered." });
    }

    // WhatsApp se pura handshake hone ka intezar karo — socket bante hi
    // code mangne par aksar "Connection Closed" aa jata hai. Thora ruk
    // kar, aur band ho jaye to dobara koshish karke code mango.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function requestCodeWithRetry() {
      await sleep(3000);
      let lastErr;
      for (let i = 0; i < 3; i++) {
        try {
          return await sock.requestPairingCode(phone);
        } catch (e) {
          lastErr = e;
          if (!/connection closed/i.test(e.message)) throw e;
          await sleep(2500);
        }
      }
      throw lastErr;
    }

    let code;
    try {
      code = await requestCodeWithRetry();
    } catch (err) {
      cleanup(token, "pairing-code request failed: " + err.message);
      return res.status(500).json({ error: "Could not request pairing code: " + err.message });
    }

    // Format XXXX-XXXX
    const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

    watchConnection(token, rec, sock, dir);

    return res.json({ token, code: pretty });
  } catch (err) {
    console.error("pair error:", err.message);
    return res.status(500).json({ error: "Internal error: " + err.message });
  }
});

// QR mode: number ki zaroorat nahi — socket bante hi WhatsApp QR bhejta
// hai, watchConnection usay image bana kar record mein rakh deta hai aur
// page /api/status polling se utha kar dikha deta hai.
app.post("/api/qr", async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (rateLimited(ip)) {
      return res.status(429).json({ error: "Too many requests. Try again in an hour." });
    }

    const token = crypto.randomBytes(4).toString("hex");
    const dir = path.join(SESSIONS_ROOT, token);
    fs.mkdirSync(dir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["MALIK-MD Session", "Chrome", "1.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    sock.ev.on("creds.update", saveCreds);

    const rec = { sock, phone: null, createdAt: Date.now(), done: false, status: "waiting", sessionId: null, qrImage: null };
    rec.timeout = setTimeout(() => {
      rec.status = "expired";
      cleanup(token, "timeout (4 min)");
    }, 4 * 60 * 1000);
    pending.set(token, rec);

    watchConnection(token, rec, sock, dir);
    return res.json({ token });
  } catch (err) {
    console.error("qr error:", err.message);
    return res.status(500).json({ error: "Internal error: " + err.message });
  }
});

app.get("/api/status/:token", (req, res) => {
  const rec = pending.get(req.params.token);
  if (!rec) return res.json({ status: "expired" });
  return res.json({ status: rec.status, sessionId: rec.sessionId || undefined, qrImage: rec.qrImage || undefined });
});

app.listen(PORT, () => {
  console.log(`MALIK-MD session generator listening on port ${PORT}`);
});
