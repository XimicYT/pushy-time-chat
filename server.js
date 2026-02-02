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

// --- SOCKET.IO SETUP ---
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const onlineUsers = new Map(); // Maps PhoneNumber -> SocketID

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
    res.status(500).json({ error: error.message });
  }
});

// 3. LOGIN (FIXED: Accepts loginInput OR identifier)
app.post("/login", async (req, res) => {
  try {
    // SECURITY FIX: Check for both variable names to handle Client/Server mismatch
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

// 4. SEND MESSAGE (Protected)
app.post("/send-message", authenticateToken, async (req, res) => {
  try {
    let { senderNumber, receiverNumber, body } = req.body;

    if (!body || body.length > 2000) {
      return res
        .status(400)
        .json({ error: "Message too long (max 2000 chars)" });
    }
    if (req.user.phoneNumber !== senderNumber) {
      return res.status(403).json({ error: "Identity spoofing detected." });
    }

    const { data: blockData } = await supabase
      .from("blocks")
      .select("*")
      .eq("blocker_number", receiverNumber)
      .eq("blocked_number", senderNumber)
      .single();

    if (blockData) return res.json({ success: true, status: "blocked" });

    await ensureContactExists(senderNumber, receiverNumber, "New Contact");
    await ensureContactExists(receiverNumber, senderNumber, "New Chat");

    const cleanBody = safeClean(body);

    const { data: savedMsg } = await supabase
      .from("messages")
      .insert({
        sender_number: senderNumber,
        receiver_number: receiverNumber,
        body: cleanBody,
      })
      .select()
      .single();

    const receiverSocketId = onlineUsers.get(receiverNumber);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("receive_message", savedMsg);
      io.to(receiverSocketId).emit("refresh_contacts");
    }
    // 2. Notify Sender (FIX: This updates your own screen immediately)
    const senderSocketId = onlineUsers.get(senderNumber);
    if (senderSocketId) {
      io.to(senderSocketId).emit("receive_message", savedMsg);
      io.to(senderSocketId).emit("refresh_contacts");
    }

    const { data: receiver } = await supabase
      .from("profiles")
      .select("push_sub")
      .eq("phone_number", receiverNumber)
      .single();

    if (receiver && receiver.push_sub) {
      try {
        await webPush.sendNotification(
          receiver.push_sub,
          JSON.stringify({
            title: `New Message`,
            body: cleanBody,
            sender: senderNumber,
          }),
        );
      } catch (e) {
        console.error("Push Error:", e);
      }
    }
    res.json({ success: true });
  } catch (error) {
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
      .order("timestamp", { ascending: true })
      .limit(500);
    if (error) throw error;
    res.json(data);
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
        nickname: safeClean(nickname),
      },
      { onConflict: "owner_number, contact_number" },
    );

    await supabase.from("contacts").upsert(
      {
        owner_number: contactNumber,
        contact_number: ownerNumber,
        nickname: ownerUser ? ownerUser.username : "New Contact",
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

// 6. UPDATE CONTACT
app.post("/contacts/update", authenticateToken, async (req, res) => {
  try {
    const { id, nickname, is_favorite } = req.body;
    const { data: existing } = await supabase
      .from("contacts")
      .select("owner_number")
      .eq("id", id)
      .single();
    if (!existing || existing.owner_number !== req.user.phoneNumber) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const updates = {};
    if (nickname !== undefined) updates.nickname = safeClean(nickname);
    if (is_favorite !== undefined) updates.is_favorite = is_favorite;

    const { error } = await supabase
      .from("contacts")
      .update(updates)
      .eq("id", id);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/contacts/delete", authenticateToken, async (req, res) => {
  try {
    const { data: existing } = await supabase
      .from("contacts")
      .select("owner_number")
      .eq("id", req.body.id)
      .single();
    if (!existing || existing.owner_number !== req.user.phoneNumber) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    await supabase.from("contacts").delete().eq("id", req.body.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
