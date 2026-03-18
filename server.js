const express = require("express");
const webPush = require("web-push");
const bodyParser = require("body-parser");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Filter = require("bad-words");
const bcrypt = require("bcrypt");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");

const app = express();
app.set("trust proxy", 1); // Trust Render's Load Balancer
const server = http.createServer(app);

// --- RATE LIMITING ---
// Relaxed slightly to prevent locking you out during testing
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 1000, // Increased limit for development
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
app.use(limiter);

// --- CONFIGURATION ---
const JWT_SECRET =
  process.env.JWT_SECRET || "fallback_secret_please_change_in_env";

// --- CLOUDINARY CONFIG ---
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
} else {
  console.warn("WARNING: Cloudinary credentials missing in .env");
}

// --- MULTER SETUP (Memory Storage for uploads) ---
const upload = multer({ storage: multer.memoryStorage() });

// --- SOCKET.IO SETUP ---
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const onlineUsers = new Map(); // Maps PhoneNumber -> SocketID
// --- GLOBAL CHAT VARIABLES ---
let globalMessages = [];

// --- RESET LOGIC (Midnight EST) ---
function checkReset() {
  const now = new Date();
  // Convert current time to EST to check hours
  const estTime = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );

  // Check if it is 00:00 (Midnight)
  if (estTime.getHours() === 0 && estTime.getMinutes() === 0) {
    if (globalMessages.length > 0) {
      console.log("Cleaning Global Chat for Midnight EST");
      globalMessages = []; // Wipe data
      io.emit("global_reset"); // Tell all clients to clear screens
    }
  }
}
// Check every 55 seconds to ensure we catch the minute change
setInterval(checkReset, 55000);

// --- SOCKET AUTHENTICATION MIDDLEWARE ---
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error"));

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error("Authentication error"));
    socket.user = decoded; // Attach user info safely
    next();
  });
});

io.on("connection", (socket) => {
  const phoneNumber = socket.user.phoneNumber;
  onlineUsers.set(phoneNumber, socket.id);
  console.log(`User ${phoneNumber} connected (Auth Verified).`);
  io.emit("update_online_users", Array.from(onlineUsers.keys()));
  socket.on("typing", (data) => {
    const { receiver } = data;
    const receiverSocket = onlineUsers.get(receiver);
    if (receiverSocket) {
      io.to(receiverSocket).emit("display_typing", {
        senderNumber: phoneNumber,
      });
    }
  });

  socket.on("disconnect", () => {
    for (const [number, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(number);
        break;
      }
    }
    io.emit("update_online_users", Array.from(onlineUsers.keys()));
  });
});

// --- EXPRESS MIDDLEWARE ---
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(bodyParser.json({ limit: "10mb" }));

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("CRITICAL ERROR: Supabase Credentials missing.");
}

// --- SUPABASE & PUSH SETUP ---
const publicVapidKey = process.env.PUBLIC_VAPID_KEY;
const privateVapidKey = process.env.PRIVATE_VAPID_KEY;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

if (publicVapidKey && privateVapidKey) {
  webPush.setVapidDetails(
    "mailto:admin@txtapp.com",
    publicVapidKey,
    privateVapidKey,
  );
}

const filter = new Filter();

function safeClean(text) {
  if (!text || typeof text !== "string") return "";
  try {
    return filter.clean(text);
  } catch (e) {
    return text;
  }
}

function generatePhoneNumber() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// --- SECURITY MIDDLEWARE ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

async function ensureContactExists(owner, contact, defaultName) {
  try {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .match({ owner_number: owner, contact_number: contact })
      .single();

    if (!data) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("username")
        .eq("phone_number", contact)
        .single();
      const nameToUse = profile ? profile.username : defaultName;
      await supabase.from("contacts").insert({
        owner_number: owner,
        contact_number: contact,
        nickname: nameToUse,
      });
    }
  } catch (err) {
    // Ignore duplicate insert errors
    console.error("Auto-add contact log:", err.message);
  }
}

// 1. HEALTH CHECK
app.get("/", (req, res) => res.json({ status: "online" }));

// 2. REGISTER
app.post("/register", async (req, res) => {
  try {
    const { subscription, username, password } = req.body;

    if (!password || password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    let phoneNumber = generatePhoneNumber();
    let unique = false;
    let attempts = 0;

    while (!unique && attempts < 5) {
      const { data } = await supabase
        .from("profiles")
        .select("phone_number")
        .eq("phone_number", phoneNumber);
      if (!data || data.length === 0) unique = true;
      else phoneNumber = generatePhoneNumber();
      attempts++;
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const cleanName = safeClean(username || "User");

    const { data, error } = await supabase
      .from("profiles")
      .insert({
        username: cleanName,
        phone_number: phoneNumber,
        push_sub: subscription,
        password_hash: hashedPassword,
      })
      .select()
      .single();

    if (error) throw error;

    const token = jwt.sign({ phoneNumber: data.phone_number }, JWT_SECRET);

    res.json({
      phoneNumber: data.phone_number,
      username: data.username,
      token: token,
    });
  } catch (error) {
    res.status(10000).json({ error: error.message });
  }
});

// 3. LOGIN
app.post("/login", async (req, res) => {
  try {
    const identifier = req.body.loginInput || req.body.identifier;
    const { password, subscription } = req.body;

    if (!identifier) {
      return res
        .status(400)
        .json({ error: "Missing username or phone number" });
    }

    let query = supabase.from("profiles").select("*");
    if (/^\d{6}$/.test(identifier)) {
      query = query.eq("phone_number", identifier);
    } else {
      query = query.eq("username", identifier);
    }

    const { data: user } = await query.single();

    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.password_hash)
      return res
        .status(403)
        .json({ error: "Account too old. No password set." });

    const validPass = await bcrypt.compare(password, user.password_hash);
    if (!validPass)
      return res.status(401).json({ error: "Incorrect password" });

    if (subscription) {
      await supabase
        .from("profiles")
        .update({ push_sub: subscription })
        .eq("phone_number", user.phone_number);
    }

    const token = jwt.sign({ phoneNumber: user.phone_number }, JWT_SECRET);

    res.json({
      phoneNumber: user.phone_number,
      username: user.username,
      token: token,
    });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ error: "Login failed." });
  }
});

// --- NEW ROUTE: UPLOAD IMAGE ---
app.post(
  "/upload-image",
  authenticateToken,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      // Upload to Cloudinary using a stream
      const b64 = Buffer.from(req.file.buffer).toString("base64");
      let dataURI = "data:" + req.file.mimetype + ";base64," + b64;

      const result = await cloudinary.uploader.upload(dataURI, {
        folder: "chat_app_uploads",
        resource_type: "auto",
      });

      // Return the secure URL to the client
      res.json({ url: result.secure_url });
    } catch (error) {
      console.error("Upload Error:", error);
      res.status(500).json({ error: "Image upload failed" });
    }
  },
);

// 4. SEND MESSAGE (Protected & Updated for Images)
app.post("/send-message", authenticateToken, async (req, res) => {
  try {
    // Accepts 'type' now. Default to 'text'.
    let { senderNumber, receiverNumber, body, type } = req.body;

    if (!body || body.length > 2000) {
      return res
        .status(400)
        .json({ error: "Message too long (max 2000 chars)" });
    }

    // Validate identity
    if (req.user.phoneNumber !== senderNumber) {
      return res.status(403).json({ error: "Identity spoofing detected." });
    }

    // Check if blocked
    const { data: blockData } = await supabase
      .from("blocks")
      .select("*")
      .eq("blocker_number", receiverNumber)
      .eq("blocked_number", senderNumber)
      .single();

    if (blockData) return res.json({ success: true, status: "blocked" });

    // Auto-create contacts if they don't exist
    await ensureContactExists(senderNumber, receiverNumber, "New Contact");
    await ensureContactExists(receiverNumber, senderNumber, "New Chat");

    // Clean the text ONLY if it is text. If it's an image, body is a URL.
    const msgType = type === "image" ? "image" : "text";
    const cleanBody = msgType === "text" ? safeClean(body) : body;

    const { data: savedMsg, error: dbError } = await supabase
      .from("messages")
      .insert({
        sender_number: senderNumber,
        receiver_number: receiverNumber,
        body: cleanBody,
        type: msgType, // Saves 'text' or 'image'
      })
      .select()
      .single();

    if (dbError) {
      console.error("SUPABASE INSERT ERROR:", dbError);
      throw new Error(dbError.message);
    }

    // Notify Receiver
    const receiverSocketId = onlineUsers.get(receiverNumber);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("receive_message", savedMsg);
      io.to(receiverSocketId).emit("refresh_contacts");
    }

    // Notify Sender
    const senderSocketId = onlineUsers.get(senderNumber);
    if (senderSocketId) {
      io.to(senderSocketId).emit("receive_message", savedMsg);
      io.to(senderSocketId).emit("refresh_contacts");
    }

    // Push Notifications Logic
    const { data: receiver } = await supabase
      .from("profiles")
      .select("push_sub")
      .eq("phone_number", receiverNumber)
      .single();

    if (receiver && receiver.push_sub) {
      try {
        const pushBody = msgType === "image" ? "📷 Sent an image" : cleanBody;
        await webPush.sendNotification(
          receiver.push_sub,
          JSON.stringify({
            title: `New Message`,
            body: pushBody,
            sender: senderNumber,
          }),
        );
      } catch (e) {
        console.error("Push Error:", e.message);

        // --- NEW FIX START ---
        // If the subscription is dead (410) or not found (404), remove it from DB
        if (e.statusCode === 410 || e.statusCode === 404) {
          console.log(`Removing dead subscription for user: ${receiverNumber}`);
          await supabase
            .from("profiles")
            .update({ push_sub: null })
            .eq("phone_number", receiverNumber);
        }
        // --- NEW FIX END ---
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Server Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET MESSAGES
app.get("/messages/:myNumber", authenticateToken, async (req, res) => {
  try {
    if (req.user.phoneNumber !== req.params.myNumber) {
      return res.status(403).json({ error: "Access Denied" });
    }

    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .or(
        `sender_number.eq.${req.params.myNumber},receiver_number.eq.${req.params.myNumber}`,
      )
      .order("timestamp", { ascending: false }) // Get NEWEST messages first
      .limit(500); // Grab the recent 500
    if (error) throw error;
    res.json(data.reverse());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. CONTACTS ADD

app.post("/contacts/add", authenticateToken, async (req, res) => {
  try {
    const { ownerNumber, contactNumber, nickname } = req.body;

    if (req.user.phoneNumber !== ownerNumber) return res.sendStatus(403);

    const { data: contactUser } = await supabase
      .from("profiles")
      .select("username")
      .eq("phone_number", contactNumber)
      .single();
    if (!contactUser)
      return res.status(404).json({ error: "User ID not found" });

    const { data: ownerUser } = await supabase
      .from("profiles")
      .select("username")
      .eq("phone_number", ownerNumber)
      .single();

    await supabase.from("contacts").upsert(
      {
        owner_number: ownerNumber,
        contact_number: contactNumber,
        custom_name: safeClean(nickname),
      },
      { onConflict: "owner_number, contact_number" },
    );

    await supabase.from("contacts").upsert(
      {
        owner_number: contactNumber,
        contact_number: ownerNumber,
        custom_name: ownerUser ? ownerUser.username : "New Contact",
      },
      { onConflict: "owner_number, contact_number" },
    );

    const contactSocketId = onlineUsers.get(contactNumber);
    if (contactSocketId) {
      io.to(contactSocketId).emit("refresh_contacts");
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET CONTACTS
app.get("/contacts/:myNumber", authenticateToken, async (req, res) => {
  try {
    if (req.user.phoneNumber !== req.params.myNumber)
      return res.sendStatus(403);

    const { data, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("owner_number", req.params.myNumber);
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post("/contacts/update", authenticateToken, async (req, res) => {
  try {
    const { id, nickname, is_favorite } = req.body;

    if (!id) return res.status(400).json({ error: "Missing contact ID" });

    const updates = {};
    if (nickname !== undefined) updates.nickname = nickname;
    if (is_favorite !== undefined) updates.is_favorite = is_favorite;

    // 🚨 Target the exact database ID!
    const { data, error } = await supabase
      .from("contacts")
      .update(updates)
      .eq("id", id)
      .select();

    if (error) throw error;
    if (!data || data.length === 0)
      return res.status(404).send("Contact ID not found.");

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post("/contacts/delete", authenticateToken, async (req, res) => {
  try {
    const { id, contactNumber } = req.body;
    if (!id) return res.status(400).json({ error: "Missing contact ID" });

    // 1. Delete the contact directly by its ID
    const { data: contactData, error: contactError } = await supabase
      .from("contacts")
      .delete()
      .eq("id", id)
      .select();

    if (contactError) throw contactError;

    // 2. Delete the message history (only if we have the numbers)
    let myNumber =
      req.user.phoneNumber || req.user.number || req.user.phone_number;
    if (!myNumber && req.user.id) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("phone_number")
        .eq("id", req.user.id)
        .single();
      if (profile) myNumber = profile.phone_number;
    }

    if (myNumber && contactNumber) {
      const safeOwner = String(myNumber).replace(/\D/g, "");
      const safeContact = String(contactNumber).replace(/\D/g, "");

      await supabase
        .from("messages")
        .delete()
        .or(
          `and(sender_number.eq.${safeOwner},receiver_number.eq.${safeContact}),and(sender_number.eq.${safeContact},receiver_number.eq.${safeOwner})`,
        );
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post("/contacts/block", authenticateToken, async (req, res) => {
  try {
    if (req.user.phoneNumber !== req.body.ownerNumber)
      return res.sendStatus(403);

    await supabase.from("blocks").upsert(
      {
        blocker_number: req.body.ownerNumber,
        blocked_number: req.body.blockedNumber,
      },
      { onConflict: "blocker_number, blocked_number" },
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/contacts/unblock", authenticateToken, async (req, res) => {
  try {
    if (req.user.phoneNumber !== req.body.ownerNumber)
      return res.sendStatus(403);

    const { error } = await supabase.from("blocks").delete().match({
      blocker_number: req.body.ownerNumber,
      blocked_number: req.body.blockedNumber,
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/blocks/:myNumber", authenticateToken, async (req, res) => {
  try {
    if (req.user.phoneNumber !== req.params.myNumber)
      return res.sendStatus(403);

    const { data, error } = await supabase
      .from("blocks")
      .select("blocked_number")
      .eq("blocker_number", req.params.myNumber);

    if (error) throw error;
    res.json(data.map((b) => b.blocked_number));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// --- GLOBAL CHAT ROUTES ---

// 1. Get Global History
app.get("/global/messages", (req, res) => {
  res.json(globalMessages);
});

// 2. Send Global Message (Protected)
app.post("/global/send", authenticateToken, (req, res) => {
  try {
    const { senderNumber, username, body, type } = req.body;

    // Basic validation
    if (!body || body.length > 2000) {
      return res.status(400).json({ error: "Message too long" });
    }

    const msg = {
      id: Date.now(),
      sender_number: senderNumber,
      sender_name: username || "Unknown",
      // Use your existing safeClean function for text
      body: type === "text" ? safeClean(body) : body,
      type: type || "text",
      timestamp: new Date().toISOString(),
    };

    globalMessages.push(msg);

    // Keep memory usage low (only store last 500 messages)
    if (globalMessages.length > 500) globalMessages.shift();

    // Broadcast to ALL connected users
    io.emit("receive_global", msg);

    res.json({ success: true });
  } catch (e) {
    console.error("Global Chat Error:", e);
    res.status(500).json({ error: "Failed to send global message" });
  }
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
