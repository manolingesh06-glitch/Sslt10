require('dotenv').config();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 12);
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';
let JWT_SECRET = process.env.JWT_SECRET || null;
if (!JWT_SECRET) {
  const stored = db.get("SELECT value FROM app_settings WHERE key='jwt_secret'");
  JWT_SECRET = stored?.value || crypto.randomBytes(48).toString('hex');
  if (!stored) db.run("INSERT INTO app_settings (key,value) VALUES ('jwt_secret',?)", [JWT_SECRET]);
}

class HostAuthError extends Error { constructor(message) { super(message); this.name = 'HostAuthError'; } }
function issueToken(user){return jwt.sign({userId:user.id,username:user.username,role:user.role,teamId:user.team_id||null,team:user.short_name||null},JWT_SECRET,{expiresIn:JWT_EXPIRES_IN});}
async function authenticate(username,password){
  const clean=String(username||'').trim().toLowerCase();
  const supplied=String(password||'');
  if(!clean||!supplied)throw new HostAuthError('Username and password required');
  const user=db.get(`SELECT u.*,t.short_name FROM users u LEFT JOIN teams t ON t.id=u.team_id WHERE lower(u.username)=? AND u.active=1 LIMIT 1`,[clean]);
  if(!user||!(await bcrypt.compare(supplied,user.password_hash)))throw new HostAuthError('Invalid username or password.');
  return {token:issueToken(user),role:user.role,team:user.short_name||null,username:user.username,userId:user.id};
}
function verifyToken(token){return jwt.verify(token,JWT_SECRET);}
function requireRole(...roles){return(req,res,next)=>{const header=req.headers.authorization||'';const token=header.startsWith('Bearer ')?header.slice(7):null;if(!token)return res.status(401).json({error:'Authentication required'});try{req.user=verifyToken(token);if(roles.length&&!roles.includes(req.user.role))return res.status(403).json({error:'Forbidden'});next();}catch{return res.status(401).json({error:'Invalid or expired session'});}};}
async function setUserPassword(userId,nextPassword){const value=String(nextPassword||'');if(value.length<8)throw new HostAuthError('Password must be at least 8 characters');const hash=await bcrypt.hash(value,SALT_ROUNDS);db.run("UPDATE users SET password_hash=?,updated_at=datetime('now') WHERE id=?",[userId,hash]);}
module.exports={authenticate,verifyToken,requireRole,setUserPassword,HostAuthError};
