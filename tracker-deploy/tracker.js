/* D2RM Analytics tracker snippet.
 * Include: <script src="https://muse4.pythonanywhere.com/tracker.js" data-site="faithshield" async></script>
 * Sends pageview on load, duration/engagement on pagehide, and optional custom events.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  var COLLECT_URL = (script && script.getAttribute("data-endpoint")) || "/collect";
  try {
    COLLECT_URL = new URL(COLLECT_URL, script ? script.src : location.href).toString();
  } catch (e) { /* keep as-is */ }
  var SITE = (script && script.getAttribute("data-site")) || "";

  function getSid() {
    try {
      var s = sessionStorage.getItem("d2rm_sid");
      if (!s) {
        s = Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem("d2rm_sid", s);
      }
      return s;
    } catch (e) { return "cookie-less"; }
  }
  var SID = getSid();
  var START = Date.now();
  var ENGAGED = false;
  ["click", "scroll", "keydown", "touchstart"].forEach(function (ev) {
    window.addEventListener(ev, function () { ENGAGED = true; }, { passive: true });
  });

  function device() {
    var w = window.innerWidth || 0;
    return w < 768 ? "mobile" : (w < 1100 ? "tablet" : "desktop");
  }
  function browser() {
    var ua = navigator.userAgent || "";
    if (/Edg\//.test(ua)) return "edge";
    if (/Chrome\//.test(ua)) return "chrome";
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "safari";
    if (/Firefox\//.test(ua)) return "firefox";
    return "other";
  }
  function osName() {
    var ua = navigator.userAgent || "";
    if (/Windows/.test(ua)) return "windows";
    if (/Mac OS/.test(ua)) return "macos";
    if (/Android/.test(ua)) return "android";
    if (/iPhone|iPad|iPod/.test(ua)) return "ios";
    if (/Linux/.test(ua)) return "linux";
    return "other";
  }
  function utm(name) {
    try {
      var m = location.search.match(new RegExp("[?&]" + name + "=([^&]*)"));
      return m ? decodeURIComponent(m[1]).slice(0, 100) : "";
    } catch (e) { return ""; }
  }
  function send(type, extra) {
    var payload = {
      site: SITE, type: type, sid: SID, ts: Date.now(),
      page: location.pathname + location.search,
      title: document.title || "",
      referrer: document.referrer || "",
      device: device(), browser: browser(), os: osName(),
      screen: (window.screen ? window.screen.width + "x" + window.screen.height : ""),
      lang: (navigator.language || "").slice(0, 10),
      utm_source: utm("utm_source"), utm_medium: utm("utm_medium"),
      utm_campaign: utm("utm_campaign"), utm_term: utm("utm_term"),
      utm_content: utm("utm_content")
    };
    if (extra) for (var k in extra) payload[k] = extra[k];
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(COLLECT_URL, new Blob([body], { type: "application/json" }));
      } else {
        fetch(COLLECT_URL, { method: "POST", headers: { "Content-Type": "application/json" },
          body: body, keepalive: true, mode: "cors" });
      }
    } catch (e) { /* analytics must never break the page */ }
  }

  if (document.readyState === "complete") send("pageview");
  else window.addEventListener("load", function () { send("pageview"); });

  function onHide() {
    send("unload", { duration: Math.round((Date.now() - START) / 1000), engaged: ENGAGED ? 1 : 0 });
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") onHide();
  });
  window.addEventListener("pagehide", onHide);

  window.d2rmTrack = function (name) { send("event", { event_name: String(name || "").slice(0, 60) }); };
  document.addEventListener("click", function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest("[data-track]") : null;
    if (el) window.d2rmTrack(el.getAttribute("data-track"));
  });
})();
