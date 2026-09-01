// SSLT10 realtime transport: authenticated Socket.IO + SQLite-backed live state.
const socket = io({
  autoConnect: false,
  auth: (cb) => cb({ token: sessionStorage.getItem('sslt10-token') || '' }),
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
});
function connectRealtime(){
  const token=sessionStorage.getItem('sslt10-token');
  if(!token){if(socket.connected)socket.disconnect();return;}
  socket.auth={token};
  if(!socket.connected)socket.connect();
}
window.__sslt10ConnectRealtime=connectRealtime;
window.addEventListener('sslt10-auth-ready',connectRealtime);
socket.on('connect_error',(err)=>{window.__sslt10SocketAuthError=err?.message||'Realtime authentication failed';});
socket.on('connect',()=>{window.__sslt10SocketAuthError=null;});
function resolveSentinels(data){if(data&&data._clockSyncTs&&typeof data._clockSyncTs==='object'&&'__ts' in data._clockSyncTs){const ms=data._clockSyncTs.__ts;data=Object.assign({},data,{_clockSyncTs:{toMillis:()=>ms,toDate:()=>new Date(ms)}});}return data;}
function makeSnap(data){return{data:()=>resolveSentinels(data||{})};}
function emitAsync(event,payload,timeoutMs){timeoutMs=timeoutMs||8000;connectRealtime();return new Promise((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>{if(settled)return;settled=true;reject(new Error('Could not reach the authenticated live server.'));},timeoutMs);socket.emit(event,payload,(res)=>{if(settled)return;settled=true;clearTimeout(timer);if(res&&res.error)reject(new Error(res.error));else resolve(res);});});}
let localDoc={};const snapshotListeners=new Set();let patchFrame=null,pendingPatch={};const raf=window.requestAnimationFrame||((fn)=>setTimeout(fn,16));
function flushPatch(){patchFrame=null;const patch=pendingPatch;pendingPatch={};mergeIntoC(localDoc,patch);snapshotListeners.forEach(cb=>cb(makeSnap(localDoc)));}
function queuePatch(fields){mergeIntoC(pendingPatch,fields||{});if(patchFrame===null)patchFrame=raf(flushPatch);}
function isPlainObjectC(v){return typeof v==='object'&&v!==null&&!Array.isArray(v);}function isDeleteSentinelC(v){return isPlainObjectC(v)&&v.__op==='delete';}function setOrMergeLeafC(target,key,value){if(isDeleteSentinelC(value)){delete target[key];return;}if(isPlainObjectC(value)){if(!isPlainObjectC(target[key]))target[key]={};mergeIntoC(target[key],value);return;}target[key]=value;}function mergeIntoC(target,source){for(const rawKey of Object.keys(source||{})){const value=source[rawKey];if(rawKey.includes('.')){const parts=rawKey.split('.');let cursor=target;for(let i=0;i<parts.length-1;i++){const p=parts[i];if(!isPlainObjectC(cursor[p]))cursor[p]={};cursor=cursor[p];}setOrMergeLeafC(cursor,parts[parts.length-1],value);}else setOrMergeLeafC(target,rawKey,value);}}
window.firebase={firestore:{FieldValue:{delete:()=>({__op:'delete'}),serverTimestamp:()=>({__op:'serverTimestamp'})}}};
function normalizeClientWrite(fields){const out=Object.assign({},fields||{});for(const key of Object.keys(out)){if(key.startsWith('presence.')){const team=key.slice('presence.'.length);const next=Object.assign({},localDoc.presence||{});const value=out[key];if(isDeleteSentinelC(value))delete next[team];else next[team]=value;delete out[key];out.presence=next;}}return out;}
const liveDocRef={async get(){return makeSnap(await emitAsync('get'));},async set(fields){await emitAsync('set',normalizeClientWrite(fields));},onSnapshot(cb){snapshotListeners.add(cb);const snapHandler=doc=>{localDoc=doc||{};cb(makeSnap(localDoc));};socket.on('snapshot',snapHandler);if(socket.connected)emitAsync('get').then(doc=>{localDoc=doc||{};cb(makeSnap(localDoc));}).catch(()=>{});else connectRealtime();return()=>{snapshotListeners.delete(cb);socket.off('snapshot',snapHandler);};}};socket.on('patch',queuePatch);
const db={async runTransaction(updateFn){const {txId,doc}=await emitAsync('beginTransaction');let pendingUpdates=null;const tx={async get(){return makeSnap(doc);},set(ref,updates){pendingUpdates=Object.assign(pendingUpdates||{},updates);}};try{const result=await updateFn(tx);await emitAsync('commitTransaction',{txId,updates:normalizeClientWrite(pendingUpdates||{})});return result;}catch(e){emitAsync('abortTransaction',{txId}).catch(()=>{});throw e;}}};