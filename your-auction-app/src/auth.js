// Host Setup gate — replaces the old per-admin-account JWT/bcrypt system.
// There is no signup, no accounts, no per-user ownership: anyone who knows
// the HOST_SETUP_KEY (set in .env, shared with whoever runs the auction)
// can open Setup and configure the single auction. This matches how the
// host/team-owner login already works elsewhere in the app (a shared
// password per role) rather than introducing a separate account system
// for a single-tenant deployment.

class AuthError extends Error { constructor(m){ super(m); this.name='AuthError'; } }

function requireSetupKey(req, res, next){
  const key = process.env.HOST_SETUP_KEY;
  if(!key){
    return res.status(500).json({ error: 'Server is missing HOST_SETUP_KEY — set it in .env before using Setup.' });
  }
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : null;
  if(!supplied || supplied !== key){
    return res.status(401).json({ error: 'Incorrect setup key.' });
  }
  next();
}

module.exports = { requireSetupKey, AuthError };
