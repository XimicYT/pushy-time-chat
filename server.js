const express = require('express');
const webPush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Filter = require('bad-words');

const app = express();

// --- 1. ROBUST CORS CONFIGURATION ---
// This allows your Netlify app to talk to this server
const corsOptions = {
    origin: '*', // Allow all origins for now to fix the blocking issue immediately
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Enable pre-flight for all routes

app.use(bodyParser.json({ limit: '10mb' }));

// --- CONFIG ---
// Check if keys exist to prevent startup crashes
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("CRITICAL ERROR: Supabase Credentials missing in Render Environment Variables.");
}

const publicVapidKey = process.env.PUBLIC_VAPID_KEY;
const privateVapidKey = process.env.PRIVATE_VAPID_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

if (publicVapidKey && privateVapidKey) {
    webPush.setVapidDetails('mailto:admin@txtapp.com', publicVapidKey, privateVapidKey);
}

const filter = new Filter();

// Helper: Generate Random 6-Digit Number
function generatePhoneNumber() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper: Ensure Contact Exists
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
    } catch (err) {
        console.error("Auto-add contact error:", err.message);
    }
}

// --- HEALTH CHECK ROUTE ---
// Use this to check if server is alive in browser
app.get('/', (req, res) => {
    res.send('Server is running and healthy.');
});

// 1. REGISTER / LOGIN
app.post('/register', async (req, res) => {
    try {
        const { subscription, username, existingNumber } = req.body;

        if (existingNumber) {
            const { data } = await supabase.from('profiles').select('*').eq('phone_number', existingNumber).single();
            if (data) {
                await supabase.from('profiles').update({ push_sub: subscription }).eq('phone_number', existingNumber);
                return res.json({ phoneNumber: data.phone_number, username: data.username, restored: true });
            }
        }

        let phoneNumber = generatePhoneNumber();
        let unique = false;
        
        // Retry logic for uniqueness
        let attempts = 0;
        while (!unique && attempts < 5) {
            const { data } = await supabase.from('profiles').select('phone_number').eq('phone_number', phoneNumber);
            if (!data || data.length === 0) unique = true;
            else phoneNumber = generatePhoneNumber();
            attempts++;
        }

        const { data, error } = await supabase.from('profiles').insert({
            username: filter.clean(username || "User"),
            phone_number: phoneNumber,
            push_sub: subscription
        }).select().single();

        if (error) throw error;
        res.json({ phoneNumber: data.phone_number, username: data.username, restored: false });
    } catch (error) {
        console.error('/register error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. SEND MESSAGE
app.post('/send-message', async (req, res) => {
    try {
        let { senderNumber, receiverNumber, body } = req.body;

        const { data: blockData } = await supabase
            .from('blocks')
            .select('*')
            .eq('blocker_number', receiverNumber)
            .eq('blocked_number', senderNumber)
            .single();

        if (blockData) return res.json({ success: true, status: 'blocked' }); 

        await ensureContactExists(senderNumber, receiverNumber, "New Contact");
        await ensureContactExists(receiverNumber, senderNumber, "New Chat");

        await supabase.from('messages').insert({
            sender_number: senderNumber,
            receiver_number: receiverNumber,
            body: filter.clean(body || "")
        });

        // Push Notification
        const { data: receiver } = await supabase
            .from('profiles')
            .select('push_sub')
            .eq('phone_number', receiverNumber)
            .single();

        if (receiver && receiver.push_sub) {
            try {
                await webPush.sendNotification(receiver.push_sub, JSON.stringify({
                    title: `New Message`,
                    body: filter.clean(body || "Image"),
                    sender: senderNumber 
                }));
            } catch (e) { console.error("Push failed (non-fatal):", e.message); }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('/send-message error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 3. GET MESSAGES
app.get('/messages/:myNumber', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .or(`sender_number.eq.${req.params.myNumber},receiver_number.eq.${req.params.myNumber}`)
            .order('timestamp', { ascending: true })
            .limit(500);
        
        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('/messages error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. ADD CONTACT
app.post('/contacts/add', async (req, res) => {
    try {
        const { ownerNumber, contactNumber, nickname } = req.body;

        const { data: user } = await supabase
            .from('profiles')
            .select('id')
            .eq('phone_number', contactNumber)
            .single();

        if (!user) return res.status(404).json({ error: "User ID not found" });

        const { error } = await supabase.from('contacts').insert({
            owner_number: ownerNumber,
            contact_number: contactNumber,
            nickname: nickname
        });

        if (error) {
            // Check for duplicate key error code from Postgres
            if (error.code === '23505') return res.status(400).json({ error: "Contact already saved" });
            throw error;
        }
        res.json({ success: true });
    } catch (error) {
        console.error('/contacts/add error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 5. GET CONTACTS
app.get('/contacts/:myNumber', async (req, res) => {
    try {
        const { data, error } = await supabase.from('contacts').select('*').eq('owner_number', req.params.myNumber);
        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('/contacts error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 6. DELETE CONTACT
app.post('/contacts/delete', async (req, res) => {
    try {
        const { id } = req.body;
        const { error } = await supabase.from('contacts').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. BLOCK USER
app.post('/contacts/block', async (req, res) => {
    try {
        const { ownerNumber, blockedNumber } = req.body;
        const { error } = await supabase.from('blocks').upsert({ 
            blocker_number: ownerNumber, 
            blocked_number: blockedNumber 
        }, { onConflict: 'blocker_number, blocked_number' });

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
