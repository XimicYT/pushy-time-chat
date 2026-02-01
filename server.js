const express = require('express');
const webPush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Filter = require('bad-words');
const bcrypt = require('bcrypt');

const app = express();

const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(bodyParser.json({ limit: '10mb' }));

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

// 1. HEALTH CHECK (Used by frontend to wait for connection)
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

        // Note: We don't enforce unique usernames, but it helps for login if they are.
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

// 3. LOGIN (Updated for Username OR ID)
app.post('/login', async (req, res) => {
    try {
        const { identifier, password, subscription } = req.body;

        // Determine if input is an ID (6 digits) or a Username
        let query = supabase.from('profiles').select('*');
        if (/^\d{6}$/.test(identifier)) {
            query = query.eq('phone_number', identifier);
        } else {
            // Case-insensitive match for username would be better, but we'll stick to exact match 
            // for simplicity unless you added the Citext extension to Supabase.
            query = query.eq('username', identifier);
        }

        const { data: user } = await query.single();

        if (!user) return res.status(404).json({ error: "User not found" });

        if (!user.password_hash) {
            return res.status(403).json({ error: "Account too old. No password set." });
        }

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

// 4. SEND MESSAGE
app.post('/send-message', async (req, res) => {
    try {
        let { senderNumber, receiverNumber, body } = req.body;
        const { data: blockData } = await supabase.from('blocks')
            .select('*')
            .eq('blocker_number', receiverNumber)
            .eq('blocked_number', senderNumber)
            .single();

        if (blockData) return res.json({ success: true, status: 'blocked' }); 

        await ensureContactExists(senderNumber, receiverNumber, "New Contact");
        await ensureContactExists(receiverNumber, senderNumber, "New Chat");

        const cleanBody = safeClean(body);

        await supabase.from('messages').insert({
            sender_number: senderNumber,
            receiver_number: receiverNumber,
            body: cleanBody
        });

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

app.post('/contacts/add', async (req, res) => {
    try {
        const { ownerNumber, contactNumber, nickname } = req.body;
        const { data: user } = await supabase.from('profiles').select('id').eq('phone_number', contactNumber).single();

        if (!user) return res.status(404).json({ error: "User ID not found" });

        const { error } = await supabase.from('contacts').insert({
            owner_number: ownerNumber,
            contact_number: contactNumber,
            nickname: safeClean(nickname)
        });

        if (error && error.code === '23505') return res.status(400).json({ error: "Contact already saved" });
        if (error) throw error;
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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
