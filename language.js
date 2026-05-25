<script>
  // Global configurations & state
  const BACKEND_URL = window.location.origin; // Same-origin worker routing config
  const API_CACHE = {};
  
  // Custom Jikan Client implementation featuring debouncing & caching for high stability
  async function fetchJikan(endpoint) {
    if (API_CACHE[endpoint]) return API_CACHE[endpoint];
    let retries = 3;
    let delay = 1000;
    
    while (retries > 0) {
      try {
        const response = await fetch(`https://api.jikan.moe/v4/${endpoint}`);
        if (response.status === 429) { // Rate limit handler
          throw new Error("Rate limit exceeded.");
        }
        if (!response.ok) throw new Error("HTTP failure loading resources.");
        const data = await response.json();
        API_CACHE[endpoint] = data;
        return data;
      } catch (err) {
        retries--;
        if (retries === 0) {
          console.error(`Jikan execution failure on /${endpoint}`, err);
          return null;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff scaling
      }
    }
  }

  // Auth helper methods
  function getSessionToken() {
    return localStorage.getItem("anime_session_token");
  }

  function getUser() {
    const user = localStorage.getItem("anime_user");
    return user ? JSON.parse(user) : null;
  }

  function saveSession(token, user) {
    localStorage.setItem("anime_session_token", token);
    localStorage.setItem("anime_user", JSON.stringify(user));
  }

  function clearSession() {
    localStorage.removeItem("anime_session_token");
    localStorage.removeItem("anime_user");
    window.location.reload();
  }

  // Intercept requests for auth integrations
  async function fetchWithAuth(endpoint, options = {}) {
    const token = getSessionToken();
    const headers = {
      "Content-Type": "application/json",
      ...options.headers,
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return fetch(`${BACKEND_URL}${endpoint}`, { ...options, headers });
  }

  // Global Dynamic Search Handler UI/Overlay Toggle engine
  function toggleSearchOverlay() {
    const searchOverlay = document.getElementById("search-overlay");
    if (!searchOverlay) return;
    
    if (searchOverlay.classList.contains("active")) {
      searchOverlay.classList.remove("active");
      document.body.style.overflow = "auto";
    } else {
      searchOverlay.classList.add("active");
      document.body.style.overflow = "hidden";
      const searchInput = searchOverlay.querySelector("input");
      if (searchInput) searchInput.focus();
    }
  }

  // Listen to ESC to gracefully close overlays
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const activeOverlays = document.querySelectorAll(".overlay-active, .active");
      activeOverlays.forEach(o => o.classList.remove("active", "overlay-active"));
      document.body.style.overflow = "auto";
    }
  });

  // Multilingual System Implementation
  const translations = {
    EN: { home: "Home", trending: "Trending", schedule: "Schedule", azList: "A-Z List", genres: "Genres" },
    JP: { home: "ホーム", trending: "急上昇", schedule: "放送予定", azList: "五十音順", genres: "ジャンル" },
    BN: { home: "হোম", trending: "ট্রেন্ডিং", schedule: "সময়সূচী", azList: "তালিকা", genres: "বিভাগ" }
  };

  function setLanguage(lang) {
    localStorage.setItem("anime_lang", lang);
    applyLocalization(lang);
  }

  function applyLocalization(lang) {
    const dict = translations[lang] || translations.EN;
    const elements = document.querySelectorAll("[data-translate]");
    elements.forEach(el => {
      const key = el.getAttribute("data-translate");
      if (dict[key]) el.textContent = dict[key];
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const selectedLang = localStorage.getItem("anime_lang") || "EN";
    applyLocalization(selectedLang);
  });
</script>
