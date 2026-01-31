const express = require('express');
const webPush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Filter = require('bad-words'); // Optional: keeps chats clean

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// --- ENV VARS ---
const publicVapidKey = process.env.PUBLIC_VAPID_KEY;
const privateVapidKey = process.env.PRIVATE_VAPID_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; // Must be SERVICE_ROLE key to bypass RLS if needed

const supabase = createClient(supabaseUrl, supabaseKey);
webPush.setVapidDetails('mailto:admin@txtapp.com', publicVapidKey, privateVapidKey);
const filter = new Filter();

// Helper: Generate 6-digit number
function generatePhoneNumber() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// 1. REGISTER (JOIN APP)
app.post('/register', async (req, res) => {
    const { subscription, username } = req.body;
    
    // Check if this device is already registered (optional cleanup)
    if (subscription && subscription.endpoint) {
        await supabase.from('profiles').delete().eq('push_sub->>endpoint', subscription.endpoint);
    }

    let phoneNumber = generatePhoneNumber();
    let unique = false;

    // Ensure uniqueness (simple retry logic)
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
    
    res.json({ 
        phoneNumber: data.phone_number, 
        username: data.username,
        id: data.id 
    });
});

// 2. SEND MESSAGE (TEXTING)
app.post('/send-message', async (req, res) => {
    let { senderNumber, receiverNumber, body } = req.body;

    if (!receiverNumber || !body) return res.status(400).json({ error: "Missing info" });

    // 1. Save to DB (History)
    const { error: dbError } = await supabase.from('messages').insert({
        sender_number: senderNumber,
        receiver_number: receiverNumber,
        body: filter.clean(body)
    });

    if (dbError) console.error("DB Error:", dbError);

    // 2. Find Receiver's Push Token
    const { data: receiverProfile } = await supabase
        .from('profiles')
        .select('push_sub')
        .eq('phone_number', receiverNumber)
        .single();

    if (!receiverProfile || !receiverProfile.push_sub) {
        return res.json({ status: "saved_but_offline", message: "Message saved, user not reachable via Push." });
    }

    // 3. Send Push Notification
    const payload = JSON.stringify({
        title: `New Text from ${senderNumber}`,
        body: filter.clean(body),
        type: 'message'
    });

    try {
        await webPush.sendNotification(receiverProfile.push_sub, payload, {
            headers: { 'Urgency': 'high' }
        });
        res.json({ success: true, message: "Sent successfully" });
    } catch (err) {
        // If 410, user deleted app/unsubbed
        if (err.statusCode === 410) {
             await supabase.from('profiles').update({ push_sub: null }).eq('phone_number', receiverNumber);
        }
        res.json({ success: false, error: err.message });
    }
});

// 3. SYNC MESSAGES (Fetch History)
app.get('/messages/:myNumber', async (req, res) => {
    const { myNumber } = req.params;
    
    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .or(`sender_number.eq.${myNumber},receiver_number.eq.${myNumber}`)
        .order('timestamp', { ascending: true })
        .limit(100);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Text App Server on ${PORT}`));
