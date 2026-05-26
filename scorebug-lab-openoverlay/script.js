const stage = document.querySelector("#stage");
const surfaceSelect = document.querySelector("#surfaceSelect");
const scaleRange = document.querySelector("#scaleRange");
const backgroundToggle = document.querySelector("#packageBackgroundToggle");
const backgroundOpacity = document.querySelector("#packageBackgroundOpacity");
const clockInput = document.querySelector("#clockInput");
const halfSelect = document.querySelector("#halfSelect");
const countdownInput = document.querySelector("#countdownInput");
const homeScoreLabel = document.querySelector("#homeScore");
const awayScoreLabel = document.querySelector("#awayScore");
const scoreButtons = document.querySelectorAll("[data-score][data-step]");
const overlays = document.querySelectorAll("[data-overlay]");
const cards = document.querySelectorAll("[data-card]");
const toggleButtons = document.querySelectorAll("[data-toggle-overlay]");
const clockTargets = document.querySelectorAll("[data-bind-clock]");
const halfTargets = document.querySelectorAll("[data-bind-half]");
const scoreTargets = document.querySelectorAll("[data-bind-score]");
const countdownTargets = document.querySelectorAll("[data-bind-countdown]");
const scorebugOverlay = document.querySelector("[data-overlay='scorebug']");
const scorebugLayout = document.querySelector("#scorebugLayout");
const scorebugLength = document.querySelector("#scorebugLength");
const countdownOverlay = document.querySelector("[data-overlay='countdown-timer']");
const countdownMode = document.querySelector("#countdownMode");
const countdownPosition = document.querySelector("#countdownPosition");
const oneLineText = document.querySelector("#oneLineText");
const oneLinePosition = document.querySelector("#oneLinePosition");
const oneLineOverlay = document.querySelector("[data-overlay='one-line-text']");
const twoLineTextA = document.querySelector("#twoLineTextA");
const twoLineTextB = document.querySelector("#twoLineTextB");
const twoLinePosition = document.querySelector("#twoLinePosition");
const twoLineOverlay = document.querySelector("[data-overlay='two-line-text']");
const detailSections = document.querySelectorAll("[data-detail]");
const detailEyebrow = document.querySelector("#detailEyebrow");
const detailTitle = document.querySelector("#detailTitle");
const detailDescription = document.querySelector("#detailDescription");
const eventTitleInput = document.querySelector("#eventTitleInput");
const mirroredEventInputs = document.querySelectorAll("[data-mirror-input='eventTitleInput']");
const eventTitleTargets = document.querySelectorAll("[data-bind-event-title]");
const homeNameInput = document.querySelector("#homeNameInput");
const homeRecordInput = document.querySelector("#homeRecordInput");
const awayNameInput = document.querySelector("#awayNameInput");
const awayRecordInput = document.querySelector("#awayRecordInput");
const teamTargets = document.querySelectorAll("[data-bind-team]");
const lowerResultState = document.querySelector("#lowerResultState");
const resultStateTargets = document.querySelectorAll("[data-bind-result-state]");
const countdownStartStop = document.querySelector("#countdownStartStop");
const timerPresetButtons = document.querySelectorAll("[data-set-timer]");
const applyCustomTimer = document.querySelector("#applyCustomTimer");
const timerHours = document.querySelector("#timerHours");
const timerMinutes = document.querySelector("#timerMinutes");
const timerSeconds = document.querySelector("#timerSeconds");
const applyExactTimer = document.querySelector("#applyExactTimer");
const lineupInput = document.querySelector("#lineupInput");
const lineupList = document.querySelector("[data-lineup-list]");
const lineupPrev = document.querySelector("#lineupPrev");
const lineupNext = document.querySelector("#lineupNext");
const lineupPageLabel = document.querySelector("#lineupPageLabel");

const MAX_TIMER_SECONDS = 9 * 3600 + 59 * 60 + 59;
const LINEUP_PAGE_SIZE = 6;

let activeOverlay = "full-matchup";
let selectedCard = "full-matchup";
let countdownSeconds = parseTime(countdownInput.value);
let countdownInterval = null;
let scores = {
  home: 2,
  away: 1
};
let lineupPlayers = parseLineup(lineupInput.value);
let lineupPage = 0;
const animationTimers = new WeakMap();
const pendingHideOverlays = new WeakSet();
const ENTER_ANIMATION_MS = 920;
const EXIT_ANIMATION_MS = 900;
const SWITCH_IN_DELAY_MS = Math.round(EXIT_ANIMATION_MS * 0.9);
let switchTimer = null;
const textAnimationTimers = new WeakMap();
let scorebugLayoutSwitchTimer = null;
let timerActivationTimer = null;
let pendingSwitchOverlay = null;
let countdownToggleTimer = null;
let countdownToggleLocked = false;

const overlayMeta = {
  "full-matchup": ["01", "Full page matchup", "Full-frame square package with flags, records, event, and optional timer"],
  "lower-matchup": ["02", "Lower matchup", "Pregame lower-third matchup using the shared hard-edge package system"],
  "lower-result": ["03", "Lower score matchup", "Halftime or final lower-third with score and optional return timer"],
  "lineup-panel": ["04", "Lineup panel", "Paged roster panel with snap-in name rows"],
  scorebug: ["05", "Scorebug", "Horizontal or vertical scorebug in the OpenOverlay square style"],
  "countdown-timer": ["06", "Countdown timer", "Full-page or small positional timer with presets and exact time entry"],
  "one-line-text": ["07", "1-line text bug", "Custom single-line text with positional placement"],
  "two-line-text": ["08", "2-line text bug", "Custom two-line text with positional placement"]
};

const positionClasses = [
  "position-top-left",
  "position-top-center",
  "position-top-right",
  "position-bottom-left",
  "position-bottom-center",
  "position-bottom-right"
];

function parseTime(value) {
  const parts = value.trim().split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return 0;
  if (parts.length === 1) return clampTimer(parts[0]);
  if (parts.length === 2) return clampTimer(parts[0] * 60 + parts[1]);
  return clampTimer(parts[0] * 3600 + parts[1] * 60 + parts[2]);
}

function clampTimer(seconds) {
  return Math.min(MAX_TIMER_SECONDS, Math.max(0, Math.floor(seconds || 0)));
}

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function parseLineup(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",");
      if (parts.length < 2) return { number: "", name: line };
      return { number: parts[0].trim(), name: parts.slice(1).join(",").trim() };
    });
}

function isCountdownRunning() {
  return countdownInterval !== null;
}

function supportsEmbeddedCountdown(id = activeOverlay) {
  return ["full-matchup", "lower-matchup", "lower-result"].includes(id);
}

function isDisplayedOverlayText(target) {
  const overlay = target.closest("[data-overlay]");
  return Boolean(overlay?.classList.contains("active") && !overlay.classList.contains("overlay-entering"));
}

function restartTextAnimation(target, className) {
  const existingTimer = textAnimationTimers.get(target);
  if (existingTimer) window.clearTimeout(existingTimer);
  target.classList.remove("text-updated", "score-updated");
  void target.offsetWidth;
  target.classList.add(className);
  textAnimationTimers.set(target, window.setTimeout(() => {
    textAnimationTimers.delete(target);
  }, className === "score-updated" ? 720 : 420));
}

function setAnimatedText(target, value, options = {}) {
  const nextValue = String(value);
  const previousValue = target.textContent;
  if (previousValue === nextValue) return;

  const previousNumber = Number(previousValue);
  const nextNumber = Number(nextValue);
  const scoreIncreased = options.score && !Number.isNaN(previousNumber) && nextNumber > previousNumber;
  const visible = isDisplayedOverlayText(target);

  target.textContent = nextValue;
  if (!visible) return;
  restartTextAnimation(target, scoreIncreased ? "score-updated" : "text-updated");
}

function setAnimatedCountdown(target, value) {
  const nextValue = String(value);
  const previousValue = target.dataset.countdownValue ?? target.textContent;
  if (previousValue === nextValue) return;

  const visible = isDisplayedOverlayText(target);
  target.dataset.countdownValue = nextValue;
  target.replaceChildren(...[...nextValue].map((char, index) => {
    const span = document.createElement("span");
    span.className = "countdown-char";
    if (visible && previousValue[index] !== char) span.classList.add("countdown-char-updated");
    span.textContent = char;
    return span;
  }));
}

function clearAnimation(overlay) {
  const timer = animationTimers.get(overlay);
  if (timer) window.clearTimeout(timer);
  animationTimers.delete(overlay);
  pendingHideOverlays.delete(overlay);
  overlay.classList.remove("overlay-entering", "overlay-exiting");
}

function clearSwitchTimer() {
  if (switchTimer) window.clearTimeout(switchTimer);
  switchTimer = null;
  pendingSwitchOverlay = null;
}

function clearScorebugLayoutSwitchTimer() {
  if (scorebugLayoutSwitchTimer) window.clearTimeout(scorebugLayoutSwitchTimer);
  scorebugLayoutSwitchTimer = null;
}

function showOverlay(overlay) {
  const hideAfterIntro = pendingHideOverlays.has(overlay);
  clearAnimation(overlay);
  if (hideAfterIntro) pendingHideOverlays.add(overlay);
  overlay.classList.add("active", "overlay-entering");
  const timer = window.setTimeout(() => {
    overlay.classList.remove("overlay-entering");
    animationTimers.delete(overlay);
    if (pendingHideOverlays.has(overlay)) {
      pendingHideOverlays.delete(overlay);
      hideOverlay(overlay);
    }
  }, ENTER_ANIMATION_MS);
  animationTimers.set(overlay, timer);
}

function hideOverlay(overlay) {
  if (!overlay.classList.contains("active")) return;
  if (overlay.classList.contains("overlay-entering")) {
    pendingHideOverlays.add(overlay);
    return;
  }
  clearAnimation(overlay);
  overlay.classList.add("overlay-exiting");
  const timer = window.setTimeout(() => {
    overlay.classList.remove("active", "overlay-exiting");
    animationTimers.delete(overlay);
  }, EXIT_ANIMATION_MS);
  animationTimers.set(overlay, timer);
}

function updateCards() {
  cards.forEach((card) => {
    const id = card.dataset.card;
    const active = id === activeOverlay;
    const runningTimerCard = id === "countdown-timer" && isCountdownRunning();
    card.classList.toggle("active", active);
    card.classList.toggle("selected", id === selectedCard);
    card.classList.toggle("running", runningTimerCard && !active);
    const button = card.querySelector("[data-toggle-overlay]");
    if (!button) return;
    button.textContent = active || runningTimerCard ? "Stop" : "Play";
  });
  stage.classList.toggle("timer-running", isCountdownRunning());
  stage.classList.toggle("countdown-has-hours", countdownSeconds >= 3600);
  if (countdownStartStop) countdownStartStop.textContent = isCountdownRunning() ? "Stop timer" : "Start timer";
}

function setActiveOverlay(id) {
  clearSwitchTimer();
  activeOverlay = id;
  selectedCard = id;
  syncDetailPanel();
  const targetOverlay = [...overlays].find((overlay) => overlay.dataset.overlay === id);
  const outgoingOverlays = [...overlays].filter((overlay) => {
    return overlay.dataset.overlay !== id && overlay.classList.contains("active");
  });
  overlays.forEach((overlay) => {
    if (overlay.dataset.overlay !== id) hideOverlay(overlay);
  });
  if (targetOverlay) {
    if (outgoingOverlays.length > 0) {
      const hasQueuedOutro = outgoingOverlays.some((overlay) => overlay.classList.contains("overlay-entering"));
      const switchDelay = hasQueuedOutro ? ENTER_ANIMATION_MS + SWITCH_IN_DELAY_MS : SWITCH_IN_DELAY_MS;
      pendingSwitchOverlay = targetOverlay;
      switchTimer = window.setTimeout(() => {
        showOverlay(targetOverlay);
        switchTimer = null;
        pendingSwitchOverlay = null;
      }, switchDelay);
    } else {
      showOverlay(targetOverlay);
    }
  }
  if (id === "countdown-timer" && !isCountdownRunning()) startCountdown();
  updateCards();
}

function stopOverlay(id) {
  const targetOverlay = [...overlays].find((overlay) => overlay.dataset.overlay === id);
  const stopQueuedIntro = Boolean(switchTimer && pendingSwitchOverlay === targetOverlay);
  if (stopQueuedIntro) {
    pendingHideOverlays.add(targetOverlay);
  } else {
    clearSwitchTimer();
  }
  selectedCard = id;
  syncDetailPanel();
  overlays.forEach((overlay) => {
    if (overlay.dataset.overlay === id) hideOverlay(overlay);
  });
  if (activeOverlay === id) activeOverlay = null;
  if (id === "countdown-timer") stopCountdown(false);
  updateCards();
}

function startCountdown() {
  const wasRunning = isCountdownRunning();
  if (countdownSeconds <= 0) setCountdownSeconds(parseTime(countdownInput.value || "5:00"));
  stopCountdown(false);
  countdownInterval = window.setInterval(() => {
    countdownSeconds = Math.max(0, countdownSeconds - 1);
    syncCountdown();
    if (countdownSeconds === 0) stopCountdown(false);
  }, 1000);
  if (!wasRunning) {
    if (timerActivationTimer) window.clearTimeout(timerActivationTimer);
    stage.classList.remove("timer-activating");
    void stage.offsetWidth;
    stage.classList.add("timer-activating");
    timerActivationTimer = window.setTimeout(() => {
      stage.classList.remove("timer-activating");
      timerActivationTimer = null;
    }, 760);
  }
  updateCards();
}

function stopCountdown(reset) {
  if (countdownInterval) window.clearInterval(countdownInterval);
  countdownInterval = null;
  if (timerActivationTimer) window.clearTimeout(timerActivationTimer);
  timerActivationTimer = null;
  stage.classList.remove("timer-activating");
  if (reset) {
    countdownSeconds = parseTime(countdownInput.value);
    syncCountdown();
  }
  updateCards();
}

function lockCountdownToggle() {
  if (countdownToggleLocked) return false;
  countdownToggleLocked = true;
  if (countdownToggleTimer) window.clearTimeout(countdownToggleTimer);
  countdownToggleTimer = window.setTimeout(() => {
    countdownToggleLocked = false;
    countdownToggleTimer = null;
  }, 320);
  return true;
}

function syncClock() {
  const value = clockInput.value.trim() || "0:00";
  clockTargets.forEach((target) => {
    setAnimatedText(target, value);
  });
}

function syncHalf() {
  halfTargets.forEach((target) => {
    setAnimatedText(target, halfSelect.value);
  });
}

function syncCountdown() {
  const value = formatTime(countdownSeconds);
  countdownTargets.forEach((target) => {
    setAnimatedCountdown(target, value);
  });
  countdownInput.value = value;
  timerHours.value = Math.floor(countdownSeconds / 3600);
  timerMinutes.value = Math.floor((countdownSeconds % 3600) / 60);
  timerSeconds.value = countdownSeconds % 60;
  stage.classList.toggle("countdown-has-hours", countdownSeconds >= 3600);
}

function setCountdownSeconds(seconds) {
  countdownSeconds = clampTimer(seconds);
  syncCountdown();
}

function syncScores() {
  homeScoreLabel.textContent = scores.home;
  awayScoreLabel.textContent = scores.away;
  scoreTargets.forEach((target) => {
    const side = target.dataset.bindScore;
    setAnimatedText(target, scores[side], { score: true });
  });
}

function syncDetailPanel() {
  const meta = overlayMeta[selectedCard] || overlayMeta["full-matchup"];
  detailEyebrow.textContent = meta[0];
  detailTitle.textContent = meta[1];
  detailDescription.textContent = meta[2];
  detailSections.forEach((section) => {
    section.classList.toggle("active", section.dataset.detail === selectedCard);
  });
}

function syncEventTitle(value) {
  eventTitleInput.value = value;
  mirroredEventInputs.forEach((input) => {
    input.value = value;
  });
  eventTitleTargets.forEach((target) => {
    setAnimatedText(target, value);
  });
}

function syncTeamFields() {
  const values = {
    "home-name": homeNameInput.value || " ",
    "home-record": homeRecordInput.value || " ",
    "home-abbr": "ARG",
    "away-name": awayNameInput.value || " ",
    "away-record": awayRecordInput.value || " ",
    "away-abbr": "FRA"
  };
  teamTargets.forEach((target) => {
    setAnimatedText(target, values[target.dataset.bindTeam] || " ");
  });
}

function syncResultState() {
  resultStateTargets.forEach((target) => {
    setAnimatedText(target, lowerResultState.value);
  });
  stage.classList.toggle("result-final", lowerResultState.value === "FINAL");
}

function renderLineup(direction) {
  const totalPages = Math.max(1, Math.ceil(lineupPlayers.length / LINEUP_PAGE_SIZE));
  lineupPage = Math.min(totalPages - 1, Math.max(0, lineupPage));
  const start = lineupPage * LINEUP_PAGE_SIZE;
  const visiblePlayers = lineupPlayers.slice(start, start + LINEUP_PAGE_SIZE);
  while (visiblePlayers.length < LINEUP_PAGE_SIZE) visiblePlayers.push({ number: "", name: "" });

  const writeRows = () => {
    lineupList.innerHTML = visiblePlayers
      .map((player) => `<li><b>${player.number}</b><span>${player.name}</span></li>`)
      .join("");
    lineupPageLabel.textContent = `${lineupPage + 1} / ${totalPages}`;
    lineupPrev.disabled = totalPages <= 1;
    lineupNext.disabled = totalPages <= 1;
  };

  if (!direction) {
    writeRows();
    return;
  }

  lineupList.classList.remove("lineup-slide-in", "lineup-slide-out");
  lineupList.classList.add(direction === "next" ? "lineup-slide-out-left" : "lineup-slide-out-right");
  window.setTimeout(() => {
    writeRows();
    lineupList.classList.remove("lineup-slide-out-left", "lineup-slide-out-right");
    lineupList.classList.add(direction === "next" ? "lineup-slide-in-right" : "lineup-slide-in-left");
    window.setTimeout(() => lineupList.classList.remove("lineup-slide-in-right", "lineup-slide-in-left"), 620);
  }, 360);
}

function setPosition(overlay, position) {
  overlay.classList.remove(...positionClasses);
  overlay.classList.add(`position-${position}`);
}

function syncCountdownMode() {
  const small = countdownMode.value === "small";
  countdownPosition.disabled = !small;
  countdownOverlay.classList.toggle("countdown-small", small);
  countdownOverlay.classList.toggle("countdown-full", !small);
  if (small) setPosition(countdownOverlay, countdownPosition.value);
  else countdownOverlay.classList.remove(...positionClasses);
}

function syncScorebugLayout() {
  const vertical = scorebugLayout.value === "vertical";
  const alreadyVertical = scorebugOverlay.classList.contains("scorebug-vertical");
  const isLive = scorebugOverlay.classList.contains("active") && activeOverlay === "scorebug";
  const canAnimate = isLive && alreadyVertical !== vertical;
  const wasSwitching = scorebugOverlay.classList.contains("layout-switching");

  clearScorebugLayoutSwitchTimer();
  if (wasSwitching) {
    clearAnimation(scorebugOverlay);
    scorebugOverlay.classList.remove("layout-switching");
  }

  if (canAnimate) {
    clearAnimation(scorebugOverlay);
    scorebugOverlay.classList.add("overlay-exiting", "layout-switching");
    scorebugLayoutSwitchTimer = window.setTimeout(() => {
      scorebugOverlay.classList.toggle("scorebug-vertical", vertical);
      scorebugOverlay.classList.toggle("scorebug-horizontal", !vertical);
      scorebugOverlay.classList.remove("overlay-exiting");
      scorebugOverlay.classList.add("overlay-entering");
      scorebugLayoutSwitchTimer = window.setTimeout(() => {
        scorebugOverlay.classList.remove("overlay-entering", "layout-switching");
        scorebugLayoutSwitchTimer = null;
      }, ENTER_ANIMATION_MS);
    }, Math.round(EXIT_ANIMATION_MS * 0.82));
    return;
  }

  scorebugOverlay.classList.remove("layout-switching");
  scorebugOverlay.classList.toggle("scorebug-vertical", vertical);
  scorebugOverlay.classList.toggle("scorebug-horizontal", !vertical);
}

surfaceSelect.addEventListener("change", () => {
  stage.classList.remove("surface-pitch", "surface-checker", "surface-studio");
  stage.classList.add(`surface-${surfaceSelect.value}`);
});

scaleRange.addEventListener("input", () => {
  stage.style.setProperty("--overlay-scale", Number(scaleRange.value) / 100);
});

backgroundToggle.addEventListener("change", () => {
  stage.classList.toggle("background-off", !backgroundToggle.checked);
});

backgroundOpacity.addEventListener("input", () => {
  stage.style.setProperty("--package-bg-opacity", Number(backgroundOpacity.value) / 100);
});

clockInput.addEventListener("input", syncClock);
halfSelect.addEventListener("change", syncHalf);
countdownInput.addEventListener("input", () => {
  setCountdownSeconds(parseTime(countdownInput.value));
});

scorebugLayout.addEventListener("change", syncScorebugLayout);
scorebugLength.addEventListener("input", () => {
  scorebugOverlay.style.setProperty("--scorebug-width", `${scorebugLength.value}%`);
});

countdownMode.addEventListener("change", syncCountdownMode);
countdownPosition.addEventListener("change", syncCountdownMode);

oneLineText.addEventListener("input", () => {
  setAnimatedText(document.querySelector("[data-bind-text-one]"), oneLineText.value || " ");
});
oneLinePosition.addEventListener("change", () => setPosition(oneLineOverlay, oneLinePosition.value));

twoLineTextA.addEventListener("input", () => {
  setAnimatedText(document.querySelector("[data-bind-text-two-a]"), twoLineTextA.value || " ");
});
twoLineTextB.addEventListener("input", () => {
  setAnimatedText(document.querySelector("[data-bind-text-two-b]"), twoLineTextB.value || " ");
});
twoLinePosition.addEventListener("change", () => setPosition(twoLineOverlay, twoLinePosition.value));

eventTitleInput.addEventListener("input", () => syncEventTitle(eventTitleInput.value || " "));
mirroredEventInputs.forEach((input) => {
  input.addEventListener("input", () => syncEventTitle(input.value || " "));
});
[homeNameInput, homeRecordInput, awayNameInput, awayRecordInput].forEach((input) => {
  input.addEventListener("input", syncTeamFields);
});
lowerResultState.addEventListener("change", syncResultState);

countdownStartStop.addEventListener("click", () => {
  if (!lockCountdownToggle()) return;
  if (isCountdownRunning()) stopCountdown(false);
  else startCountdown();
});
timerPresetButtons.forEach((button) => {
  button.addEventListener("click", () => setCountdownSeconds(Number(button.dataset.setTimer)));
});
applyCustomTimer.addEventListener("click", () => setCountdownSeconds(parseTime(countdownInput.value)));
applyExactTimer.addEventListener("click", () => {
  const hours = Number(timerHours.value);
  const minutes = Number(timerMinutes.value);
  const seconds = Number(timerSeconds.value);
  setCountdownSeconds(hours * 3600 + minutes * 60 + seconds);
});

lineupInput.addEventListener("input", () => {
  lineupPlayers = parseLineup(lineupInput.value);
  lineupPage = 0;
  renderLineup();
});
lineupPrev.addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(lineupPlayers.length / LINEUP_PAGE_SIZE));
  lineupPage = (lineupPage - 1 + totalPages) % totalPages;
  renderLineup("prev");
});
lineupNext.addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(lineupPlayers.length / LINEUP_PAGE_SIZE));
  lineupPage = (lineupPage + 1) % totalPages;
  renderLineup("next");
});

scoreButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const side = button.dataset.score;
    const step = Number(button.dataset.step);
    scores[side] = Math.max(0, scores[side] + step);
    syncScores();
  });
});

toggleButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const id = button.dataset.toggleOverlay;
    selectedCard = id;
    syncDetailPanel();
    if (id === "countdown-timer") {
      if (!lockCountdownToggle()) return;
      if (isCountdownRunning()) {
        if (activeOverlay === "countdown-timer") stopOverlay(id);
        else {
          stopCountdown(false);
          updateCards();
        }
        return;
      }
      if (supportsEmbeddedCountdown()) {
        startCountdown();
        updateCards();
        return;
      }
      setActiveOverlay(id);
      return;
    }
    if (id === activeOverlay) stopOverlay(id);
    else setActiveOverlay(id);
  });
});

cards.forEach((card) => {
  card.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    selectedCard = card.dataset.card;
    syncDetailPanel();
    updateCards();
  });
});

stage.style.setProperty("--package-bg-opacity", Number(backgroundOpacity.value) / 100);
scorebugOverlay.style.setProperty("--scorebug-width", `${scorebugLength.value}%`);
syncDetailPanel();
syncEventTitle(eventTitleInput.value);
syncTeamFields();
syncResultState();
syncCountdownMode();
syncScorebugLayout();
syncClock();
syncHalf();
syncCountdown();
syncScores();
renderLineup();
updateCards();
