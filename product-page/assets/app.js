/* Meeting Note — landing page interactions
   Vanilla JS, no dependencies. Progressive: page is fully readable without it. */
(function () {
  'use strict';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Theme follows the OS setting automatically (see prefers-color-scheme
     in assets/tokens.css) — no in-page toggle. */

  /* ---------- Sticky header state + scroll progress ---------- */
  var header = document.getElementById('header');
  var progress = document.getElementById('progress');
  function onScroll() {
    var y = window.scrollY || window.pageYOffset;
    if (header) header.classList.toggle('scrolled', y > 8);
    if (progress) {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.width = (h > 0 ? (y / h) * 100 : 0) + '%';
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- Scroll reveal ---------- */
  var reveals = [].slice.call(document.querySelectorAll('.reveal'));
  if (reduce || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.14, rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Stepper: scroll drives the active step; hover previews it ---------- */
  var steps = [].slice.call(document.querySelectorAll('.step[data-step]'));
  var visuals = [].slice.call(document.querySelectorAll('.step-visual[data-step]'));
  var scrollStep = '0';   // step chosen by scroll position
  var hovering = false;   // true while a step is hovered/focused
  function render(idx) {
    steps.forEach(function (s) { s.classList.toggle('is-active', s.getAttribute('data-step') === String(idx)); });
    visuals.forEach(function (v) { v.classList.toggle('is-active', v.getAttribute('data-step') === String(idx)); });
  }
  if (steps.length && 'IntersectionObserver' in window) {
    var stepIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          scrollStep = entry.target.getAttribute('data-step');
          if (!hovering) render(scrollStep);   // don't fight an active hover
        }
      });
    }, { threshold: 0.6, rootMargin: '-20% 0px -30% 0px' });
    steps.forEach(function (s) { stepIo.observe(s); });
  }
  // Hover (and keyboard focus) previews a step; leaving restores the scroll step.
  // Uses event delegation on the list container (mouseover/out + focusin/out all
  // bubble), which is more robust than per-element mouseenter listeners.
  steps.forEach(function (s) { s.setAttribute('tabindex', '0'); });
  var stepList = document.getElementById('stepList');
  if (stepList) {
    var previewFrom = function (e) {
      var s = e.target.closest ? e.target.closest('.step[data-step]') : null;
      if (s) { hovering = true; render(s.getAttribute('data-step')); }
    };
    var restore = function () { hovering = false; render(scrollStep); };
    stepList.addEventListener('mouseover', previewFrom);
    stepList.addEventListener('mouseleave', restore);
    stepList.addEventListener('focusin', previewFrom);
    stepList.addEventListener('focusout', restore);
  }

  /* ---------- FAQ accordion (animated height, single-open) ---------- */
  var faq = document.getElementById('faq-list');
  if (faq) {
    var items = [].slice.call(faq.querySelectorAll('.faq-item'));
    items.forEach(function (item) {
      var btn = item.querySelector('.faq-q');
      var panel = item.querySelector('.faq-a');
      btn.addEventListener('click', function () {
        var isOpen = item.classList.contains('open');
        // close others
        items.forEach(function (other) {
          if (other !== item && other.classList.contains('open')) {
            other.classList.remove('open');
            other.querySelector('.faq-q').setAttribute('aria-expanded', 'false');
            other.querySelector('.faq-a').style.height = '0px';
          }
        });
        if (isOpen) {
          item.classList.remove('open');
          btn.setAttribute('aria-expanded', 'false');
          panel.style.height = '0px';
        } else {
          item.classList.add('open');
          btn.setAttribute('aria-expanded', 'true');
          panel.style.height = panel.firstElementChild.offsetHeight + 'px';
        }
      });
    });
    // keep an open panel sized correctly on resize
    window.addEventListener('resize', function () {
      var open = faq.querySelector('.faq-item.open .faq-a');
      if (open) open.style.height = open.firstElementChild.offsetHeight + 'px';
    });
  }

  /* ---------- Mobile nav: jump to sections (simple anchor list reveal) ---------- */
  var navToggle = document.getElementById('navToggle');
  if (navToggle) {
    navToggle.addEventListener('click', function () {
      var el = document.getElementById('how');
      if (el) el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
    });
  }
})();
