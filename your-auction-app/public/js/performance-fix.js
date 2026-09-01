(() => {
  'use strict';
  let animReady=false;
  let listReady=false;
  let lastListSignature=null;

  function installAnimGuard(){
    if(!window.Anim||typeof window.Anim.staggerIn!=='function')return false;
    const original=window.Anim.staggerIn;
    if(original.__sslt10PerfWrapped)return true;
    const fast=function(elements,opts){
      const count=elements?.length||0;
      if(count>=8){if(window.gsap)window.gsap.set(elements,{opacity:1,y:0,clearProps:'transform'});return;}
      return original(elements,opts);
    };
    fast.__sslt10PerfWrapped=true;
    window.Anim.staggerIn=fast;
    animReady=true;
    return true;
  }

  function installListGuard(){
    if(typeof window.renderList!=='function')return false;
    if(window.renderList.__sslt10PerfWrapped)return true;
    const original=window.renderList;
    const guarded=function(){
      let signature='';
      try{
        const idx=document.getElementById('auctionNo')?.textContent||'';
        const status=document.getElementById('statusArea')?.textContent||'';
        const filter=document.querySelector('.ftab.active')?.dataset?.f||'';
        const search=document.getElementById('searchBox')?.value||'';
        signature=`${idx}|${status}|${filter}|${search}`;
      }catch(_){}
      if(signature&&signature===lastListSignature)return;
      lastListSignature=signature;
      return original.apply(this,arguments);
    };
    guarded.__sslt10PerfWrapped=true;
    window.renderList=guarded;
    listReady=true;
    return true;
  }

  const timer=setInterval(()=>{installAnimGuard();installListGuard();if(animReady&&listReady)clearInterval(timer);},50);
  setTimeout(()=>clearInterval(timer),12000);
})();
