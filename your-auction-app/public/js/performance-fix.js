(() => {
  'use strict';
  const boot = () => {
    if (!window.Anim || typeof window.Anim.staggerIn !== 'function') return false;
    const original = window.Anim.staggerIn;
    if (original.__sslt10PerfWrapped) return true;
    const fast = function(elements, opts) {
      const count = elements?.length || 0;
      // A 12-row team table is rebuilt frequently. Animating every row on
      // every realtime snapshot creates unnecessary layout/paint work.
      if (count >= 8) {
        if (window.gsap) window.gsap.set(elements, { opacity: 1, y: 0, clearProps: 'transform' });
        return;
      }
      return original(elements, opts);
    };
    fast.__sslt10PerfWrapped = true;
    window.Anim.staggerIn = fast;
    return true;
  };
  if (boot()) return;
  const timer = setInterval(() => { if (boot()) clearInterval(timer); }, 50);
  setTimeout(() => clearInterval(timer), 10000);
})();
