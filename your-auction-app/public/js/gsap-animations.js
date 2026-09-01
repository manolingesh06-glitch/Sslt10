/* ============================================================
   PREMIUM GSAP ANIMATION LAYER — additive only.
   ------------------------------------------------------------
   This file does not change any auction, bidding, timer, auth,
   Socket.IO, or state logic. It only:
     1) defines a small reusable animation toolkit (window.Anim), and
     2) wires that toolkit onto the EXISTING app by wrapping already-
        defined global functions (renderPlayer, fireConfetti, etc.)
        and by watching the DOM for the same show/hide changes the
        app already makes (modals, screens).
   It is loaded last (after app.js / voice.js / admin.js), so every
   function it wraps already exists. If GSAP failed to load, or a
   hook target doesn't exist, everything here quietly no-ops and the
   app behaves exactly as it did before this file existed.
   ============================================================ */
(function(){
  'use strict';
  if(typeof window.gsap === 'undefined'){ return; } // no GSAP -> app works exactly as before

  var gsap = window.gsap;

  /* ---------------- reduced motion ---------------- */
  var mql = window.matchMedia('(prefers-reduced-motion: reduce)');
  var REDUCE = mql.matches;
  try{ mql.addEventListener('change', function(e){ REDUCE = e.matches; }); }catch(e){}

  /* ============================================================
     1) REUSABLE ANIMATION TOOLKIT — window.Anim
     ============================================================ */
  var Anim = {};

  Anim.fadeIn = function(el, opts){
    if(!el) return;
    opts = opts || {};
    if(REDUCE){ gsap.set(el, {opacity:1, y:0, clearProps:'transform'}); return; }
    gsap.fromTo(el,
      {opacity:0, y: opts.y != null ? opts.y : 14},
      {opacity:1, y:0, duration: opts.duration || 0.45, ease: opts.ease || 'power3.out', delay: opts.delay || 0}
    );
  };

  Anim.scaleIn = function(el, opts){
    if(!el) return;
    opts = opts || {};
    if(REDUCE){ gsap.set(el, {opacity:1, scale:1, clearProps:'transform'}); return; }
    gsap.fromTo(el,
      {opacity:0, scale: opts.scale != null ? opts.scale : 0.94},
      {opacity:1, scale:1, duration: opts.duration || 0.35, ease: opts.ease || 'back.out(1.6)', delay: opts.delay || 0}
    );
  };

  // Cards appearing together: important ones first, secondary ones after.
  Anim.staggerIn = function(elements, opts){
    if(!elements || !elements.length) return;
    opts = opts || {};
    if(REDUCE){ gsap.set(elements, {opacity:1, y:0, clearProps:'transform'}); return; }
    gsap.fromTo(elements,
      {opacity:0, y: opts.y != null ? opts.y : 16},
      {opacity:1, y:0, duration: opts.duration || 0.5, ease: opts.ease || 'power3.out',
       stagger: opts.stagger != null ? opts.stagger : 0.06, delay: opts.delay || 0}
    );
  };

  // Whole-screen entrance: container fades in + rises slightly, its direct
  // "card" children stagger in just after. (Spec: page load behaviour.)
  Anim.pageIn = function(container, opts){
    if(!container) return;
    opts = opts || {};
    var cards = opts.cardSelector ? container.querySelectorAll(opts.cardSelector) : [];
    if(REDUCE){
      gsap.set(container, {opacity:1, y:0, clearProps:'transform'});
      if(cards.length) gsap.set(cards, {opacity:1, y:0, clearProps:'transform'});
      return;
    }
    var tl = gsap.timeline();
    tl.fromTo(container, {opacity:0, y:18}, {opacity:1, y:0, duration:0.5, ease:'power3.out'});
    if(cards.length){
      tl.fromTo(cards, {opacity:0, y:16}, {opacity:1, y:0, duration:0.45, ease:'power3.out', stagger:0.06}, '-=0.25');
    }
    return tl;
  };

  // A number/value changing (bid amount, price) — quick emphasis pop.
  Anim.pop = function(el, opts){
    if(!el) return;
    opts = opts || {};
    if(REDUCE) return;
    gsap.fromTo(el,
      {scale: opts.scale != null ? opts.scale : 1.16, color: opts.color},
      {scale:1, duration: opts.duration || 0.32, ease:'back.out(2.2)', clearProps:'transform'}
    );
  };

  // Momentary highlight glow (e.g. the row that just took the lead).
  Anim.flash = function(el, color){
    if(!el || REDUCE) return;
    var prevBg = el.style.backgroundColor;
    gsap.fromTo(el,
      {backgroundColor: color || 'rgba(255,200,74,0.28)'},
      {backgroundColor: prevBg || 'rgba(255,200,74,0)', duration:0.9, ease:'power2.out',
       onComplete: function(){ el.style.backgroundColor = prevBg; }}
    );
  };

  Anim.buttonPress = function(el){
    if(!el || REDUCE) return null;
    return gsap.to(el, {scale:0.96, duration:0.08, ease:'power1.out'});
  };
  Anim.buttonRelease = function(el){
    if(!el || REDUCE) return null;
    return gsap.to(el, {scale:1, duration:0.18, ease:'back.out(2.5)'});
  };

  // Modal / overlay open + close (used by the generic observer below).
  Anim.modalOpen = function(overlay, box){
    if(REDUCE){ gsap.set(overlay, {opacity:1}); if(box) gsap.set(box, {opacity:1, y:0, scale:1, clearProps:'transform'}); return; }
    gsap.killTweensOf([overlay, box]);
    gsap.fromTo(overlay, {opacity:0}, {opacity:1, duration:0.18, ease:'power2.out'});
    if(box) gsap.fromTo(box, {opacity:0, y:16, scale:0.96}, {opacity:1, y:0, scale:1, duration:0.3, ease:'power3.out', delay:0.02});
  };
  Anim.modalClose = function(overlay, box, onDone){
    if(REDUCE){ onDone && onDone(); return; }
    gsap.killTweensOf([overlay, box]);
    if(box) gsap.to(box, {opacity:0, y:10, scale:0.97, duration:0.16, ease:'power2.in'});
    gsap.to(overlay, {opacity:0, duration:0.18, ease:'power2.in', delay:0.02, onComplete:onDone});
  };

  window.Anim = Anim;

  /* ============================================================
     2) SOFT WRAP HELPER — wraps a global fn without changing what
     it does or returns; the original always runs untouched.
     ============================================================ */
  function wrap(name, after, before){
    var orig = window[name];
    if(typeof orig !== 'function') return; // target not present -> skip safely
    window[name] = function(){
      if(before){ try{ before.apply(this, arguments); }catch(e){} }
      var result = orig.apply(this, arguments);
      try{ after && after.apply(this, arguments); }catch(e){}
      return result;
    };
  }

  /* ============================================================
     3) GENERIC "SHOW/HIDE" WATCHERS — modals + full screens.
        These observe the exact same style/class flips the app
        already performs; nothing about how the app shows or hides
        things is changed.
     ============================================================ */
  function watchModalOverlays(){
    var overlays = document.querySelectorAll('[id$="ModalOverlay"]');
    overlays.forEach(function(el){
      if(el._animWired) return;
      el._animWired = true;
      var shown = getComputedStyle(el).display !== 'none';
      var closing = false;
      var mo = new MutationObserver(function(){
        if(closing) return;
        var disp = el.style.display;
        var box = el.querySelector('.modal-box');
        if(disp === 'flex' && !shown){
          shown = true;
          Anim.modalOpen(el, box);
        } else if(disp === 'none' && shown){
          shown = false;
          closing = true;
          el.style.display = 'flex'; // hold the frame open so we can animate the exit
          Anim.modalClose(el, box, function(){
            el.style.display = 'none';
            gsap.set(el, {clearProps:'opacity'});
            if(box) gsap.set(box, {clearProps:'opacity,transform'});
            closing = false;
          });
        }
      });
      mo.observe(el, {attributes:true, attributeFilter:['style']});
    });
  }

  // Full screens toggled either via style.display ('' / 'none') or a
  // 'hidden' class. Animates the transition in either direction the
  // app already uses, without altering which one it picks.
  function watchScreen(id, opts){
    var el = document.getElementById(id);
    if(!el || el._animWired) return;
    el._animWired = true;
    opts = opts || {};
    var isVisible = function(){ return getComputedStyle(el).display !== 'none'; };
    var shown = isVisible();
    var mo = new MutationObserver(function(){
      var nowShown = isVisible();
      if(nowShown && !shown){
        shown = true;
        Anim.pageIn(el, {cardSelector: opts.cardSelector});
      } else if(!nowShown){
        shown = false;
      }
    });
    mo.observe(el, {attributes:true, attributeFilter:['style','class']});
  }

  function initWatchers(){
    watchModalOverlays();
    watchScreen('mainApp', {cardSelector: ':scope > .grid > .card, :scope > .card, .grid > .card'});
    watchScreen('adminScreen');
    watchScreen('adminDashboard', {cardSelector: '.admin-card, .card'});
    watchScreen('adminAuthBox');
  }

  /* ============================================================
     4) HOOKS INTO THE EXISTING APP (app.js) — additive wraps.
        Every function named below already exists in app.js; we
        only add an animation call after it does its real work.
     ============================================================ */

  // --- Player card: badges / prices / status stagger in on a genuinely
  // new player (mirrors the same "isNewPlayer" check app.js already does
  // for its own name-letter animation, so we never re-trigger this on a
  // same-player re-render like a bid update).
  var lastAnimPlayerNo = null;
  wrap('renderPlayer', function(){
    if(typeof currentPlayer !== 'function') return;
    var p = currentPlayer();
    var no = p ? p['Auction #'] : null;
    if(no === lastAnimPlayerNo) return; // same player -> no re-entrance
    lastAnimPlayerNo = no;
    var targets = [
      document.getElementById('playerBadges'),
      document.getElementById('basePrice') && document.getElementById('basePrice').closest('.price-block'),
      document.getElementById('currentPriceDisplay') && document.getElementById('currentPriceDisplay').closest('.price-block'),
      document.getElementById('statusArea')
    ].filter(Boolean);
    Anim.staggerIn(targets, {y:10, duration:0.4, stagger:0.07, delay:0.1});
  });

  // --- Bid updates: pop the amount, glow the "highest bidder" line. This
  // runs on every bid, so it's intentionally tiny and cheap.
  var lastLiveAmt = null, lastOwnerAmt = null;
  wrap('renderLiveBid', function(){
    var liveAmt = document.getElementById('liveBidAmt');
    if(liveAmt && liveAmt.textContent !== lastLiveAmt){
      lastLiveAmt = liveAmt.textContent;
      Anim.pop(liveAmt);
    }
    var ownerAmt = document.getElementById('ownerBidAmt');
    if(ownerAmt && ownerAmt.textContent !== lastOwnerAmt){
      lastOwnerAmt = ownerAmt.textContent;
      Anim.pop(ownerAmt);
    }
    var liveWho = document.getElementById('liveBidWho');
    if(liveWho) Anim.fadeIn(liveWho, {y:4, duration:0.25});
  });

  // --- Cheap per-bid path: flash whichever row just took the lead.
  wrap('updateLeadingTeamRow', function(){
    var row = document.querySelector('#teamTableBody tr.team-row-leading');
    if(row) Anim.flash(row);
  });

  // --- Team table rebuild (player changes / sold / unsold) — stagger the
  // rows in. This is the "occasional structural rebuild" path, not the
  // per-bid path above, so a fuller stagger here stays premium, not noisy.
  wrap('renderTeamTable', function(){
    var rows = document.querySelectorAll('#teamTableBody tr.team-row');
    Anim.staggerIn(rows, {y:10, duration:0.4, stagger:0.025});
  });
  wrap('renderAuctionSummary', function(){
    var rows = document.querySelectorAll('#auctionSummaryList .summary-row');
    Anim.staggerIn(rows, {y:10, duration:0.35, stagger:0.03});
  });

  // --- SOLD: subtle premium emphasis on the player card + status pill,
  // layered on top of (not replacing) the existing confetti/sound.
  wrap('fireConfetti', function(){
    var card = document.querySelector('.player-card');
    if(card && !REDUCE){
      gsap.fromTo(card, {scale:1}, {scale:1.015, duration:0.18, ease:'power2.out', yoyo:true, repeat:1});
    }
    // statusArea's SOLD pill is written just after fireConfetti() is called,
    // so give it a moment to land in the DOM before popping it in.
    setTimeout(function(){
      var pill = document.querySelector('#statusArea .status-pill.sold');
      if(pill) Anim.scaleIn(pill, {duration:0.4});
    }, 30);
  });

  // --- UNSOLD: quieter transition than SOLD, per spec.
  wrap('fireUnsoldShake', function(){
    setTimeout(function(){
      var pill = document.querySelector('#statusArea .status-pill.unsold');
      if(pill) Anim.fadeIn(pill, {y:6, duration:0.3});
    }, 30);
  });

  // --- Whole app entrance, once login succeeds and the auction room mounts.
  wrap('enterApp', function(){
    var app = document.getElementById('mainApp');
    if(app) Anim.pageIn(app, {cardSelector: '.card:not(.hidden)'});
  });

  /* ============================================================
     5) BUTTON MICRO-INTERACTIONS (event delegation — no markup
        changes, works for buttons rendered now or later).
     ============================================================ */
  var PRESS_SELECTOR = '.act, .qbid, .view-squad-btn, .btn-nav, .tab';
  document.addEventListener('pointerdown', function(e){
    var btn = e.target.closest && e.target.closest(PRESS_SELECTOR);
    if(btn) Anim.buttonPress(btn);
  });
  ['pointerup','pointerleave','pointercancel'].forEach(function(evt){
    document.addEventListener(evt, function(e){
      var btn = e.target.closest && e.target.closest(PRESS_SELECTOR);
      if(btn) Anim.buttonRelease(btn);
    });
  });

  /* ============================================================
     6) INITIAL PAGE LOAD — animate whichever screen is actually
        showing once the app has had a moment to decide (session
        restore may switch straight to the auction room).
     ============================================================ */
  function animateInitialScreen(){
    var login = document.getElementById('loginScreen');
    var app = document.getElementById('mainApp');
    if(app && getComputedStyle(app).display !== 'none'){
      Anim.pageIn(app, {cardSelector: '.card:not(.hidden)'});
    } else if(login && getComputedStyle(login).display !== 'none'){
      var box = login.querySelector('.login-box');
      if(box){
        Anim.fadeIn(box, {y:18, duration:0.55});
        var fields = box.querySelectorAll('.login-field, .login-btn, .admin-toggle-link');
        Anim.staggerIn(fields, {y:10, duration:0.35, stagger:0.06, delay:0.12});
      }
    }
  }

  function boot(){
    initWatchers();
    // small delay so app.js's own async init()/enterApp() has had a chance
    // to decide which screen is actually visible first.
    setTimeout(animateInitialScreen, 60);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
