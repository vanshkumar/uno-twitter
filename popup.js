(() => {
  "use strict";

  const DEFAULT_ENABLED = true;
  const enabledInput = document.getElementById("enabled");

  chrome.storage.local.get({ enabled: DEFAULT_ENABLED }, (items) => {
    enabledInput.checked = Boolean(items.enabled);
  });

  enabledInput.addEventListener("change", () => {
    chrome.storage.local.set({ enabled: enabledInput.checked });
  });
})();
