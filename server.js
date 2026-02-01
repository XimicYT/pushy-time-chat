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

// 1. REGISTER / LOGIN
app.post('/register', async (req, res) => {
    const { subscription, username } = req.body;
    let { existingNumber } = req.body; // Logic to recover account if they know their number

    // If user claims to have a number, try to update their push sub
    if (existingNumber) {
        const { data } = await supabase.from('profiles').select('*').eq('phone_number', existingNumber).single();
        if (data) {
            await supabase.from('profiles').update({ push_sub: subscription }).eq('phone_number', existingNumber);
            return res.json({ phoneNumber: data.phone_number, username: data.username, restored: true });
        }
    }

    // Otherwise, create new
    let phoneNumber = generatePhoneNumber();
    let unique = false;
    
    // Retry loop to ensure unique number
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

    // Save to DB
    await supabase.from('messages').insert({
        sender_number: senderNumber,
        receiver_number: receiverNumber,
        body: filter.clean(body)
    });

    // Send Push Notification
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

// 3. GET MESSAGES (Sync)
app.get('/messages/:myNumber', async (req, res) => {
    // Fetch last 500 messages involving this user
    const { data } = await supabase
        .from('messages')
        .select('*')
        .or(`sender_number.eq.${req.params.myNumber},receiver_number.eq.${req.params.myNumber}`)
        .order('timestamp', { ascending: true })
        .limit(500);
    res.json(data);
});

// 4. ADD CONTACT
app.post('/contacts/add', async (req, res) => {
    const { ownerNumber, contactNumber, nickname } = req.body;

    // Check if user exists
    const { data: user } = await supabase.from('profiles').select('id').eq('phone_number', contactNumber).single();
    if (!user) return res.status(404).json({ error: "Number not found. User must register first." });

    const { error } = await supabase.from('contacts').insert({
        owner_number: ownerNumber,
        contact_number: contactNumber,
        nickname: nickname
    });

    if (error) return res.status(400).json({ error: "Contact already saved." });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
