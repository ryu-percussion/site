// ==========================================
// E8シュミレーション/ソニフィケーション 
// ==========================================

let roots = [];
let edges = [];
let sliders = [];
let valDisplays = []; 
let planePairs = [];

let P_current = [[], []];
let P_init = [[], []];

// UI・アニメーションコントロール
let pointSizeSlider;
let lineOpacitySlider;
let radarSpeedSlider;
let isAnimating = false;
let targetAngles = []; 

// レーダー & オーディオ
let radarAngle = 0;
let prevRadarAngle = 0;
let audioCtx = null;
let masterCompressor = null;
let activeHits = [];

// ==========================================
// ml5.js HandPose用変数
// ==========================================
let video;
let handPose; 
let hands = [];
let globalScale = 100; // 点群のスケール
let targetGlobalScale = 100;
let gestureOpacity = 0.12; // 線の透明度
let targetGestureOpacity = 0.12;

function preload() {
  handPose = ml5.handPose();
}

function setup() {
  // HTML上の特定のコンテナにcanvasを生成
  let canvasContainer = document.getElementById('e8-canvas-container');
  let cWidth = canvasContainer ? canvasContainer.offsetWidth : windowWidth;
  let canvas = createCanvas(cWidth, 500);
  if (canvasContainer) {
    canvas.parent('e8-canvas-container');
  } else {
    canvas.parent(document.body);
  }

  // Webカメラのセットアップ
  video = createCapture(VIDEO);
  video.size(640, 480);
  video.hide();

  // カメラの映像から手の検出を開始
  handPose.detectStart(video, results => {
    hands = results;
  });

  generateE8System();

  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      planePairs.push([i, j]);
      targetAngles.push(0);
    }
  }

  initProjectionMatrices();
  setupUI();
}

function draw() {
  background(0); 

  // ==========================================
  // ジェスチャー入力の処理 (最新仕様)
  // ==========================================
  if (hands.length > 0) {
    for (let hand of hands) {
      let indexTip = hand.index_finger_tip;
      let thumbTip = hand.thumb_tip;
      let palm = hand.wrist;

      // 1. ピンチイン・アウト（親指と人差し指の距離）の計算
      let pinchDist = dist(indexTip.x, indexTip.y, thumbTip.x, thumbTip.y);

      // 距離をスケールと透明度にマッピング
      targetGlobalScale = map(pinchDist, 20, 200, 30, 400, true);
      targetGestureOpacity = map(pinchDist, 20, 200, 0.05, 1.0, true);

      // 2. 空間位置のマッピング (0〜360度)
      let mappedX = map(palm.x, 0, video.width, 0, 360);
      let mappedY = map(palm.y, 0, video.height, 0, 360);

      if (palm.x < video.width / 2) {
        // 左手
        targetAngles[0] = mappedX;
        targetAngles[13] = mappedY;
      } else {
        // 右手
        targetAngles[22] = mappedX;
        targetAngles[27] = mappedY;
      }
    }
  }

  // スケールと透明度を滑らかに補間
  globalScale = lerp(globalScale, targetGlobalScale, 0.1);
  gestureOpacity = lerp(gestureOpacity, targetGestureOpacity, 0.1);

  // ジェスチャーで操作する4つの特定平面の角度をUIスライダーに滑らかに反映
  [0, 13, 22, 27].forEach(idx => {
    let currentVal = sliders[idx].value();
    let nextVal = lerp(currentVal, targetAngles[idx], 0.1);
    sliders[idx].value(nextVal);
    valDisplays[idx].html(`${nextVal.toFixed(1)}°`);
  });

  // ==========================================
  // 自動アニメーションの処理
  // ==========================================
  if (isAnimating) {
    for (let i = 0; i < 28; i++) {
      if ([0, 13, 22, 27].includes(i)) continue;

      let currentVal = sliders[i].value();
      let targetVal = targetAngles[i];
      let nextVal = lerp(currentVal, targetVal, 0.002);
      sliders[i].value(nextVal);
      valDisplays[i].html(`${nextVal.toFixed(1)}°`);

      if (abs(nextVal - targetVal) < 1.0) {
        targetAngles[i] = random(0, 360);
      }
    }
  }

  translate(width / 2, height / 2);

  let radarDelta = 0;
  if (audioCtx && audioCtx.state === 'running') {
    prevRadarAngle = radarAngle;
    radarDelta = radarSpeedSlider.value(); 
    radarAngle = (radarAngle + radarDelta) % TWO_PI;

    stroke('rgba(0, 255, 255, 0.6)');
    strokeWeight(1.5);
    line(0, 0, cos(radarAngle) * 300, sin(radarAngle) * 300);
  }

  let angles = sliders.map(s => radians(s.value()));
  let projectedPoints = [];

  for (let i = 0; i < roots.length; i++) {
    let rv = [...roots[i]];
    for (let p = 0; p < planePairs.length; p++) {
      if (angles[p] !== 0) {
        rv = rotate8D(rv, planePairs[p][0], planePairs[p][1], angles[p]);
      }
    }

    let x = dotProduct(P_current[0], rv) * globalScale;
    let y = dotProduct(P_current[1], rv) * globalScale;
    let r = sqrt(x*x + y*y);
    let theta = (atan2(y, x) + TWO_PI) % TWO_PI;

    projectedPoints.push({ x, y, r, theta, vector: rv });
  }

  // エッジの描画
  let finalOpacity = max(lineOpacitySlider.value(), gestureOpacity);
  let lineAlpha = finalOpacity * 255;

  stroke(0, 240, 255, lineAlpha);
  strokeWeight(0.25); 
  beginShape(LINES);
  for (let i = 0; i < edges.length; i++) {
    let p1 = projectedPoints[edges[i].v1];
    let p2 = projectedPoints[edges[i].v2];
    vertex(p1.x, p1.y);
    vertex(p2.x, p2.y);
  }
  endShape();

  // レーダー判定と音のトリガー
  if (audioCtx && audioCtx.state === 'running') {
    for (let pt of projectedPoints) {
      if (pt.r < 10) continue;
      let diff = (radarAngle - pt.theta + TWO_PI) % TWO_PI;
      if (diff <= radarDelta) {
        triggerSound(pt.r, pt.vector);
        activeHits.push({ x: pt.x, y: pt.y, size: pointSizeSlider.value() * 2, alpha: 255 });
      }
    }
  }

  // 頂点の描画
  stroke(255);
  strokeWeight(pointSizeSlider.value());
  beginShape(POINTS);
  for (let pt of projectedPoints) {
    vertex(pt.x, pt.y);
  }
  endShape();

  // インスタレーション用フィードバック描画
  if (hands.length > 0) {
    noFill();
    for (let hand of hands) {
      let ix = map(hand.index_finger_tip.x, 0, video.width, -width/2, width/2);
      let iy = map(hand.index_finger_tip.y, 0, video.height, -height/2, height/2);
      let tx = map(hand.thumb_tip.x, 0, video.width, -width/2, width/2);
      let ty = map(hand.thumb_tip.y, 0, video.height, -height/2, height/2);

      stroke(0, 255, 255, 100);
      strokeWeight(2);
      ellipse(ix, iy, 12, 12);
      ellipse(tx, ty, 12, 12);

      stroke(255, 255, 255, 50);
      strokeWeight(1);
      line(ix, iy, tx, ty);
    }
  }

  // ヒットエフェクト
  noFill();
  for (let i = activeHits.length - 1; i >= 0; i--) {
    let h = activeHits[i];
    stroke(0, 255, 255, h.alpha);
    strokeWeight(1.5);
    ellipse(h.x, h.y, h.size, h.size);
    h.size += 2.0;
    h.alpha -= 10;
    if (h.alpha <= 0) activeHits.splice(i, 1);
  }
}

// ==========================================
// 数理・ロジック・音声群
// ==========================================
function generateE8System() {
  roots = [];
  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      for (let s1 of [-1, 1]) {
        for (let s2 of [-1, 1]) {
          let v = new Array(8).fill(0);
          v[i] = s1; v[j] = s2;
          roots.push(v);
        }
      }
    }
  }
  for (let i = 0; i < 256; i++) {
    let v = [];
    let minusCount = 0;
    for (let bit = 0; bit < 8; bit++) {
      let val = (i & (1 << bit)) ? -0.5 : 0.5;
      if (val < 0) minusCount++;
      v.push(val);
    }
    if (minusCount % 2 === 0) roots.push(v);
  }

  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      let d2 = 0;
      for (let k = 0; k < 8; k++) {
        let diff = roots[i][k] - roots[j][k];
        d2 += diff * diff;
      }
      if (abs(d2 - 2.0) < 0.01) edges.push({ v1: i, v2: j });
    }
  }
}

function initProjectionMatrices() {
  for (let n = 0; n < 8; n++) {
    P_init[0][n] = cos(n * Math.PI / 8);
    P_init[1][n] = sin(n * Math.PI / 8);
  }
  P_current = JSON.parse(JSON.stringify(P_init));
}

function rotate8D(v, p1, p2, angle) {
  let out = [...v];
  let c = cos(angle);
  let s = sin(angle);
  out[p1] = v[p1] * c - v[p2] * s;
  out[p2] = v[p1] * s + v[p2] * c;
  return out;
}

function dotProduct(v1, v2) {
  return v1.reduce((sum, val, i) => sum + val * v2[i], 0);
}

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterCompressor = audioCtx.createDynamicsCompressor();
    masterCompressor.threshold.value = -12;
    masterCompressor.knee.value = 30;
    masterCompressor.ratio.value = 12;
    masterCompressor.attack.value = 0.003;
    masterCompressor.release.value = 0.25;
    masterCompressor.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function triggerSound(radius, vector) {
  if (!audioCtx) return;

  let pitchBase = map(radius, 0, 300, 150, 800);
  let osc = audioCtx.createOscillator();
  let gainNode = audioCtx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(pitchBase, audioCtx.currentTime);

  let depth = abs(vector[6]) + abs(vector[7]);
  let decay = map(depth, 0, 1.5, 0.05, 0.4);

  gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
  gainNode.gain.linearRampToValueAtTime(0.2, audioCtx.currentTime + 0.005);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + decay);

  osc.connect(gainNode);
  gainNode.connect(masterCompressor);

  osc.start();
  osc.stop(audioCtx.currentTime + decay + 0.1);
}

function setupUI() {
  let masterContainer = createDiv();
  masterContainer.style('padding', '15px');
  masterContainer.style('background', '#111');
  masterContainer.style('color', '#fff');
  masterContainer.style('font-family', 'sans-serif');
  masterContainer.style('border-radius', '0 0 8px 8px');

  let uiContainer = document.getElementById('e8-ui-container');
  if (uiContainer) {
    masterContainer.parent('e8-ui-container');
  } else {
    masterContainer.parent(document.body);
  }

  let topPanel = createDiv();
  topPanel.style('display', 'flex');
  topPanel.style('flex-wrap', 'wrap');
  topPanel.style('gap', '20px');
  topPanel.style('margin-bottom', '20px');
  topPanel.style('align-items', 'center');
  topPanel.parent(masterContainer);

  let audioBtn = createButton('Audio Start');
  audioBtn.style('padding', '8px 16px');
  audioBtn.style('background', '#00f0ff');
  audioBtn.style('border', 'none');
  audioBtn.style('font-weight', 'bold');
  audioBtn.style('cursor', 'pointer');
  audioBtn.style('border-radius', '4px');
  audioBtn.mousePressed(() => {
    initAudio();
    audioBtn.html('Audio Active');
    audioBtn.style('background', '#33ff33');
  });
  audioBtn.parent(topPanel);

  let animateBtn = createButton('Random / Animate');
  animateBtn.style('padding', '8px 16px');
  animateBtn.style('background', '#ffffff');
  animateBtn.style('border', 'none');
  animateBtn.style('font-weight', 'bold');
  animateBtn.style('cursor', 'pointer');
  animateBtn.style('border-radius', '4px');
  animateBtn.mousePressed(() => {
    isAnimating = !isAnimating;
    if (isAnimating) {
      animateBtn.style('background', '#ff33aa');
      animateBtn.style('color', '#fff');
      for (let i = 0; i < 28; i++) {
        if (![0, 13, 22, 27].includes(i)) targetAngles[i] = random(0, 360);
      }
    } else {
      animateBtn.style('background', '#ffffff');
      animateBtn.style('color', '#000');
    }
  });
  animateBtn.parent(topPanel);

  let audioStopBtn = createButton('Audio Stop');
  audioStopBtn.style('padding', '8px 16px');
  audioStopBtn.style('background', '#ff3333'); 
  audioStopBtn.style('color', '#ffffff');
  audioStopBtn.style('border', 'none');
  audioStopBtn.style('font-weight', 'bold');
  audioStopBtn.style('cursor', 'pointer');
  audioStopBtn.style('border-radius', '4px');
  audioStopBtn.mousePressed(() => {
    if (audioCtx && audioCtx.state === 'running') {
      audioCtx.suspend(); 
      audioBtn.html('Audio Start');
      audioBtn.style('background', '#00f0ff');
    }
  });
  audioStopBtn.parent(topPanel);

  let resetBtn = createButton('Reset');
  resetBtn.style('padding', '8px 16px');
  resetBtn.style('background', '#ffffff');
  resetBtn.style('border', 'none');
  resetBtn.style('font-weight', 'bold');
  resetBtn.style('cursor', 'pointer');
  resetBtn.style('border-radius', '4px');
  resetBtn.mousePressed(() => {
    isAnimating = false;
    animateBtn.style('background', '#ffffff');
    animateBtn.style('color', '#000');
    for (let i = 0; i < 28; i++) {
      sliders[i].value(0); 
      valDisplays[i].html('0.0°');
      targetAngles[i] = 0; 
    }
    targetGlobalScale = 100;
    targetGestureOpacity = 0.12;
  });
  resetBtn.parent(topPanel);

  let styleCtrl = createDiv();
  styleCtrl.style('display', 'flex');
  styleCtrl.style('gap', '15px');
  styleCtrl.parent(topPanel);

  let pointWrapper = createDiv();
  pointWrapper.html('<span style="font-size:12px; margin-right:5px;">Point Size</span>');
  pointSizeSlider = createSlider(1, 10, 3.5, 0.1);
  pointSizeSlider.parent(pointWrapper);
  pointWrapper.parent(styleCtrl);

  let lineWrapper = createDiv();
  lineWrapper.html('<span style="font-size:12px; margin-right:5px;">Line Opacity</span>');
  lineOpacitySlider = createSlider(0, 1, 0.12, 0.01);
  lineOpacitySlider.parent(lineWrapper);
  lineWrapper.parent(styleCtrl);

  let radarSpeedWrapper = createDiv();
  radarSpeedWrapper.html('<span style="font-size:12px; margin-right:5px;">Radar Speed</span>');
  radarSpeedSlider = createSlider(0.001, 0.1, 0.015, 0.001);
  radarSpeedSlider.parent(radarSpeedWrapper);
  radarSpeedWrapper.parent(styleCtrl);

  let sliderGrid = createDiv();
  sliderGrid.style('display', 'grid');
  sliderGrid.style('grid-template-columns', 'repeat(auto-fill, minmax(130px, 1fr))');
  sliderGrid.style('gap', '10px');
  sliderGrid.style('max-height', '260px');
  sliderGrid.style('overflow-y', 'auto');
  sliderGrid.parent(masterContainer);

  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      let wrapper = createDiv();
      wrapper.style('color', '#888');
      wrapper.style('font-size', '11px');
      wrapper.style('font-family', 'monospace');

      let label = createSpan(`x${i+1}x${j+1}: `);
      label.parent(wrapper);

      let valDisplay = createSpan('0.0°');
      valDisplay.parent(wrapper);
      valDisplays.push(valDisplay);

      let slider = createSlider(0, 360, 0, 0.5);
      slider.style('width', '100%');
      slider.style('margin-top', '4px');
      slider.parent(wrapper);

      slider.input(() => {
        valDisplay.html(`${slider.value().toFixed(1)}°`);
      });

      sliders.push(slider);
      wrapper.parent(sliderGrid);
    }
  }
}

function windowResized() {
  let canvasContainer = document.getElementById('e8-canvas-container');
  let cWidth = canvasContainer ? canvasContainer.offsetWidth : windowWidth;
  resizeCanvas(cWidth, 500);
}
