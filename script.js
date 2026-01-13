// Face Friend Adventure
// All images stay ONLY in this browser. We do not upload, store, or track photos.

const photoInput = document.getElementById("photoInput");
const photoPreview = document.getElementById("photoPreview");
const resetPhoto = document.getElementById("resetPhoto");
const toCharacter = document.getElementById("toCharacter");
const toChoices = document.getElementById("toChoices");
const toResult = document.getElementById("toResult");
const storyText = document.getElementById("storyText");
const resultCanvas = document.getElementById("resultCanvas");
const ctx = resultCanvas.getContext("2d");

const steps = {
  upload: document.getElementById("step-upload"),
  character: document.getElementById("step-character"),
  choices: document.getElementById("step-choices"),
  result: document.getElementById("step-result")
};

const state = {
  photoImage: null,
  character: null,
  personality: null,
  world: null
};

const characterSettings = {
  elephant: {
    color: "#9ec7ff",
    earColor: "#b8daff",
    faceArea: { x: 210, y: 190, w: 100, h: 120 }
  },
  fox: {
    color: "#ffb36b",
    earColor: "#ffcd8f",
    faceArea: { x: 210, y: 185, w: 100, h: 120 }
  }
};

const worldSettings = {
  forest: { sky: "#c2f7ff", ground: "#a8e6a3", accent: "#5bbd73" },
  castle: { sky: "#cce4ff", ground: "#f2d0ff", accent: "#a57cd9" },
  space: { sky: "#1b1b3a", ground: "#3a3a6e", accent: "#ffe066" }
};

function showStep(stepKey) {
  Object.values(steps).forEach((step) => step.classList.add("hidden"));
  steps[stepKey].classList.remove("hidden");
}

function setChoiceButtons(selector, key) {
  document.querySelectorAll(selector).forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(selector).forEach((btn) => btn.classList.remove("selected"));
      button.classList.add("selected");
      state[key] = button.dataset[key];
      updateNextButtons();
      renderResult();
    });
  });
}

function updateNextButtons() {
  toCharacter.disabled = !state.photoImage;
  toChoices.disabled = !state.character;
  toResult.disabled = !(state.personality && state.world);
}

// Handle photo upload and preview
photoInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      state.photoImage = img;
      photoPreview.src = img.src;
      photoPreview.classList.add("show");
      document.querySelector(".preview-placeholder").style.display = "none";
      updateNextButtons();
      renderResult();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

// Reset the photo (still no uploading or saving anywhere)
resetPhoto.addEventListener("click", () => {
  photoInput.value = "";
  state.photoImage = null;
  photoPreview.src = "";
  photoPreview.classList.remove("show");
  document.querySelector(".preview-placeholder").style.display = "block";
  updateNextButtons();
});

// Navigation buttons
const backToUpload = document.getElementById("backToUpload");
const backToCharacter = document.getElementById("backToCharacter");
const startOver = document.getElementById("startOver");

toCharacter.addEventListener("click", () => showStep("character"));
backToUpload.addEventListener("click", () => showStep("upload"));

toChoices.addEventListener("click", () => showStep("choices"));
backToCharacter.addEventListener("click", () => showStep("character"));

toResult.addEventListener("click", () => {
  showStep("result");
  renderResult();
});

startOver.addEventListener("click", () => {
  state.character = null;
  state.personality = null;
  state.world = null;
  document.querySelectorAll(".choice").forEach((btn) => btn.classList.remove("selected"));
  updateNextButtons();
  showStep("upload");
});

// Setup choice buttons
setChoiceButtons("button[data-character]", "character");
setChoiceButtons("button[data-personality]", "personality");
setChoiceButtons("button[data-world]", "world");

function drawBackground() {
  const world = worldSettings[state.world] || worldSettings.forest;
  ctx.fillStyle = world.sky;
  ctx.fillRect(0, 0, resultCanvas.width, resultCanvas.height);
  ctx.fillStyle = world.ground;
  ctx.fillRect(0, resultCanvas.height * 0.65, resultCanvas.width, resultCanvas.height * 0.35);

  // Friendly accent shapes
  ctx.fillStyle = world.accent;
  for (let i = 0; i < 6; i += 1) {
    ctx.beginPath();
    ctx.arc(60 + i * 80, 90, 16, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawElephant() {
  const settings = characterSettings.elephant;
  ctx.fillStyle = settings.color;
  ctx.beginPath();
  ctx.ellipse(260, 280, 160, 140, 0, 0, Math.PI * 2);
  ctx.fill();

  // Ears
  ctx.fillStyle = settings.earColor;
  ctx.beginPath();
  ctx.ellipse(120, 280, 80, 90, 0, 0, Math.PI * 2);
  ctx.ellipse(400, 280, 80, 90, 0, 0, Math.PI * 2);
  ctx.fill();

  // Trunk
  ctx.fillStyle = settings.color;
  ctx.beginPath();
  ctx.roundRect(235, 310, 50, 120, 24);
  ctx.fill();
}

function drawFox() {
  const settings = characterSettings.fox;
  ctx.fillStyle = settings.color;
  ctx.beginPath();
  ctx.ellipse(260, 280, 150, 130, 0, 0, Math.PI * 2);
  ctx.fill();

  // Ears
  ctx.fillStyle = settings.earColor;
  ctx.beginPath();
  ctx.moveTo(160, 170);
  ctx.lineTo(200, 70);
  ctx.lineTo(240, 170);
  ctx.closePath();
  ctx.moveTo(280, 170);
  ctx.lineTo(320, 70);
  ctx.lineTo(360, 170);
  ctx.closePath();
  ctx.fill();

  // Cheeks
  ctx.fillStyle = "#fff2e1";
  ctx.beginPath();
  ctx.ellipse(210, 310, 50, 40, 0, 0, Math.PI * 2);
  ctx.ellipse(310, 310, 50, 40, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawFaceBlend() {
  if (!state.photoImage || !state.character) return;
  const { faceArea } = characterSettings[state.character];

  // Clip the face into a soft oval
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(
    faceArea.x + faceArea.w / 2,
    faceArea.y + faceArea.h / 2,
    faceArea.w / 2,
    faceArea.h / 2,
    0,
    0,
    Math.PI * 2
  );
  ctx.clip();

  // Draw the photo with light transparency for a friendly look
  ctx.globalAlpha = 0.85;

  // Fit the image to the face area without stretching too much
  const scale = Math.max(faceArea.w / state.photoImage.width, faceArea.h / state.photoImage.height);
  const drawWidth = state.photoImage.width * scale;
  const drawHeight = state.photoImage.height * scale;
  const drawX = faceArea.x + (faceArea.w - drawWidth) / 2;
  const drawY = faceArea.y + (faceArea.h - drawHeight) / 2;
  ctx.drawImage(state.photoImage, drawX, drawY, drawWidth, drawHeight);
  ctx.restore();

  // Soft friendly highlight
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.ellipse(
    faceArea.x + faceArea.w / 2,
    faceArea.y + faceArea.h / 2,
    faceArea.w / 2,
    faceArea.h / 2,
    0,
    0,
    Math.PI * 2
  );
  ctx.stroke();
}

function drawEyesAndSmile() {
  ctx.fillStyle = "#2d2d2d";
  ctx.beginPath();
  ctx.arc(230, 270, 6, 0, Math.PI * 2);
  ctx.arc(290, 270, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#2d2d2d";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(260, 300, 30, 0, Math.PI);
  ctx.stroke();
}

function renderResult() {
  ctx.clearRect(0, 0, resultCanvas.width, resultCanvas.height);
  drawBackground();

  if (state.character === "elephant") {
    drawElephant();
  } else if (state.character === "fox") {
    drawFox();
  } else {
    // Prompt the child to pick a character
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 26px Trebuchet MS";
    ctx.fillText("Pick a character!", 140, 260);
    return;
  }

  drawFaceBlend();
  drawEyesAndSmile();

  // Story text
  if (state.personality && state.world) {
    storyText.textContent = `This is a ${state.personality} ${state.character} exploring the ${state.world}.`;
  } else {
    storyText.textContent = "";
  }
}

updateNextButtons();
renderResult();
