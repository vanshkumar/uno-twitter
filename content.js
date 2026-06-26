(() => {
  "use strict";

  const TWEET_SELECTOR = 'article[data-testid="tweet"]';
  const CONTROLS_ATTR = "data-uno-twitter-controls";
  const HIDDEN_CLASS = "uno-twitter-hidden-tweet";
  const CURRENT_CLASS = "uno-twitter-current-tweet";
  const DISCOVER_MORE_CLASS = "uno-twitter-hidden-discover-more";
  const DISCOVER_MORE_TEXT = "discover more";
  const DEFAULT_ENABLED = true;
  const LOAD_MORE_TIMEOUT_MS = 9000;
  const LOAD_MORE_RETRY_MS = 450;

  const nodeKeys = new WeakMap();
  let nextNodeKey = 1;
  let controls = null;
  let observer = null;
  let enabled = false;
  let storageReady = false;
  let currentArticle = null;
  let currentKey = null;
  let currentIndex = 0;
  let knownTweets = new Set();
  let knownDiscoverMoreElements = new Set();
  let pendingNext = false;
  let pendingNextDeadline = 0;
  let pendingNextTimer = 0;
  let renderQueued = false;
  let shouldChooseVisibleTweet = true;
  let lastLocation = location.href;

  function init() {
    ensureControls();
    installMutationObserver();
    installStorageListener();
    document.addEventListener("keydown", handleKeyDown, true);
    readEnabledPreference();
  }

  function ensureControls() {
    if (controls || !document.body) {
      return;
    }

    controls = document.createElement("div");
    controls.className = "uno-twitter-controls";
    controls.setAttribute(CONTROLS_ATTR, "true");
    controls.hidden = true;
    controls.innerHTML = `
      <button type="button" data-uno-twitter-action="previous">Previous</button>
      <button type="button" data-uno-twitter-action="next">Next</button>
      <span class="uno-twitter-count" aria-live="polite">0 / 0</span>
    `;
    controls.addEventListener("click", handleControlsClick);
    document.body.appendChild(controls);
  }

  function readEnabledPreference() {
    if (!hasChromeStorage()) {
      applyEnabledPreference(DEFAULT_ENABLED);
      return;
    }

    chrome.storage.local.get({ enabled: DEFAULT_ENABLED }, (items) => {
      applyEnabledPreference(Boolean(items.enabled));
    });
  }

  function installStorageListener() {
    if (!hasChromeStorage()) {
      return;
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && Object.prototype.hasOwnProperty.call(changes, "enabled")) {
        applyEnabledPreference(Boolean(changes.enabled.newValue));
      }
    });
  }

  function hasChromeStorage() {
    return typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local &&
      chrome.storage.onChanged;
  }

  function applyEnabledPreference(nextEnabled) {
    storageReady = true;

    if (enabled === nextEnabled) {
      queueRender({ chooseVisibleTweet: true });
      return;
    }

    enabled = nextEnabled;
    currentArticle = null;
    currentKey = null;
    currentIndex = 0;
    clearPendingNext();
    clearTweetClasses();
    queueRender({ chooseVisibleTweet: true });
  }

  function installMutationObserver() {
    if (observer) {
      return;
    }

    observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesTweets)) {
        queueRender();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function mutationTouchesTweets(mutation) {
    for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
      if (!(node instanceof Element)) {
        continue;
      }

      if (
        node.matches(TWEET_SELECTOR) ||
        node.querySelector(TWEET_SELECTOR) ||
        nodeContainsDiscoverMoreMarker(node)
      ) {
        return true;
      }
    }

    return false;
  }

  function queueRender(options = {}) {
    shouldChooseVisibleTweet = shouldChooseVisibleTweet || Boolean(options.chooseVisibleTweet);

    if (renderQueued) {
      return;
    }

    renderQueued = true;
    requestAnimationFrame(render);
  }

  function render() {
    renderQueued = false;
    ensureControls();

    const routeChanged = handleRouteChange();
    updateDiscoverMoreVisibility();
    const tweets = getTweetArticles();
    const modeActive = isModeActive();
    releaseTweetsNoLongerPresent(tweets);
    knownTweets = new Set(tweets);

    if (!modeActive) {
      clearPendingNext();
      clearTweetClasses(tweets);
      updateControls(tweets);
      return;
    }

    if (!tweets.length) {
      currentArticle = null;
      currentKey = null;
      currentIndex = 0;
      updateControls(tweets);
      return;
    }

    if (pendingNext && tryCompletePendingNext(tweets)) {
      return;
    }

    const chooseVisible = shouldChooseVisibleTweet || routeChanged;
    shouldChooseVisibleTweet = false;

    let nextIndex = chooseVisible ? findVisibleTweetIndex(tweets) : findCurrentTweetIndex(tweets);
    if (nextIndex < 0) {
      nextIndex = clamp(currentIndex, 0, tweets.length - 1);
    }

    setCurrentTweet(tweets, nextIndex);
    updateControls(tweets);
  }

  function handleRouteChange() {
    if (location.href === lastLocation) {
      return false;
    }

    lastLocation = location.href;
    currentArticle = null;
    currentKey = null;
    currentIndex = 0;
    shouldChooseVisibleTweet = true;
    clearPendingNext();
    clearTweetClasses();
    clearDiscoverMoreElements();
    return true;
  }

  function isModeActive() {
    return storageReady &&
      enabled &&
      !isTweetDetailPage() &&
      !isNotificationsPage() &&
      !isProfilePage();
  }

  function isTweetDetailPage() {
    return /\/status(?:es)?\/\d+/.test(location.pathname);
  }

  function isNotificationsPage() {
    return /^\/(?:i\/)?notifications(?:\/|$)/.test(location.pathname);
  }

  function isProfilePage() {
    const segments = location.pathname
      .split("/")
      .filter(Boolean);
    const reservedRoutes = new Set([
      "compose",
      "explore",
      "home",
      "i",
      "jobs",
      "messages",
      "notifications",
      "search",
      "settings"
    ]);
    const profileTabs = new Set([
      "",
      "articles",
      "highlights",
      "likes",
      "media",
      "with_replies"
    ]);

    if (!segments.length || reservedRoutes.has(segments[0])) {
      return false;
    }

    return segments.length === 1 || (segments.length === 2 && profileTabs.has(segments[1]));
  }

  function updateDiscoverMoreVisibility() {
    if (!isTweetDetailPage()) {
      clearDiscoverMoreElements();
      return;
    }

    const elements = findDiscoverMoreElements();
    const currentElements = new Set(elements);

    for (const element of knownDiscoverMoreElements) {
      if (!currentElements.has(element)) {
        element.classList.remove(DISCOVER_MORE_CLASS);
        element.removeAttribute("aria-hidden");
      }
    }

    knownDiscoverMoreElements = currentElements;

    for (const element of elements) {
      element.classList.add(DISCOVER_MORE_CLASS);
      element.setAttribute("aria-hidden", "true");
    }
  }

  function clearDiscoverMoreElements() {
    for (const element of knownDiscoverMoreElements) {
      element.classList.remove(DISCOVER_MORE_CLASS);
      element.removeAttribute("aria-hidden");
    }

    knownDiscoverMoreElements = new Set();
  }

  function findDiscoverMoreElements() {
    const root = getFeedRoot();
    const elements = new Set();

    for (const marker of findDiscoverMoreMarkers(root)) {
      const section = findDiscoverMoreSection(marker, root);

      if (section) {
        elements.add(section);
        continue;
      }

      for (const element of findDiscoverMoreSiblingElements(marker, root)) {
        elements.add(element);
      }
    }

    return [...elements];
  }

  function findDiscoverMoreMarkers(root) {
    return [...root.querySelectorAll('[role="heading"], h1, h2, h3, span')].filter((element) => {
      return normalizeText(element.textContent) === DISCOVER_MORE_TEXT && !element.closest(TWEET_SELECTOR);
    });
  }

  function findDiscoverMoreSection(marker, root) {
    for (let element = marker; element && element !== root; element = element.parentElement) {
      if (
        element.querySelector(TWEET_SELECTOR) &&
        normalizeText(element.textContent).startsWith(DISCOVER_MORE_TEXT)
      ) {
        return element;
      }
    }

    return null;
  }

  function findDiscoverMoreSiblingElements(marker, root) {
    for (let element = marker; element && element !== root; element = element.parentElement) {
      const parent = element.parentElement;

      if (!parent) {
        continue;
      }

      const siblings = [...parent.children];
      const startIndex = siblings.indexOf(element);
      const followingSiblings = siblings.slice(startIndex + 1);
      const hasFollowingTweet = followingSiblings.some((sibling) => {
        return sibling.matches(TWEET_SELECTOR) || sibling.querySelector(TWEET_SELECTOR);
      });

      if (hasFollowingTweet) {
        return siblings.slice(startIndex);
      }
    }

    return [marker];
  }

  function nodeContainsDiscoverMoreMarker(node) {
    return normalizeText(node.textContent).includes(DISCOVER_MORE_TEXT);
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function getTweetArticles() {
    return [...getFeedRoot().querySelectorAll(TWEET_SELECTOR)].filter((article) => {
      return article.isConnected && !article.closest(`[${CONTROLS_ATTR}]`);
    });
  }

  function getFeedRoot() {
    return document.querySelector('main[role="main"]') ||
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document;
  }

  function releaseTweetsNoLongerPresent(tweets) {
    const presentTweets = new Set(tweets);

    for (const article of knownTweets) {
      if (!presentTweets.has(article)) {
        article.classList.remove(HIDDEN_CLASS, CURRENT_CLASS);
        article.removeAttribute("aria-hidden");
      }
    }
  }

  function clearTweetClasses(tweets = getTweetArticles()) {
    const articles = new Set([...knownTweets, ...tweets]);

    for (const article of articles) {
      article.classList.remove(HIDDEN_CLASS, CURRENT_CLASS);
      article.removeAttribute("aria-hidden");
    }
  }

  function findCurrentTweetIndex(tweets) {
    if (currentArticle && tweets.includes(currentArticle)) {
      return tweets.indexOf(currentArticle);
    }

    if (currentKey) {
      const indexByKey = tweets.findIndex((article) => getTweetKey(article) === currentKey);
      if (indexByKey >= 0) {
        return indexByKey;
      }
    }

    return -1;
  }

  function findVisibleTweetIndex(tweets) {
    const headerOffset = 72;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    tweets.forEach((article, index) => {
      const rect = article.getBoundingClientRect();
      const isOnScreen = rect.bottom > headerOffset && rect.top < window.innerHeight;

      if (!isOnScreen) {
        return;
      }

      const distance = Math.abs(Math.max(rect.top, headerOffset) - headerOffset);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    if (bestIndex >= 0) {
      return bestIndex;
    }

    return tweets.findIndex((article) => article.getBoundingClientRect().bottom > headerOffset);
  }

  function setCurrentTweet(tweets, index, options = {}) {
    currentIndex = clamp(index, 0, tweets.length - 1);
    currentArticle = tweets[currentIndex];
    currentKey = getTweetKey(currentArticle);

    tweets.forEach((article, articleIndex) => {
      const isCurrent = articleIndex === currentIndex;
      article.classList.toggle(HIDDEN_CLASS, !isCurrent);
      article.classList.toggle(CURRENT_CLASS, isCurrent);
      article.toggleAttribute("aria-hidden", !isCurrent);
    });

    if (options.scroll) {
      requestAnimationFrame(() => {
        if (currentArticle && currentArticle.isConnected) {
          currentArticle.scrollIntoView({
            block: "start",
            inline: "nearest",
            behavior: "smooth"
          });
        }
      });
    }
  }

  function getTweetKey(article) {
    const statusId = findStatusId(article);
    if (statusId) {
      return `status:${statusId}`;
    }

    if (!nodeKeys.has(article)) {
      nodeKeys.set(article, `node:${nextNodeKey}`);
      nextNodeKey += 1;
    }

    return nodeKeys.get(article);
  }

  function findStatusId(article) {
    for (const link of article.querySelectorAll('a[href*="/status/"]')) {
      const href = link.getAttribute("href") || "";
      const match = href.match(/\/status\/(\d+)/);

      if (match) {
        return match[1];
      }
    }

    return "";
  }

  function goPrevious() {
    if (!isModeActive() || pendingNext) {
      return;
    }

    const tweets = getTweetArticles();
    const index = findCurrentTweetIndex(tweets);

    if (index > 0) {
      setCurrentTweet(tweets, index - 1, { scroll: true });
      updateControls(tweets);
    }
  }

  function goNext() {
    if (!isModeActive() || pendingNext) {
      return;
    }

    const tweets = getTweetArticles();
    const index = findCurrentTweetIndex(tweets);

    if (!tweets.length) {
      updateControls(tweets);
      return;
    }

    if (index < 0) {
      setCurrentTweet(tweets, 0, { scroll: true });
      updateControls(tweets);
      return;
    }

    if (index < tweets.length - 1) {
      setCurrentTweet(tweets, index + 1, { scroll: true });
      updateControls(tweets);
      return;
    }

    beginPendingNext(tweets);
  }

  function beginPendingNext(tweets) {
    pendingNext = true;
    pendingNextDeadline = Date.now() + LOAD_MORE_TIMEOUT_MS;
    updateControls(tweets);
    nudgeTimelineForMore();
    schedulePendingNextCheck();
  }

  function schedulePendingNextCheck() {
    clearTimeout(pendingNextTimer);
    pendingNextTimer = window.setTimeout(checkPendingNext, LOAD_MORE_RETRY_MS);
  }

  function checkPendingNext() {
    if (!pendingNext || !isModeActive()) {
      return;
    }

    const tweets = getTweetArticles();
    if (tryCompletePendingNext(tweets)) {
      return;
    }

    if (Date.now() > pendingNextDeadline) {
      pendingNext = false;
      updateControls(tweets);
      return;
    }

    nudgeTimelineForMore();
    schedulePendingNextCheck();
  }

  function tryCompletePendingNext(tweets) {
    const index = findCurrentTweetIndex(tweets);
    if (index >= 0 && index < tweets.length - 1) {
      pendingNext = false;
      clearTimeout(pendingNextTimer);
      setCurrentTweet(tweets, index + 1, { scroll: true });
      updateControls(tweets);
      return true;
    }

    return false;
  }

  function clearPendingNext() {
    pendingNext = false;
    clearTimeout(pendingNextTimer);
  }

  function nudgeTimelineForMore() {
    const scroller = document.scrollingElement || document.documentElement;
    const viewportStep = Math.max(480, Math.floor(window.innerHeight * 0.85));
    const nearBottom = Math.max(0, scroller.scrollHeight - window.innerHeight - 4);
    const targetTop = Math.min(scroller.scrollTop + viewportStep, nearBottom);

    window.scrollTo({
      top: targetTop,
      behavior: "smooth"
    });
  }

  function handleControlsClick(event) {
    if (!(event.target instanceof Element)) {
      return;
    }

    const button = event.target.closest("button[data-uno-twitter-action]");
    if (!button) {
      return;
    }

    const action = button.getAttribute("data-uno-twitter-action");
    if (action === "previous") {
      goPrevious();
    } else if (action === "next") {
      goNext();
    }
  }

  function updateControls(tweets = getTweetArticles()) {
    if (!controls) {
      return;
    }

    const previousButton = controls.querySelector('[data-uno-twitter-action="previous"]');
    const nextButton = controls.querySelector('[data-uno-twitter-action="next"]');
    const count = controls.querySelector(".uno-twitter-count");
    const modeActive = isModeActive();

    controls.hidden = !modeActive || !tweets.length;
    previousButton.disabled = !modeActive || pendingNext || !tweets.length || currentIndex <= 0;
    nextButton.disabled = !modeActive || pendingNext || !tweets.length;

    if (pendingNext) {
      count.textContent = "Loading";
    } else if (!modeActive || !tweets.length) {
      count.textContent = "0 / 0";
    } else {
      count.textContent = `${currentIndex + 1} / ${tweets.length}`;
    }
  }

  function handleKeyDown(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    if (isTypingContext(event.target) || isInsideControls(event.target)) {
      return;
    }

    if (!isModeActive()) {
      return;
    }

    const key = event.key.toLowerCase();
    const isSpace = event.key === " " || event.code === "Space";

    if (key === "j" || event.key === "ArrowRight" || (isSpace && !event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      goNext();
    } else if (key === "k" || event.key === "ArrowLeft" || (isSpace && event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      goPrevious();
    }
  }

  function isInsideControls(target) {
    return target instanceof Element && Boolean(target.closest(`[${CONTROLS_ATTR}]`));
  }

  function isTypingContext(target) {
    const targetElement = target instanceof Element ? target : null;
    return isEditableElement(targetElement) || isEditableElement(document.activeElement);
  }

  function isEditableElement(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    if (element.closest("input, textarea, select, [role='textbox'], [data-testid^='tweetTextarea']")) {
      return true;
    }

    const editable = element.closest("[contenteditable]");
    return Boolean(editable && editable.getAttribute("contenteditable") !== "false");
  }

  function clamp(number, min, max) {
    return Math.min(Math.max(number, min), max);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
