// SSLT10 realtime transport: authenticated Socket.IO + SQLite-backed live state.
// The public auction UI keeps its existing Firestore-shaped API, but every
// connection now carries the backend-issued SSLT10 JWT.
const socket = io({
  auth: (cb) => cb({ token: sessionStorage.getItem('sslt10-token') || '' }),
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
});

socket.on('connect_error', (err) => {
  window.__sslt10SocketAuthError = err?.message || 'Realtime authentication failed';
  console.warn('SSLT10 realtime connection error:', window.__sslt10SocketAuthError);
});

function resolveSentinels(data){
  if(data && data._clockSyncTs && typeof data._clockSyncTs === 'object' && '__ts' in data._clockSyncTs){
    const ms = data._clockSyncTs.__ts;
    data = Object.assign({}, data, { _clockSyncTs: { toMillis: () => ms, toDate: () => new Date(ms) } });
  }
  return data;
}
function makeSnap(data){
  const resolved = resolveSentinels(data || {});
  return { data: () => resolved };
}
function emitAsync(event, payload, timeoutMs){
  timeoutMs = timeoutMs || 8000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if(settled) return;
      settled = true;
      reject(new Error('Could not reach the authenticated live server.'));
    }, timeoutMs);
    const done = (res) => {
      if(settled) return;
      settled = true;
      clearTimeout(timer);
      if(res && res.error) reject(new Error(res.error));
      else resolve(res);
    };
    socket.emit(event, payload, done);
  });
}

let localDoc = {};
function isPlainObjectC(v){ return typeof v === 'object' && v !== null && !Array.isArray(v); }
function isDeleteSentinelC(v){ return isPlainObjectC(v) && v.__op === 'delete'; }
function setOrMergeLeafC(target, key, value){
  if(isDeleteSentinelC(value)){ delete target[key]; return; }
  if(isPlainObjectC(value)){
    if(!isPlainObjectC(target[key])) target[key] = {};
    mergeIntoC(target[key], value);
    return;
  }
  target[key] = value;
}
function mergeIntoC(target, source){
  for(const rawKey of Object.keys(source || {})){
    const value = source[rawKey];
    if(rawKey.includes('.')){
      const parts = rawKey.split('.');
      let cursor = target;
      for(let i=0;i<parts.length-1;i++){
        const p = parts[i];
        if(!isPlainObjectC(cursor[p])) cursor[p] = {};
        cursor = cursor[p];
      }
      setOrMergeLeafC(cursor, parts[parts.length-1], value);
    } else {
      setOrMergeLeafC(target, rawKey, value);
    }
  }
}

window.firebase = {
  firestore: {
    FieldValue: {
      delete: () => ({ __op: 'delete' }),
      serverTimestamp: () => ({ __op: 'serverTimestamp' })
    }
  }
};

const liveDocRef = {
  async get(){
    const doc = await emitAsync('get');
    return makeSnap(doc);
  },
  async set(fields){
    await emitAsync('set', fields);
  },
  onSnapshot(cb){
    const snapHandler = (doc) => { localDoc = doc || {}; cb(makeSnap(localDoc)); };
    const patchHandler = (fields) => { mergeIntoC(localDoc, fields || {}); cb(makeSnap(localDoc)); };
    socket.on('snapshot', snapHandler);
    socket.on('patch', patchHandler);
    if(socket.connected){
      emitAsync('get').then(doc => { localDoc = doc || {}; cb(makeSnap(localDoc)); }).catch(()=>{});
    }
    return () => { socket.off('snapshot', snapHandler); socket.off('patch', patchHandler); };
  }
};

const db = {
  async runTransaction(updateFn){
    const { txId, doc } = await emitAsync('beginTransaction');
    let pendingUpdates = null;
    const tx = {
      async get(){ return makeSnap(doc); },
      set(ref, updates){ pendingUpdates = Object.assign(pendingUpdates || {}, updates); }
    };
    try{
      const result = await updateFn(tx);
      await emitAsync('commitTransaction', { txId, updates: pendingUpdates || {} });
      return result;
    }catch(e){
      emitAsync('abortTransaction', { txId }).catch(()=>{});
      throw e;
    }
  }
};
