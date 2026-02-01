const express = require('express');
const webPush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Filter = require('bad-words');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// --- CONFIG ---
const publicVapidKey = process.env.PUBLIC_VAPID_KEY;
const privateVapidKey = process.env.PRIVATE_VAPID_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
webPush.setVapidDetails('mailto:admin@txtapp.com', publicVapidKey, privateVapidKey);
const filter = new Filter();

// Helper: Generate Random 6-Digit Number
function generatePhoneNumber() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper: Ensure Contact Exists (Auto-Add)
async function ensureContactExists(owner, contact, defaultName) {
    // Check if relationship already exists
    const { data } = await supabase.from('contacts')
        .select('id')
        .match({ owner_number: owner, contact_number: contact })
        .single();
    
    if (!data) {
        // If not, try to fetch the contact's actual username
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
}

// 1. REGISTER / LOGIN
app.post('/register', async (req, res) => {
    const { subscription, username } = req.body;
    let { existingNumber } = req.body;

    if (existingNumber) {
        const { data } = await supabase.from('profiles').select('*').eq('phone_number', existingNumber).single();
        if (data) {
            await supabase.from('profiles').update({ push_sub: subscription }).eq('phone_number', existingNumber);
            return res.json({ phoneNumber: data.phone_number, username: data.username, restored: true });
        }
    }

    let phoneNumber = generatePhoneNumber();
    let unique = false;
    
    while (!unique) {
        const { data } = await supabase.from('profiles').select('phone_number').eq('phone_number', phoneNumber);
        if (!data || data.length === 0) unique = true;
        else phoneNumber = generatePhoneNumber();
    }

    const { data, error } = await supabase.from('profiles').insert({
        username: filter.clean(username),
        phone_number: phoneNumber,
        push_sub: subscription
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ phoneNumber: data.phone_number, username: data.username, restored: false });
});

// 2. SEND MESSAGE
app.post('/send-message', async (req, res) => {
    let { senderNumber, receiverNumber, body } = req.body;

    // Check Block Status
    const { data: blockData } = await supabase
        .from('blocks')
        .select('*')
        .eq('blocker_number', receiverNumber)
        .eq('blocked_number', senderNumber)
        .single();

    if (blockData) {
        return res.json({ success: true, status: 'blocked' }); 
    }

    // Auto-Add Contacts
    await ensureContactExists(senderNumber, receiverNumber, "New Contact");
    await ensureContactExists(receiverNumber, senderNumber, "New Chat");

    // Save Message
    await supabase.from('messages').insert({
        sender_number: senderNumber,
        receiver_number: receiverNumber,
        body: filter.clean(body)
    });

    // Send Notification
    const { data: receiver } = await supabase
        .from('profiles')
        .select('push_sub')
        .eq('phone_number', receiverNumber)
        .single();

    if (receiver && receiver.push_sub) {
        try {
            await webPush.sendNotification(receiver.push_sub, JSON.stringify({
                title: `New Message`,
                body: filter.clean(body),
                sender: senderNumber 
            }));
        } catch (e) { console.error("Push Error:", e); }
    }

    res.json({ success: true });
});

// 3. GET MESSAGES
app.get('/messages/:myNumber', async (req, res) => {
    const { data } = await supabase
        .from('messages')
        .select('*')
        .or(`sender_number.eq.${req.params.myNumber},receiver_number.eq.${req.params.myNumber}`)
        .order('timestamp', { ascending: true })
        .limit(500);
    res.json(data);
});

// 4. ADD CONTACT (Manual - With Existence Check)
app.post('/contacts/add', async (req, res) => {
    const { ownerNumber, contactNumber, nickname } = req.body;

    // VALIDATION: Check if the phone number exists in 'profiles'
    const { data: user } = await supabase
        .from('profiles')
        .select('id')
        .eq('phone_number', contactNumber)
        .single();

    if (!user) {
        return res.status(404).json({ error: "User ID not found" });
    }

    const { error } = await supabase.from('contacts').insert({
        owner_number: ownerNumber,
        contact_number: contactNumber,
        nickname: nickname
    });

    if (error) return res.status(400).json({ error: "Contact already saved" });
    res.json({ success: true });
});

// 5. GET CONTACTS
app.get('/contacts/:myNumber', async (req, res) => {
    const { data } = await supabase.from('contacts').select('*').eq('owner_number', req.params.myNumber);
    res.json(data);
});

// 6. DELETE CONTACT
app.post('/contacts/delete', async (req, res) => {
    const { id } = req.body;
    await supabase.from('contacts').delete().eq('id', id);
    res.json({ success: true });
});

// 7. BLOCK USER
app.post('/contacts/block', async (req, res) => {
    const { ownerNumber, blockedNumber } = req.body;
    
    const { error } = await supabase.from('blocks').upsert({ 
        blocker_number: ownerNumber, 
        blocked_number: blockedNumber 
    }, { onConflict: 'blocker_number, blocked_number' });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
