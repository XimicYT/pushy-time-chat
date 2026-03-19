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
// --- SOCKET AUTHENTICATION MIDDLEWARE ---
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error"));

  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err) return next(new Error("Authentication error"));

    // NEW: Check if this user is banned from the app upon connection!
    const activeBans = await getActiveBans(decoded.phoneNumber);
    if (activeBans.includes("login")) {
      return next(new Error("BANNED")); // Reject the connection entirely
    }

    socket.user = decoded; // Attach user info safely
    next();
  });
});

// --- NEW: Helper function to calculate and broadcast detailed statuses ---
function broadcastStatuses() {
  const aggregated = {};

  // Loop through all connected sockets
  io.sockets.sockets.forEach((s) => {
    if (s.user && s.user.phoneNumber) {
      const num = s.user.phoneNumber;
      // If a user has multiple tabs open, 'active' overrides 'away'
      if (!aggregated[num] || s.userStatus === "active") {
        aggregated[num] = s.userStatus || "active"; // Default to active
      }
    }
  });

  // Send the dictionary of statuses to everyone
  io.emit("online_statuses", aggregated);
}

io.on("connection", (socket) => {
  const phoneNumber = socket.user.phoneNumber;
  onlineUsers.set(phoneNumber, socket.id);

  // Default status on connection
  socket.userStatus = "active";

  console.log(`User ${phoneNumber} connected (Auth Verified).`);

  // Legacy emit (kept just in case your other code needs it)
  io.emit("update_online_users", Array.from(onlineUsers.keys()));

  // New detailed status emit
  broadcastStatuses();

  // Listen for active/away tab changes from the client
  socket.on("update_status", (status) => {
    socket.userStatus = status;
    broadcastStatuses();
  });

  socket.on("typing", (data) => {
    const { receiver } = data;
    const receiverSocket = onlineUsers.get(receiver);
    if (receiverSocket) {
      io.to(receiverSocket).emit("display_typing", {
        senderNumber: phoneNumber,
      });
    }
  });

  socket.on("disconnect", async () => {
    for (const [number, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(number);

        // NEW: Update last_online in the database when they disconnect
        try {
          await supabase
            .from("profiles")
            .update({ last_online: new Date().toISOString() })
            .eq("phone_number", number);
        } catch (err) {
          console.error("Failed to update last_online on disconnect:", err);
        }

        break;
      }
    }
    io.emit("update_online_users", Array.from(onlineUsers.keys()));

    // Broadcast statuses again so everyone knows this user left
    broadcastStatuses();
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
// --- ADMIN ROUTES ---
// Get all users for admin dashboard

// Define who is allowed to access the admin page (Replace with your actual admin phone numbers/IDs)
const ADMIN_NUMBERS = ["321777"];

// --- ADMIN ROUTES ---
// --- ADMIN: BAN USER ROUTE ---
app.post(
  "/admin/api/ban",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { targetNumber, types, reason, days } = req.body;

      // --- NEW: Block bans against admins ---
      if (ADMIN_NUMBERS.includes(targetNumber)) {
        return res
          .status(403)
          .json({ error: "Action Denied: Admins cannot be banned." });
      }

      // 1. DELETE any existing bans for this user.
      // This prevents duplicate bans and allows us to seamlessly "overwrite"
      // their ban to extend, shorten, or change the ban types.
      await supabase.from("bans").delete().eq("phone_number", targetNumber);

      // 2. CHECK FOR UNBAN
      // If you send an empty array of types, or set days to 0, it acts as a full unban!
      if (!types || types.length === 0 || days === 0) {
        return res.json({
          success: true,
          message: "User unbanned successfully.",
        });
      }

      // 3. CALCULATE EXPIRATION
      let expiresAt = null;
      if (days !== -1) {
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + days);
        expiresAt = expiresAt.toISOString();
      }

      // 4. INSERT THE NEW BAN
      const { error: insertErr } = await supabase.from("bans").insert({
        phone_number: targetNumber,
        ban_types: types,
        reason: reason,
        expires_at: expiresAt,
      });

      if (insertErr) {
        return res
          .status(500)
          .json({ error: "Insert Ban Error: " + insertErr.message });
      }

      // 5. REAL-TIME ENFORCEMENT
      // Find if the user is currently online and connected to the socket
      const targetSocketId = onlineUsers.get(targetNumber);
      if (targetSocketId) {
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
          // Send a direct event to that specific user's device
          targetSocket.emit("user_banned_event", { types, reason });

          // If it's a login/app ban, forcefully sever their server connection right now
          if (types.includes("login")) {
            targetSocket.disconnect(true);
          }
        }
      }

      res.json({ success: true, message: "Ban updated successfully." });
    } catch (error) {
      console.error("Ban Error:", error);
      res.status(500).json({ error: "Server Catch: " + error.message });
    }
  },
);
// 1. Verify Admin Status
app.get("/admin/verify", authenticateToken, async (req, res) => {
  try {
    // Assuming your token payload includes the user's phone number or ID
    const userIdentifier = req.user.phoneNumber; // or req.user.id, depending on your setup

    const { data, error } = await supabase
      .from("profiles")
      .select("is_admin")
      // Change 'phone_number' to 'id' if you use UUIDs to look up users
      .eq("phone_number", userIdentifier)
      .single();

    if (error || !data || data.is_admin !== true) {
      return res.status(403).json({ error: "Server rejected admin access." });
    }

    // If they made it here, they are a verified admin
    res.status(200).json({ success: true, message: "Admin verified" });
  } catch (err) {
    console.error("Admin Verify Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 2. Get all users for admin dashboard
app.get("/admin/users", authenticateToken, async (req, res) => {
  try {
    // Securely verify admin identity from DB again before returning sensitive data
    const { data: adminData, error: adminError } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("phone_number", req.user.phoneNumber)
      .single();

    if (adminError || !adminData || !adminData.is_admin) {
      return res.status(403).json({ error: "Unauthorized: Not an admin" });
    }

    // Fetch profiles from Supabase (excluding password hashes)
    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, phone_number, created_at, is_admin") // Also grabbing is_admin here just in case!
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Admin Fetch Users Error:", err.message);
    res.status(500).json({ error: "Failed to fetch user list." });
  }
});
// GET Detailed User Profile for Admin
app.get("/admin/api/user/:id", authenticateToken, async (req, res) => {
  const userId = req.params.id;

  try {
    // 1. Verify admin status first
    const adminPhone =
      req.user.phoneNumber || req.user.number || req.user.phone_number;
    const { data: adminData } = await supabase
      .from("profiles") // (or 'users' depending on your table)
      .select("is_admin")
      .eq("phone_number", adminPhone)
      .single();

    if (!adminData || !adminData.is_admin) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    // 2. Get base user info
    const { data: user } = await supabase
      .from("profiles") // (or 'users')
      .select("*")
      .eq("id", userId)
      .single();

    if (!user)
      return res.status(404).json({ success: false, error: "User not found" });

    const userPhone = user.phone_number;

    // 3. Get Contacts (UPDATED TO USE owner_number)
    // 3. Get Contacts (UPDATED TO USE owner_number)
    const { data: contacts } = await supabase
      .from("contacts")
      .select("nickname, contact_number, is_favorite") // FIXED: Changed contact_name to nickname
      .eq("owner_number", userPhone);

    // 4. Get Message Stats
    const now = new Date();
    const todayStr = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).toISOString();
    const weekStr = new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const monthStr = new Date(
      now.getTime() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Query the messages table using sender_number
    const [todayRes, weekRes, monthRes] = await Promise.all([
      supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("sender_number", userPhone)
        .gte("timestamp", todayStr), // FIXED: created_at -> timestamp
      supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("sender_number", userPhone)
        .gte("timestamp", weekStr), // FIXED: created_at -> timestamp
      supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("sender_number", userPhone)
        .gte("timestamp", monthStr), // FIXED: created_at -> timestamp
    ]);

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        phone_number: user.phone_number,
        created_at: user.created_at,
        last_online: user.last_online || null, // FIXED: Now using last_online!
      },
      contacts: contacts || [],
      stats: {
        today: todayRes.count || 0,
        week: weekRes.count || 0,
        month: monthRes.count || 0,
      },
    });
  } catch (error) {
    console.error("Profile Fetch Error:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});
// 3. Get Dashboard Analytics
app.get("/admin/stats", authenticateToken, async (req, res) => {
  try {
    // 1. Verify admin status
    const { data: adminData, error: adminError } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("phone_number", req.user.phoneNumber)
      .single();

    if (adminError || !adminData || !adminData.is_admin) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // 2. Get Total Users (Fast count method)
    const { count: totalUsers, error: countError } = await supabase
      .from("profiles")
      .select("*", { count: "exact", head: true });

    if (countError) throw countError;

    // 3. Get Live Data from Server Memory
    const onlineCount = onlineUsers.size;
    const globalChatCount = globalMessages.length;

    // 4. Send it back
    res.json({
      totalUsers: totalUsers || 0,
      onlineCount: onlineCount,
      globalChatCount: globalChatCount,
    });
  } catch (err) {
    console.error("Admin Fetch Stats Error:", err.message);
    res.status(500).json({ error: "Failed to fetch stats." });
  }
});
// 4. Get List of Online Users
// 4. Get List of Online Users
// 4. Get List of Online Users
app.get("/admin/online", authenticateToken, async (req, res) => {
  try {
    // Verify admin
    const { data: adminData, error: adminError } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("phone_number", req.user.phoneNumber)
      .single();

    if (adminError || !adminData || !adminData.is_admin) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Aggregate exact statuses directly from connected sockets
    const aggregated = {};
    io.sockets.sockets.forEach((s) => {
      if (s.user && s.user.phoneNumber) {
        const num = s.user.phoneNumber;
        // 'active' overrides 'away' if they have multiple tabs open
        if (!aggregated[num] || s.userStatus === "active") {
          aggregated[num] = s.userStatus || "active";
        }
      }
    });

    const onlineNumbers = Object.keys(aggregated);

    if (onlineNumbers.length === 0) {
      return res.json([]); // No one online
    }

    // Fetch the usernames for those phone numbers
    const { data, error } = await supabase
      .from("profiles")
      .select("username, phone_number")
      .in("phone_number", onlineNumbers);

    if (error) throw error;

    // Combine database profiles with their live memory status
    const enhancedData = data.map((user) => ({
      ...user,
      status: aggregated[user.phone_number] || "active",
    }));

    res.json(enhancedData);
  } catch (err) {
    console.error("Admin Fetch Online Error:", err.message);
    res.status(500).json({ error: "Failed to fetch online users." });
  }
});
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
// Add this middleware function near your other config/middleware
async function requireAdmin(req, res, next) {
  try {
    const userIdentifier = req.user.phoneNumber; // Again, adjust to your token structure

    const { data, error } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("phone_number", userIdentifier)
      .single();

    if (error || !data || data.is_admin !== true) {
      return res
        .status(403)
        .json({ error: "Unauthorized: Admin privileges required." });
    }

    next(); // They are an admin, proceed to the actual route!
  } catch (err) {
    res.status(500).json({ error: "Server error during admin validation" });
  }
}

// Then, protect your ban route like this:

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
// --- BAN SYSTEM HELPER ---
// --- BAN SYSTEM HELPER ---
// --- BAN SYSTEM HELPER ---
async function getActiveBans(phoneNumber) {
  if (!phoneNumber) return [];

  try {
    const { data: bans, error } = await supabase
      .from("bans")
      .select("ban_types, expires_at")
      .eq("phone_number", phoneNumber);

    if (error || !bans) return [];

    const now = new Date();
    let activeTypes = new Set();

    bans.forEach((ban) => {
      // Check if ban is permanent OR hasn't expired yet
      if (!ban.expires_at || new Date(ban.expires_at) > now) {
        if (ban.ban_types) {
          // Bulletproof extraction: Whether it's an Array or a Postgres String "{login, global}"
          const typeString = JSON.stringify(ban.ban_types).toLowerCase();

          if (typeString.includes("login")) activeTypes.add("login");
          if (typeString.includes("global")) activeTypes.add("global");
          if (typeString.includes("private")) activeTypes.add("private");
        }
      }
    });

    return Array.from(activeTypes);
  } catch (err) {
    console.error("Fatal error in getActiveBans:", err);
    // If something horribly breaks, assume they are NOT allowed as a safety measure
    return ["login", "global", "private"];
  }
}
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
        last_online: new Date().toISOString(), // SETS INITIAL ONLINE TIME
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
    const activeBans = await getActiveBans(user.phone_number);
    if (activeBans.includes("login")) {
      return res
        .status(403)
        .json({ error: "Your account is banned from accessing the app." });
    }
    const token = jwt.sign({ phoneNumber: user.phone_number }, JWT_SECRET);
    try {
      await supabase
        .from("profiles") // (or 'users' if your table is called users)
        .update({ last_login: new Date().toISOString() })
        .eq("phone_number", user.phone_number);
    } catch (updateErr) {
      console.error("Failed to update last login:", updateErr);
    }
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
    const { senderNumber, receiverNumber, body, type } = req.body;

    // 2. THEN check for bans using optional chaining (?.)
    const activeBans = await getActiveBans(senderNumber);
    if (activeBans?.includes("private") || activeBans?.includes("login")) {
      return res
        .status(403)
        .json({ error: "You are banned from private messaging." });
    }

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
// --- NEW: CHECK BANS ON PAGE LOAD ---
// --- NEW: CHECK BANS ON PAGE LOAD ---
app.get("/check-bans", authenticateToken, async (req, res) => {
  try {
    const secureNumber = req.user.phoneNumber || req.user.number;

    // Fetch the raw row so we can get both the types AND the reason
    const { data: banData } = await supabase
      .from("bans")
      .select("ban_types, reason, expires_at")
      .eq("phone_number", secureNumber)
      .single();

    let activeBans = [];
    let reason = "Violation of the rules.";

    if (banData) {
      const now = new Date();
      // Check if ban is permanent OR hasn't expired yet
      if (!banData.expires_at || new Date(banData.expires_at) > now) {
        reason = banData.reason || reason; // Overwrite with actual reason from DB

        if (banData.ban_types) {
          const typeString = JSON.stringify(banData.ban_types).toLowerCase();
          if (typeString.includes("login")) activeBans.push("login");
          if (typeString.includes("global")) activeBans.push("global");
          if (typeString.includes("private")) activeBans.push("private");
        }
      }
    }

    // Send BOTH back to the frontend
    res.json({ bans: activeBans, reason: reason });
  } catch (e) {
    console.error("Failed to check bans:", e);
    res.status(500).json({ error: "Failed to check bans" });
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
      .limit(150); // <-- CHANGED: Only load enough for contact list previews
    if (error) throw error;
    res.json(data.reverse());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// --- ADMIN: BAN USER ROUTE ---

// NEW ROUTE: Get Paginated Messages for a SPECIFIC Chat
app.get(
  "/messages/chat/:myNumber/:contactNumber",
  authenticateToken,
  async (req, res) => {
    try {
      if (req.user.phoneNumber !== req.params.myNumber) {
        return res.status(403).json({ error: "Access Denied" });
      }

      const { contactNumber } = req.params;
      const offset = parseInt(req.query.offset) || 0;
      const limit = parseInt(req.query.limit) || 500;

      // Clean formatting just in case
      const safeMyNum = String(req.params.myNumber).replace(/\D/g, "");
      const safeContactNum = String(contactNumber).replace(/\D/g, "");

      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .or(
          `and(sender_number.eq.${safeMyNum},receiver_number.eq.${safeContactNum}),and(sender_number.eq.${safeContactNum},receiver_number.eq.${safeMyNum})`,
        )
        .order("timestamp", { ascending: false })
        .range(offset, offset + limit - 1); // Supabase pagination!

      if (error) throw error;

      // Reverse so oldest is at the top, newest at bottom
      res.json(data.reverse());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);
// 5. CONTACTS ADD
// 5. CONTACTS ADD
app.post("/contacts/add", authenticateToken, async (req, res) => {
  try {
    const { ownerNumber, contactNumber, nickname } = req.body;

    if (!ownerNumber || !contactNumber) {
      return res.status(400).json({ error: "Missing required numbers." });
    }

    // 1. Verify that the person they are trying to add actually has an account
    const { data: profile } = await supabase
      .from("profiles")
      .select("username")
      .eq("phone_number", contactNumber)
      .single();

    if (!profile) {
      return res
        .status(404)
        .json({ error: "No user found with that phone number." });
    }

    // 2. Prevent adding duplicates
    const { data: existingContact } = await supabase
      .from("contacts")
      .select("id")
      .eq("owner_number", ownerNumber)
      .eq("contact_number", contactNumber)
      .single();

    if (existingContact) {
      return res
        .status(400)
        .json({ error: "This person is already in your contacts." });
    }

    // 3. Add the contact!
    const { data, error } = await supabase
      .from("contacts")
      .insert({
        owner_number: ownerNumber,
        contact_number: contactNumber,
        nickname: nickname || profile.username || "New Contact",
        is_favorite: false,
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, contact: data });
  } catch (error) {
    console.error("Add Contact Error:", error);
    res.status(500).json({ error: "Failed to add contact: " + error.message });
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
app.post("/global/send", authenticateToken, async (req, res) => {
  try {
    // 1. Extract variables FIRST
    const { senderNumber, username, body, type } = req.body;

    // 2. THEN check for bans using optional chaining (?.)
    const activeBans = await getActiveBans(senderNumber);
    if (activeBans?.includes("global") || activeBans?.includes("login")) {
      return res
        .status(403)
        .json({ error: "You are banned from global chat." });
    }
    // Basic validation
    if (!body || body.length > 2000) {
      return res.status(400).json({ error: "Message too long" });
    }

    // In server.js inside app.post("/global/send", ...)

    const msg = {
      id: Date.now().toString(),
      sender_number: senderNumber, // Crucial for your client's isMe check
      senderNumber: senderNumber, // Added just in case your client checks camelCase
      sender_name: username || "Unknown",
      body: type === "text" ? safeClean(body) : body,
      type: type || "text",
      created_at: new Date().toISOString(), // FIXES the "undefined" time!
      timestamp: new Date().toISOString(), // Kept for backwards compatibility
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
