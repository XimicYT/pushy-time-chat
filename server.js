const express = require('express');
const webPush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Filter = require('bad-words');
const bcrypt = require('bcrypt');
const http = require('http'); // NEW
const { Server } = require('socket.io'); // NEW

const app = express();

// WRAP EXPRESS IN HTTP SERVER
const server = http.createServer(app);

// SETUP SOCKET.IO
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ["GET", "POST"]
    }
});

const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(bodyParser.json({ limit: '10mb' }));

// --- SOCKET TRACKING ---
const onlineUsers = new Map(); // Maps PhoneNumber -> SocketID

io.on('connection', (socket) => {
    // When a user opens the app, they send their phone number
    socket.on('join', (phoneNumber) => {
        onlineUsers.set(phoneNumber, socket.id);
        console.log(`User ${phoneNumber} connected on socket ${socket.id}`);
    });

    socket.on('disconnect', () => {
        // Optional: clean up map (complex to do perfectly without looping, strictly not required for MVP)
    });
});
// -----------------------

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("CRITICAL ERROR: Supabase Credentials missing.");
}

const publicVapidKey = process.env.PUBLIC_VAPID_KEY;
const privateVapidKey = process.env.PRIVATE_VAPID_KEY;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

if (publicVapidKey && privateVapidKey) {
    webPush.setVapidDetails('mailto:admin@txtapp.com', publicVapidKey, privateVapidKey);
}

const filter = new Filter();

function safeClean(text) {
    if (!text || typeof text !== 'string') return "";
    try { return filter.clean(text); } catch (e) { return text; }
}

function generatePhoneNumber() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

async function ensureContactExists(owner, contact, defaultName) {
    try {
        const { data } = await supabase.from('contacts')
            .select('id')
            .match({ owner_number: owner, contact_number: contact })
            .single();
        
        if (!data) {
            const { data: profile } = await supabase.from('profiles')
                .select('username')
                .eq('phone_number', contact)
                .single();
            const nameToUse = profile ? profile.username : defaultName;
            await supabase.from('contacts').insert({
                owner_number: owner,
                contact_number: contact,
                nickname: nameToUse
            });
        }
    } catch (err) { console.error("Auto-add error:", err.message); }
}

// 1. HEALTH CHECK
app.get('/', (req, res) => res.json({ status: 'online' }));

// 2. REGISTER
app.post('/register', async (req, res) => {
    try {
        const { subscription, username, password } = req.body;
        
        if (!password || password.length < 6) {
            return res.status(400).json({ error: "Password must be at least 6 characters" });
        }

        let phoneNumber = generatePhoneNumber();
        let unique = false;
        let attempts = 0;
        
        while (!unique && attempts < 5) {
            const { data } = await supabase.from('profiles').select('phone_number').eq('phone_number', phoneNumber);
            if (!data || data.length === 0) unique = true;
            else phoneNumber = generatePhoneNumber();
            attempts++;
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const cleanName = safeClean(username || "User");

        const { data, error } = await supabase.from('profiles').insert({
            username: cleanName,
            phone_number: phoneNumber,
            push_sub: subscription,
            password_hash: hashedPassword
        }).select().single();

        if (error) throw error;
        res.json({ phoneNumber: data.phone_number, username: data.username });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. LOGIN
app.post('/login', async (req, res) => {
    try {
        const { identifier, password, subscription } = req.body;

        let query = supabase.from('profiles').select('*');
        if (/^\d{6}$/.test(identifier)) {
            query = query.eq('phone_number', identifier);
        } else {
            query = query.eq('username', identifier);
        }

        const { data: user } = await query.single();

        if (!user) return res.status(404).json({ error: "User not found" });
        if (!user.password_hash) return res.status(403).json({ error: "Account too old. No password set." });

        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) return res.status(401).json({ error: "Incorrect password" });

        if (subscription) {
            await supabase.from('profiles').update({ push_sub: subscription }).eq('phone_number', user.phone_number);
        }

        res.json({ phoneNumber: user.phone_number, username: user.username });
    } catch (error) {
        res.status(500).json({ error: "Login failed or duplicate username." });
    }
});

// 4. SEND MESSAGE (Updated with Socket.io)
app.post('/send-message', async (req, res) => {
    try {
        let { senderNumber, receiverNumber, body } = req.body;
        
        // Block check
        const { data: blockData } = await supabase.from('blocks')
            .select('*')
            .eq('blocker_number', receiverNumber)
            .eq('blocked_number', senderNumber)
            .single();

        if (blockData) return res.json({ success: true, status: 'blocked' }); 

        await ensureContactExists(senderNumber, receiverNumber, "New Contact");
        await ensureContactExists(receiverNumber, senderNumber, "New Chat");

        const cleanBody = safeClean(body);

        // Save to DB
        const { data: savedMsg } = await supabase.from('messages').insert({
            sender_number: senderNumber,
            receiver_number: receiverNumber,
            body: cleanBody
        }).select().single();

        // --- REAL TIME NOTIFICATION ---
        const receiverSocketId = onlineUsers.get(receiverNumber);
        if (receiverSocketId) {
            // Send to Receiver
            io.to(receiverSocketId).emit('receive_message', savedMsg);
            // Send Signal to Refresh Contacts (puts chat at top)
            io.to(receiverSocketId).emit('refresh_contacts');
        }
        // ------------------------------

        // Web Push (Offline notification)
        const { data: receiver } = await supabase.from('profiles')
            .select('push_sub')
            .eq('phone_number', receiverNumber)
            .single();

        if (receiver && receiver.push_sub) {
            try {
                await webPush.sendNotification(receiver.push_sub, JSON.stringify({
                    title: `New Message`,
                    body: cleanBody,
                    sender: senderNumber 
                }));
            } catch (e) {}
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/messages/:myNumber', async (req, res) => {
    try {
        const { data, error } = await supabase.from('messages')
            .select('*')
            .or(`sender_number.eq.${req.params.myNumber},receiver_number.eq.${req.params.myNumber}`)
            .order('timestamp', { ascending: true })
            .limit(500);
        if (error) throw error;
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 5. ADD CONTACT (FIXED: Mutual Add & Real-time Update)
app.post('/contacts/add', async (req, res) => {
    try {
        const { ownerNumber, contactNumber, nickname } = req.body;
        
        // Check if contact exists
        const { data: contactUser } = await supabase.from('profiles').select('username').eq('phone_number', contactNumber).single();
        if (!contactUser) return res.status(404).json({ error: "User ID not found" });

        // Get Owner's username to save for the contact
        const { data: ownerUser } = await supabase.from('profiles').select('username').eq('phone_number', ownerNumber).single();

        // 1. Add for Owner (A -> B)
        await supabase.from('contacts').upsert({
            owner_number: ownerNumber,
            contact_number: contactNumber,
            nickname: safeClean(nickname)
        }, { onConflict: 'owner_number, contact_number'});

        // 2. Add for Contact (B -> A) - MUTUAL ADD
        // This ensures B sees A immediately
        await supabase.from('contacts').upsert({
            owner_number: contactNumber,
            contact_number: ownerNumber,
            nickname: ownerUser ? ownerUser.username : "New Contact"
        }, { onConflict: 'owner_number, contact_number'});

        // 3. REAL TIME UPDATE
        const contactSocketId = onlineUsers.get(contactNumber);
        if (contactSocketId) {
            io.to(contactSocketId).emit('refresh_contacts');
        }

        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/contacts/:myNumber', async (req, res) => {
    try {
        const { data, error } = await supabase.from('contacts').select('*').eq('owner_number', req.params.myNumber);
        if (error) throw error;
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/contacts/delete', async (req, res) => {
    try {
        await supabase.from('contacts').delete().eq('id', req.body.id);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/contacts/block', async (req, res) => {
    try {
        await supabase.from('blocks').upsert({ 
            blocker_number: req.body.ownerNumber, 
            blocked_number: req.body.blockedNumber 
        }, { onConflict: 'blocker_number, blocked_number' });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

const PORT = process.env.PORT || 3000;
// CHANGED FROM app.listen TO server.listen FOR SOCKET.IO
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
