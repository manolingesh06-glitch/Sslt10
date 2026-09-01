const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 10);

class AuthError extends Error { constructor(m){ super(m); this.name='AuthError'; } }

async function signup(username, password){
  if(db.get(`SELECT id FROM admins WHERE username = ?`, [username])) {
    throw new AuthError('That username is already taken.');
  }
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const { lastInsertId } = db.run(`INSERT INTO admins (username, password_hash) VALUES (?,?)`, [username, hash]);
  return issueToken(lastInsertId);
}

async function login(username, password){
  const admin = db.get(`SELECT * FROM admins WHERE username = ?`, [username]);
  if(!admin) throw new AuthError('Invalid username or password.');
  const ok = await bcrypt.compare(password, admin.password_hash);
  if(!ok) throw new AuthError('Invalid username or password.');
  return issueToken(admin.id);
}

function issueToken(adminId){
  const token = jwt.sign({ adminId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });
  return { token };
}

function requireAuth(req, res, next){
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if(!token) return res.status(401).json({ error: 'Missing token' });
  try{
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  }catch(e){
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { signup, login, requireAuth, AuthError };
