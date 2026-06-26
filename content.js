(() => {
  "use strict";

  const TWEET_SELECTOR = 'article[data-testid="tweet"]';
  const TIMELINE_CELL_SELECTOR = '[data-testid="cellInnerDiv"]';
  const AVATAR_SELECTOR = '[data-testid="Tweet-User-Avatar"], [data-testid*="UserAvatar"], [data-testid="User-Avatar"]';
  const CONTROLS_ATTR = "data-uno-twitter-controls";
  const HIDDEN_CLASS = "uno-twitter-hidden-tweet";
  const CURRENT_CLASS = "uno-twitter-current-tweet";
  const DISCOVER_MORE_CLASS = "uno-twitter-hidden-discover-more";
  const DISCOVER_MORE_TEXT = "discover more";
  const DEFAULT_ENABLED = true;
  const LOAD_MORE_TIMEOUT_MS = 9000;
  const LOAD_MORE_RETRY_MS = 450;
  const CONVERSATION_CONNECTOR_MIN_HEIGHT = 8;
  const CONVERSATION_CONNECTOR_MAX_WIDTH = 8;
  const CONVERSATION_CONNECTOR_X_TOLERANCE = 14;
  const CONVERSATION_CONNECTOR_EDGE_TOLERANCE = 8;

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
    const tweetGroups = getTweetGroups(tweets);
    const modeActive = isModeActive();
    releaseTweetsNoLongerPresent(tweets);
    knownTweets = new Set(tweets);

    if (!modeActive) {
      clearPendingNext();
      clearTweetClasses(tweets);
      updateControls(tweetGroups);
      return;
    }

    if (!tweetGroups.length) {
      currentArticle = null;
      currentKey = null;
      currentIndex = 0;
      updateControls(tweetGroups);
      return;
    }

    if (pendingNext && tryCompletePendingNext(tweetGroups)) {
      return;
    }

    const chooseVisible = shouldChooseVisibleTweet || routeChanged;
    shouldChooseVisibleTweet = false;

    let nextIndex = chooseVisible ? findVisibleTweetGroupIndex(tweetGroups) : findCurrentTweetGroupIndex(tweetGroups);
    if (nextIndex < 0) {
      nextIndex = clamp(currentIndex, 0, tweetGroups.length - 1);
    }

    setCurrentTweetGroup(tweetGroups, nextIndex);
    updateControls(tweetGroups);
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

  function getTweetGroups(tweets = getTweetArticles()) {
    const groups = [];

    for (const article of tweets) {
      const previousGroup = groups[groups.length - 1];
      const previousArticle = previousGroup && previousGroup.articles[previousGroup.articles.length - 1];

      if (previousArticle && areConversationPreviewNeighbors(previousArticle, article)) {
        previousGroup.articles.push(article);
        previousGroup.keys.push(getTweetKey(article));
        previousGroup.key = getTweetGroupKey(previousGroup.keys);
        continue;
      }

      const key = getTweetKey(article);
      groups.push({
        articles: [article],
        keys: [key],
        key: getTweetGroupKey([key])
      });
    }

    return groups;
  }

  function getTweetGroupKey(keys) {
    return `group:${keys.join("|")}`;
  }

  function areConversationPreviewNeighbors(previousArticle, nextArticle) {
    return areTweetCellsAdjacent(previousArticle, nextArticle) &&
      (
        hasConversationConnectorCue(previousArticle, "next") ||
        hasConversationConnectorCue(nextArticle, "previous")
      );
  }

  function areTweetCellsAdjacent(previousArticle, nextArticle) {
    const previousCell = getTimelineCell(previousArticle);
    const nextCell = getTimelineCell(nextArticle);

    if (!previousCell || !nextCell || previousCell === nextCell) {
      return false;
    }

    if (previousCell.parentElement && previousCell.parentElement === nextCell.parentElement) {
      const siblings = [...previousCell.parentElement.children];

      return siblings.indexOf(nextCell) === siblings.indexOf(previousCell) + 1;
    }

    const previousRect = previousCell.getBoundingClientRect();
    const nextRect = nextCell.getBoundingClientRect();
    const verticalGap = nextRect.top - previousRect.bottom;

    return verticalGap >= -1 && verticalGap <= 16;
  }

  function getTimelineCell(article) {
    return article.closest(TIMELINE_CELL_SELECTOR) || article;
  }

  function hasConversationConnectorCue(article, direction) {
    const avatarRect = getTweetAvatarRect(article);
    const articleRect = article.getBoundingClientRect();

    if (!avatarRect || !hasUsableRect(articleRect)) {
      return false;
    }

    const avatarCenterX = avatarRect.left + (avatarRect.width / 2);
    const elements = article.querySelectorAll("div, span");

    for (const element of elements) {
      if (!hasConnectorPaint(element)) {
        continue;
      }

      for (const rect of element.getClientRects()) {
        if (!isConnectorRect(rect, avatarCenterX)) {
          continue;
        }

        if (direction === "previous" && isConnectorAboveAvatar(rect, avatarRect, articleRect)) {
          return true;
        }

        if (direction === "next" && isConnectorBelowAvatar(rect, avatarRect, articleRect)) {
          return true;
        }
      }
    }

    return false;
  }

  function getTweetAvatarRect(article) {
    const avatar = article.querySelector(AVATAR_SELECTOR) || findLikelyAvatarElement(article);

    if (!avatar) {
      return null;
    }

    const rect = avatar.getBoundingClientRect();
    return hasUsableRect(rect) ? rect : null;
  }

  function findLikelyAvatarElement(article) {
    const image = [...article.querySelectorAll("img")].find((img) => {
      return /profile_images/.test(img.currentSrc || img.src || "");
    });

    return image ? image.closest("a, div") || image : null;
  }

  function hasConnectorPaint(element) {
    const style = getComputedStyle(element);

    return hasPaintedColor(style.backgroundColor) ||
      hasPaintedBorder(style.borderLeftWidth, style.borderLeftColor) ||
      hasPaintedBorder(style.borderRightWidth, style.borderRightColor);
  }

  function hasPaintedBorder(width, color) {
    return parseFloat(width) > 0 && hasPaintedColor(color);
  }

  function hasPaintedColor(color) {
    return Boolean(color) && color !== "transparent" && color !== "rgba(0, 0, 0, 0)";
  }

  function isConnectorRect(rect, avatarCenterX) {
    return hasUsableRect(rect) &&
      rect.height >= CONVERSATION_CONNECTOR_MIN_HEIGHT &&
      rect.width <= CONVERSATION_CONNECTOR_MAX_WIDTH &&
      rect.height >= rect.width * 2 &&
      Math.abs((rect.left + (rect.width / 2)) - avatarCenterX) <= CONVERSATION_CONNECTOR_X_TOLERANCE;
  }

  function isConnectorAboveAvatar(rect, avatarRect, articleRect) {
    return rect.top >= articleRect.top - 1 &&
      rect.top < avatarRect.top - 2 &&
      rect.bottom <= avatarRect.top + CONVERSATION_CONNECTOR_EDGE_TOLERANCE;
  }

  function isConnectorBelowAvatar(rect, avatarRect, articleRect) {
    return rect.bottom <= articleRect.bottom + 1 &&
      rect.bottom > avatarRect.bottom + 2 &&
      rect.top >= avatarRect.bottom - CONVERSATION_CONNECTOR_EDGE_TOLERANCE;
  }

  function hasUsableRect(rect) {
    return rect && rect.width > 0 && rect.height > 0;
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

  function findCurrentTweetGroupIndex(tweetGroups) {
    if (currentArticle) {
      const indexByArticle = tweetGroups.findIndex((group) => group.articles.includes(currentArticle));
      if (indexByArticle >= 0) {
        return indexByArticle;
      }
    }

    if (currentKey) {
      const indexByKey = tweetGroups.findIndex((group) => {
        return group.key === currentKey || group.keys.includes(currentKey);
      });
      if (indexByKey >= 0) {
        return indexByKey;
      }
    }

    return -1;
  }

  function findVisibleTweetGroupIndex(tweetGroups) {
    const headerOffset = 72;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    tweetGroups.forEach((group, index) => {
      const rect = getTweetGroupRect(group);
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

    return tweetGroups.findIndex((group) => getTweetGroupRect(group).bottom > headerOffset);
  }

  function getTweetGroupRect(group) {
    return group.articles.reduce((bounds, article) => {
      const rect = article.getBoundingClientRect();

      return {
        top: Math.min(bounds.top, rect.top),
        bottom: Math.max(bounds.bottom, rect.bottom)
      };
    }, {
      top: Number.POSITIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY
    });
  }

  function setCurrentTweetGroup(tweetGroups, index, options = {}) {
    currentIndex = clamp(index, 0, tweetGroups.length - 1);

    const currentGroup = tweetGroups[currentIndex];
    const currentArticles = new Set(currentGroup.articles);
    currentArticle = currentGroup.articles[0];
    currentKey = currentGroup.keys[0] || getTweetKey(currentArticle);

    for (const group of tweetGroups) {
      for (const article of group.articles) {
        const isCurrent = currentArticles.has(article);
        article.classList.toggle(HIDDEN_CLASS, !isCurrent);
        article.classList.toggle(CURRENT_CLASS, isCurrent);
        article.toggleAttribute("aria-hidden", !isCurrent);
      }
    }

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

    const tweetGroups = getTweetGroups();
    const index = findCurrentTweetGroupIndex(tweetGroups);

    if (index > 0) {
      setCurrentTweetGroup(tweetGroups, index - 1, { scroll: true });
      updateControls(tweetGroups);
    }
  }

  function goNext() {
    if (!isModeActive() || pendingNext) {
      return;
    }

    const tweetGroups = getTweetGroups();
    const index = findCurrentTweetGroupIndex(tweetGroups);

    if (!tweetGroups.length) {
      updateControls(tweetGroups);
      return;
    }

    if (index < 0) {
      setCurrentTweetGroup(tweetGroups, 0, { scroll: true });
      updateControls(tweetGroups);
      return;
    }

    if (index < tweetGroups.length - 1) {
      setCurrentTweetGroup(tweetGroups, index + 1, { scroll: true });
      updateControls(tweetGroups);
      return;
    }

    beginPendingNext(tweetGroups);
  }

  function beginPendingNext(tweetGroups) {
    pendingNext = true;
    pendingNextDeadline = Date.now() + LOAD_MORE_TIMEOUT_MS;
    updateControls(tweetGroups);
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

    const tweetGroups = getTweetGroups();
    if (tryCompletePendingNext(tweetGroups)) {
      return;
    }

    if (Date.now() > pendingNextDeadline) {
      pendingNext = false;
      updateControls(tweetGroups);
      return;
    }

    nudgeTimelineForMore();
    schedulePendingNextCheck();
  }

  function tryCompletePendingNext(tweetGroups) {
    const index = findCurrentTweetGroupIndex(tweetGroups);
    if (index >= 0 && index < tweetGroups.length - 1) {
      pendingNext = false;
      clearTimeout(pendingNextTimer);
      setCurrentTweetGroup(tweetGroups, index + 1, { scroll: true });
      updateControls(tweetGroups);
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

  function updateControls(tweetGroups = getTweetGroups()) {
    if (!controls) {
      return;
    }

    const previousButton = controls.querySelector('[data-uno-twitter-action="previous"]');
    const nextButton = controls.querySelector('[data-uno-twitter-action="next"]');
    const count = controls.querySelector(".uno-twitter-count");
    const modeActive = isModeActive();

    controls.hidden = !modeActive || !tweetGroups.length;
    previousButton.disabled = !modeActive || pendingNext || !tweetGroups.length || currentIndex <= 0;
    nextButton.disabled = !modeActive || pendingNext || !tweetGroups.length;

    if (pendingNext) {
      count.textContent = "Loading";
    } else if (!modeActive || !tweetGroups.length) {
      count.textContent = "0 / 0";
    } else {
      count.textContent = `${currentIndex + 1} / ${tweetGroups.length}`;
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
