  // REALTIME BACKEND: Socket.IO connection to this app's own server
  // (src/liveState.js + src/server.js), replacing Firestore. Every device
  // (host + all 12 owners) still sees one shared live-auction "document";
  // it's just held in this server's memory + SQLite now instead of
  // Google's Firestore, so there's no per-listener throttling and no
  // network hop to another continent — updates land in milliseconds
  // instead of the second-plus lag you were seeing with 13-14 people
  // bidding at once.
  //
  // This block implements the EXACT SAME interface your code below
  // already calls — db.runTransaction(), liveDocRef.get()/.set()/
  // .onSnapshot(), firebase.firestore.FieldValue.delete()/
  // .serverTimestamp() — so nothing past this point in the file needed
  // to change. See src/liveState.js on the server for the merge and
  // transaction logic this talks to.
  const socket = io();

  function resolveSentinels(data){
    // Only _clockSyncTs ever uses serverTimestamp(). Give it back the same
    // .toMillis()/.toDate() shape your clock-sync code already expects
    // from a real Firestore Timestamp.
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
      // Without this, a socket that never connects (wrong host, backend
      // not running, blocked websocket, etc.) leaves this Promise pending
      // forever — which is exactly why login could get stuck on
      // "Logging in…" with no error and no way out. Now it fails loud
      // and clear after 8s instead of hanging indefinitely.
      const timer = setTimeout(() => {
        if(settled) return;
        settled = true;
        reject(new Error('Could not reach the live server — check your connection and that the backend is running.'));
      }, timeoutMs);
      socket.emit(event, payload, (res) => {
        if(settled) return;
        settled = true;
        clearTimeout(timer);
        if(res && res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  // --- Local mirror of the live doc, kept in sync via small PATCH events
  // instead of the server resending the entire doc (500+ players' worth
  // of data, plus growing bid/chat history) on every single bid, pass,
  // or chat message. 'snapshot' still arrives once on initial connect and
  // on every reconnect, to fully resync in case a patch was missed while
  // offline; 'patch' events land in between and get merged in here using
  // the exact same merge rules the server uses (dotted keys address
  // nested fields, delete sentinel removes a field).
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
      // Fire once immediately with current data, same as Firestore's
      // onSnapshot behavior, so the first render doesn't wait for a change.
      emitAsync('get').then(doc => { localDoc = doc || {}; cb(makeSnap(localDoc)); }).catch(()=>{});
      return () => { socket.off('snapshot', snapHandler); socket.off('patch', patchHandler); };
    }
  };

  const db = {
    async runTransaction(updateFn){
      // Server hands us a lock + the current doc; only we can write until
      // we commit or abort, so there's no window for another device's
      // write to land in between our read and our write (the exact
      // guarantee your passOnPlayer()/placeOwnerBid() transactions rely on).
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
