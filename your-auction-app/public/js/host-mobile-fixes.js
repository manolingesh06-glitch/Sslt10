(() => {
  const style=document.createElement('style');
  style.id='sslt10-mobile-fixes';
  style.textContent=`
    html,body{max-width:100%;overflow-x:hidden}
    button,input,select,textarea{font:inherit}
    #loginScreen input{font-size:16px}
    #sslt10HostOverlay{padding:max(8px,env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) max(8px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left))}
    #sslt10HostPanel{width:100%;max-width:1180px;min-height:100%;border-radius:14px}
    #sslt10HostBtn{bottom:max(16px,env(safe-area-inset-bottom));right:max(12px,env(safe-area-inset-right));min-height:46px;touch-action:manipulation}
    #sslt10HostOverlay button{min-height:44px;touch-action:manipulation}
    #sslt10HostOverlay input,#sslt10HostOverlay select{min-height:44px}
    .s10-content{overscroll-behavior:contain}
    .s10-table-wrap{-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;scrollbar-width:thin}
    .s10-actions{gap:8px}
    @media(max-width:600px){
      #sslt10HostOverlay{padding:0;background:#080b12}
      #sslt10HostPanel{border-radius:0;border:0;min-height:100dvh}
      .s10-top{padding:10px 12px;min-height:56px;position:sticky;top:0;z-index:20}
      .s10-brand{font-size:18px}
      .s10-layout{display:block;min-height:calc(100dvh - 56px)}
      .s10-nav{position:sticky;top:56px;z-index:19;padding:7px;background:#0d1320;border-right:0;border-bottom:1px solid #2a3448;display:flex;overflow-x:auto;gap:6px;-webkit-overflow-scrolling:touch;scroll-snap-type:x proximity}
      .s10-nav button{font-size:12px;padding:10px 13px;min-width:max-content;scroll-snap-align:start;margin:0;min-height:42px}
      .s10-content{padding:10px}
      .s10-title{font-size:21px}
      .s10-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0}
      .s10-card{padding:12px;border-radius:11px}
      .s10-card .n{font-size:23px}
      .s10-form{grid-template-columns:1fr;gap:9px;padding:11px;margin:10px 0}
      .s10-form input,.s10-form select{font-size:16px;min-height:46px}
      .s10-toolbar{align-items:stretch;gap:8px}
      .s10-toolbar>input,.s10-toolbar>button,.s10-toolbar>label{width:100%;box-sizing:border-box;min-height:46px}
      .s10-table-wrap{border:0;overflow:visible}
      .s10-table{width:100%;min-width:0;border-collapse:separate;border-spacing:0 8px}
      .s10-table thead{display:none}
      .s10-table tbody,.s10-table tr,.s10-table td{display:block;width:100%;box-sizing:border-box}
      .s10-table tr{background:#171f2e;border:1px solid #2a3448;border-radius:12px;padding:10px;margin-bottom:8px}
      .s10-table td{border:0;padding:4px 0;white-space:normal;display:flex;justify-content:space-between;gap:12px;font-size:13px}
      .s10-table td::before{color:#9ba7b8;font-size:10px;text-transform:uppercase;letter-spacing:.4px;font-weight:700}
      .s10-table td:nth-child(1)::before{content:'Team'}
      .s10-table td:nth-child(2)::before{content:'Short'}
      .s10-table td:nth-child(3)::before{content:'Owner'}
      .s10-table td:nth-child(4)::before{content:'Budget'}
      .s10-table td:nth-child(5)::before{content:'Squad'}
      .s10-table td:nth-child(6)::before{content:'Actions'}
      .s10-table td:last-child{justify-content:flex-end;padding-top:8px}
      .s10-table .s10-actions{justify-content:flex-end}
      .s10-actions .s10-btn{padding:10px 12px;min-height:44px}
      .s10-preview{max-height:35dvh;overflow:auto}
      .s10-setup-banner{font-size:13px}
    }
    @media(max-width:380px){.s10-grid{grid-template-columns:1fr}.s10-brand{font-size:16px}.s10-close{padding:8px 10px}}
  `;
  document.head.appendChild(style);
  const observer=new MutationObserver(()=>{const overlay=document.getElementById('sslt10HostOverlay');if(!overlay)return;document.body.style.overflow=overlay.style.display==='block'?'hidden':'';});
  observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['style']});
})();
