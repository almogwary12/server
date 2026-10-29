// db.js
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'hareeg';

let client = null;
let db = null;

async function connect() {
    if (db) return db;
    if (!MONGODB_URI) {
        throw new Error(
            'MONGODB_URI is not set. Add it to atlas-credentials.env.',
        );
    }
    client = new MongoClient("mongodb+srv://almogwary2233_db_user:wZlWGxv1qpueoE9s@cluster0.q9rgmwm.mongodb.net/", { autoSelectFamily: false });
    await client.connect();
    db = client.db(DB_NAME);

    await db.collection('users').createIndex({ username: 1 }, { unique: true });
    await db.collection('users').createIndex({ displayName: 1 });

    console.log(`[db] connected to MongoDB Atlas (${DB_NAME})`);
    return db;
}

async function close() {
    if (client) {
        await client.close();
        client = null;
        db = null;
    }
}

function users() {
    if (!db) throw new Error('DB not connected. Call db.connect() first.');
    return db.collection('users');
}

async function signup(username, password, displayName) {
    const clean = String(username || '').trim().toLowerCase();
    const pass = String(password || '');

    if (clean.length < 3 || clean.length > 20) return { error: 'username-invalid' };
    if (!/^[a-z0-9_]+$/.test(clean)) return { error: 'username-invalid' };
    if (pass.length < 6 || pass.length > 100) return { error: 'password-invalid' };

    const dn = String(displayName || clean).trim().slice(0, 20) || clean;

    const existing = await users().findOne({ username: clean });
    if (existing) return { error: 'username-taken' };

    const passwordHash = await bcrypt.hash(pass, 10);
    const now = new Date();

    const doc = {
        username: clean,
        passwordHash,
        displayName: dn,
        level: 1,
        stars: 0,
        coins: 0,
        xp: 0,
        xpMax: 1000,
        stats: { gamesPlayed: 0, gamesWon: 0, totalScore: 0 },
        createdAt: now,
        lastLoginAt: now,
    };

    const result = await users().insertOne(doc);
    doc._id = result.insertedId;
    return { user: doc };
}

async function login(username, password) {
    const clean = String(username || '').trim().toLowerCase();
    const pass = String(password || '');

    const user = await users().findOne({ username: clean });
    if (!user) return { error: 'credentials-invalid' };

    const ok = await bcrypt.compare(pass, user.passwordHash);
    if (!ok) return { error: 'credentials-invalid' };

    await users().updateOne(
        { _id: user._id },
        { $set: { lastLoginAt: new Date() } },
    );
    return { user };
}

async function findById(id) {
    if (!ObjectId.isValid(id)) return null;
    return users().findOne({ _id: new ObjectId(id) });
}

async function updateProfile(id, updates) {
    if (!ObjectId.isValid(id)) return null;
    const allowed = ['displayName', 'level', 'stars', 'coins', 'xp', 'xpMax'];
    const set = {};
    for (const k of allowed) {
        if (updates[k] !== undefined) set[k] = updates[k];
    }
    if (Object.keys(set).length === 0) return null;

    await users().updateOne({ _id: new ObjectId(id) }, { $set: set });
    return users().findOne({ _id: new ObjectId(id) });
}

async function incrementStats(
    id,
    { won = false, scoreDelta = 0, xpDelta = 0, starDelta = 0, coinDelta = 0 } = {},
) {
    if (!ObjectId.isValid(id)) return null;
    const inc = {
        'stats.gamesPlayed': 1,
        'stats.totalScore': scoreDelta,
        stars: starDelta,
        coins: coinDelta,
        xp: xpDelta,
    };
    if (won) inc['stats.gamesWon'] = 1;

    await users().updateOne(
        { _id: new ObjectId(id) },
        { $inc: inc, $set: { lastLoginAt: new Date() } },
    );
    return users().findOne({ _id: new ObjectId(id) });
}

function publicProfile(user) {
    return {
        id: user._id.toString(),
        username: user.username,
        displayName: user.displayName,
        level: user.level,
        stars: user.stars,
        coins: user.coins,
        xp: user.xp,
        xpMax: user.xpMax,
        stats: user.stats || { gamesPlayed: 0, gamesWon: 0, totalScore: 0 },
    };
}

module.exports = {
    connect,
    close,
    users,
    signup,
    login,
    findById,
    updateProfile,
    incrementStats,
    publicProfile,
};