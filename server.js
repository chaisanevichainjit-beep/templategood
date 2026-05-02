const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json());

// --- IN-MEMORY CACHE ---
let leaderboardCache = []; 
let minCoinsToEnter = 0;

// Loads Top 100 from DB on startup
const hydrateCache = async () => {
    try {
        console.log("Syncing Dashers.io cache with Firestore...");
        const snapshot = await db.collection('leaderboard')
            .orderBy('coins', 'desc')
            .limit(100)
            .get();

        leaderboardCache = snapshot.docs.map(doc => doc.data());
        
        // Set the threshold score from the 100th person
        if (leaderboardCache.length >= 100) {
            minCoinsToEnter = leaderboardCache[99].coins;
        } else {
            minCoinsToEnter = 0;
        }
    } catch (err) {
        console.error("Hydration Error:", err);
    }
};

// Start hydration immediately
hydrateCache();

// --- ENDPOINTS ---

// 1. GET LEADERBOARD (0 Reads - Served from RAM)
app.get('/api/leaderboard', (req, res) => {
    res.status(200).json(leaderboardCache);
});

// 2. POST SCORE (The "One-In, One-Out" Logic)
app.post('/api/score', async (req, res) => {
    const { userId, username, avatar, coins } = req.body;
    
    if (!userId || coins === undefined) {
        return res.status(400).json({ error: "Missing required data" });
    }

    try {
        // Find if user is already in our local Top 100
        const existingIndex = leaderboardCache.findIndex(p => p.userId === userId);
        const isAlreadyInTop100 = existingIndex !== -1;

        // OPTIMIZATION: If coins are too low to enter and user isn't already there, STOP.
        if (!isAlreadyInTop100 && coins <= minCoinsToEnter && leaderboardCache.length >= 100) {
            return res.status(200).json({ updated: false, reason: "Below Top 100" });
        }

        // If they are in the list but didn't beat their own Highest Wealth record, STOP.
        if (isAlreadyInTop100 && coins <= leaderboardCache[existingIndex].coins) {
            return res.status(200).json({ updated: false, reason: "Not a personal best" });
        }

        // --- DATABASE UPDATE ---
        const userDocRef = db.collection('leaderboard').doc(userId);
        const userData = { userId, username, avatar, coins, updatedAt: Date.now() };
        
        await userDocRef.set(userData, { merge: true });

        // Update local RAM cache
        if (isAlreadyInTop100) {
            leaderboardCache[existingIndex] = userData;
        } else {
            leaderboardCache.push(userData);
        }

        // Sort by highest coins
        leaderboardCache.sort((a, b) => b.coins - a.coins);

        // --- AUTOMATIC CLEANUP (Keep DB at exactly 100) ---
        if (leaderboardCache.length > 100) {
            // The person who dropped to rank 101
            const extraPlayer = leaderboardCache.pop(); 
            
            // Delete them from Firestore so the DB stays at exactly 100
            await db.collection('leaderboard').doc(extraPlayer.userId).delete();
            console.log(`Removed ${extraPlayer.username} from DB (Rank 101)`);
        }

        // Update threshold for next request
        if (leaderboardCache.length >= 100) {
            minCoinsToEnter = leaderboardCache[99].coins;
        }

        res.status(200).json({ success: true, updated: true });
    } catch (error) {
        console.error("Score Error:", error);
        res.status(500).json({ error: "Server Error" });
    }
});

app.get('/', (req, res) => res.send('Dashers.io Leaderboard API Online'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
