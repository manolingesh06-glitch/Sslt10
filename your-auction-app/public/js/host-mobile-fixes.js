(() => {
  const style=document.createElement('style');
  style.id='sslt10-mobile-fixes';
  style.textContent=`
    html,body{max-width:100%;overflow-x:hidden}
    button,input,select,textarea{font:inherit}
    #loginScreen input{font-size:16px}
    #sslt10HostOverlay{padding:max(8px,env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) max(8px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left))}
    #sslt10HostPanel{width:100%;max-width:1180px;min-height:100%;border-radius:14px}
    #sslt10HostBtn{bottom:max(16px,env(safe-area-inset-bottom));right:max(12px,env(safe-area-inset-right));min-height:44px;touch-action:manipulation}
    #sslt10HostOverlay button{min-height:42px;touch-action:manipulation}
    .s10-content{overscroll-behavior:contain}
    .s10-table-wrap{-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;scrollbar-width:thin}
    @media(max-width:600px){
      #sslt10HostOverlay{padding:0;background:#080b12}
      #sslt10HostPanel{border-radius:0;border:0;min-height:100dvh}
      .s10-top{padding:12px 14px;min-height:56px}
      .s10-brand{font-size:18px}
      .s10-layout{min-height:calc(100dvh - 56px)}
      .s10-nav{position:sticky;top:0;z-index:5;padding:8px;background:#0d1320;-webkit-overflow-scrolling:touch;scroll-snap-type:x proximity}
      .s10-nav button{font-size:12px;padding:10px 13px;min-width:max-content;scroll-snap-align:start}
      .s10-content{padding:12px}
      .s10-title{font-size:21px}
      .s10-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:12px 0}
      .s10-card{padding:12px;border-radius:11px}
      .s10-card .n{font-size:23px}
      .s10-form{grid-template-columns:1fr;gap:9px;padding:11px}
      .s10-form input,.s10-form select{font-size:16px;min-height:44px}
      .s10-toolbar{align-items:stretch}
      .s10-toolbar>input,.s10-toolbar>button,.s10-toolbar>label{width:100%;box-sizing:border-box;min-height:44px}
      .s10-table{min-width:620px}
      .s10-table th,.s10-table td{padding:9px 8px;white-space:nowrap}
      .s10-actions{gap:5px}
      .s10-actions .s10-btn{padding:9px 10px}
      .s10-preview{max-height:35dvh}
    }
    @media(max-width:380px){.s10-grid{grid-template-columns:1fr}.s10-brand{font-size:16px}.s10-close{padding:8px 10px}}
  `;
  document.head.appendChild(style);
  const observer=new MutationObserver(()=>{const overlay=document.getElementById('sslt10HostOverlay');if(!overlay)return;document.body.style.overflow=overlay.style.display==='block'?'hidden':'';});
  observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['style']});
})();