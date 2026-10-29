// auth.js
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.warn(
        '[auth] WARNING: JWT_SECRET not set — using insecure dev default.\n' +
        '       Set JWT_SECRET in atlas-credentials.env before deploying.',
    );
}
const SECRET = JWT_SECRET || 'hareeg-dev-secret-do-not-use-in-production';
const EXPIRES_IN = '30d';

function signToken(userId) {
    return jwt.sign({ sub: userId }, SECRET, { expiresIn: EXPIRES_IN });
}

function verifyToken(token) {
    try {
        const payload = jwt.verify(token, SECRET);
        if (payload && typeof payload.sub === 'string') return payload.sub;
        return null;
    } catch (_) {
        return null;
    }
}

module.exports = { signToken, verifyToken };