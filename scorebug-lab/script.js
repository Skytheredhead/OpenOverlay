const stage = document.querySelector("#stage");
const surfaceSelect = document.querySelector("#surfaceSelect");
const scaleRange = document.querySelector("#scaleRange");
const clockInput = document.querySelector("#clockInput");
const halfSelect = document.querySelector("#halfSelect");
const homeScoreLabel = document.querySelector("#homeScore");
const awayScoreLabel = document.querySelector("#awayScore");
const scoreButtons = document.querySelectorAll("[data-score][data-step]");
const navButtons = document.querySelectorAll("[data-target]");
const bugs = document.querySelectorAll("[data-bug]");
const clockTargets = document.querySelectorAll("[data-bind-clock]");
const halfTargets = document.querySelectorAll("[data-bind-half]");
const scoreTargets = document.querySelectorAll("[data-bind-score]");

let scores = {
  home: 2,
  away: 1
};

function setActiveBug(id) {
  bugs.forEach((bug) => {
    bug.classList.toggle("active", bug.dataset.bug === id);
  });

  navButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.target === id);
  });
}

function syncClock() {
  const value = clockInput.value.trim() || "0:00";
  clockTargets.forEach((target) => {
    target.textContent = value;
  });
}

function syncHalf() {
  halfTargets.forEach((target) => {
    target.textContent = halfSelect.value;
  });
}

function syncScores() {
  homeScoreLabel.textContent = scores.home;
  awayScoreLabel.textContent = scores.away;
  scoreTargets.forEach((target) => {
    const side = target.dataset.bindScore;
    target.textContent = scores[side];
  });
}

surfaceSelect.addEventListener("change", () => {
  stage.classList.remove("surface-pitch", "surface-checker", "surface-studio");
  stage.classList.add(`surface-${surfaceSelect.value}`);
});

scaleRange.addEventListener("input", () => {
  stage.style.setProperty("--bug-scale", Number(scaleRange.value) / 100);
});

clockInput.addEventListener("input", syncClock);
halfSelect.addEventListener("change", syncHalf);

scoreButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const side = button.dataset.score;
    const step = Number(button.dataset.step);
    scores[side] = Math.max(0, scores[side] + step);
    syncScores();
  });
});

navButtons.forEach((button) => {
  button.addEventListener("click", () => setActiveBug(button.dataset.target));
});

syncClock();
syncHalf();
syncScores();
