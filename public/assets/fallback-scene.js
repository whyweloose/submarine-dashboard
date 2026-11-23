(() => {
  const host = document.querySelector(".scene-wrap");
  const canvas = document.querySelector("#networkSceneFallback");
  if (!host || !canvas) return;

  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return;

  const points = [];
  const pointCount = 58;
  for (let index = 0; index < pointCount; index++) {
    const y = 1 - (index / (pointCount - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const angle = Math.PI * (3 - Math.sqrt(5)) * index;
    points.push({ x: Math.cos(angle) * radius * 1.32, y: y * 1.32, z: Math.sin(angle) * radius * 1.32 });
  }

  const links = [];
  for (let left = 0; left < points.length; left++) {
    for (let right = left + 1; right < points.length; right++) {
      const dx = points[left].x - points[right].x;
      const dy = points[left].y - points[right].y;
      const dz = points[left].z - points[right].z;
      if (dx * dx + dy * dy + dz * dz < 0.58) links.push([left, right]);
    }
  }

  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let active = false;
  let animationFrame = 0;
  let startedAt = 0;
  let loadPercent = 0;
  let pointerX = 0;
  let pointerY = 0;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function resize() {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    width = rect.width;
    height = rect.height;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    draw(performance.now());
  }

  function project(point, elapsed) {
    const yaw = elapsed * 0.00016 + pointerX;
    const pitch = Math.sin(elapsed * 0.00012) * 0.14 + pointerY;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const x = point.x * cosYaw + point.z * sinYaw;
    const z = -point.x * sinYaw + point.z * cosYaw;
    const y = point.y * cosPitch - z * sinPitch;
    const depth = point.y * sinPitch + z * cosPitch;
    const perspective = 3.9 / (3.9 - depth * 0.43);
    const radius = Math.min(width, height) * 0.31;
    return {
      x: width * 0.5 + x * radius * perspective,
      y: height * 0.5 + y * radius * perspective,
      depth,
      perspective,
    };
  }

  function rotatePoint(point, xAngle, yAngle, zAngle) {
    const cosX = Math.cos(xAngle);
    const sinX = Math.sin(xAngle);
    const cosY = Math.cos(yAngle);
    const sinY = Math.sin(yAngle);
    const cosZ = Math.cos(zAngle);
    const sinZ = Math.sin(zAngle);
    const y = point.y * cosX - point.z * sinX;
    const z = point.y * sinX + point.z * cosX;
    const x = point.x * cosY + z * sinY;
    const rotatedZ = -point.x * sinY + z * cosY;
    return { x: x * cosZ - y * sinZ, y: x * sinZ + y * cosZ, z: rotatedZ };
  }

  function palette() {
    return document.documentElement.dataset.theme === "light"
      ? { shell: "75,141,202", cyan: "36,145,157", violet: "117,87,192", core: "46,127,194", white: "237,246,255" }
      : { shell: "120,186,255", cyan: "108,225,232", violet: "185,163,255", core: "108,225,232", white: "220,243,255" };
  }

  function drawRing(elapsed, colors, radius, tilt, phase, opacity) {
    const segments = 144;
    const rotation = elapsed * 0.00012 + phase;
    const near = [];
    const far = [];
    let previous = null;
    let previousNear = false;
    for (let index = 0; index <= segments; index++) {
      const angle = (index / segments) * Math.PI * 2 + rotation;
      const point = rotatePoint(
        { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: 0 },
        tilt[0],
        tilt[1],
        tilt[2]
      );
      const projected = project(point, elapsed);
      const isNear = projected.depth >= 0;
      const target = isNear ? near : far;
      if (previous && previousNear === isNear) {
        target.push([previous, projected]);
      } else if (previous) {
        (previousNear ? near : far).push([previous, previous]);
      }
      previous = projected;
      previousNear = isNear;
    }
    for (const [segmentsToDraw, alpha] of [[far, opacity * 0.36], [near, opacity]]) {
      context.beginPath();
      for (const [from, to] of segmentsToDraw) {
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
      }
      context.strokeStyle = `rgba(${colors}, ${alpha})`;
      context.lineWidth = 1.15;
      context.stroke();
    }
  }

  function draw(now) {
    if (!width || !height) return;
    const elapsed = reduceMotion ? 0 : now - startedAt;
    const colors = palette();
    const intensity = Math.min(1, Math.sqrt(loadPercent / 10));
    const pulse = 1 + (0.025 + intensity * 0.12) * Math.sin(elapsed * (0.0022 + intensity * 0.004));
    context.clearRect(0, 0, width, height);

    drawRing(elapsed, colors.violet, 1.8, [0.32, 1.06, 0.28], 2.5, 0.64);
    drawRing(elapsed, colors.cyan, 1.96, [1.1, 0.18, -0.42], 0.5, 0.76);
    drawRing(elapsed, colors.shell, 1.7, [1.42, 0.54, 0.66], 4.4, 0.48);

    const projected = points.map((point) => project(point, elapsed));
    context.lineWidth = 0.72;
    context.strokeStyle = `rgba(${colors.shell}, 0.22)`;
    context.beginPath();
    for (const [fromIndex, toIndex] of links) {
      const from = projected[fromIndex];
      const to = projected[toIndex];
      if (Math.abs(from.depth - to.depth) > 1.25) continue;
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
    }
    context.stroke();

    const shellRadius = Math.min(width, height) * 0.31;
    const shellGlow = context.createRadialGradient(
      width * 0.5 - shellRadius * 0.28,
      height * 0.5 - shellRadius * 0.38,
      shellRadius * 0.04,
      width * 0.5,
      height * 0.5,
      shellRadius * 1.12
    );
    shellGlow.addColorStop(0, `rgba(${colors.core}, 0.22)`);
    shellGlow.addColorStop(0.65, `rgba(${colors.shell}, 0.08)`);
    shellGlow.addColorStop(1, `rgba(${colors.shell}, 0)`);
    context.fillStyle = shellGlow;
    context.beginPath();
    context.arc(width * 0.5, height * 0.5, shellRadius * 1.12, 0, Math.PI * 2);
    context.fill();

    projected.forEach((point, index) => {
      const size = (1.5 + ((index * 7) % 10) / 6) * point.perspective;
      const nodeColor = index % 3 === 0 ? colors.violet : index % 3 === 1 ? colors.cyan : colors.shell;
      context.beginPath();
      context.fillStyle = `rgba(${nodeColor}, ${0.42 + Math.max(0, point.depth) * 0.24})`;
      context.arc(point.x, point.y, size, 0, Math.PI * 2);
      context.fill();
    });

    const coreRadius = Math.min(width, height) * 0.078 * pulse;
    const glow = context.createRadialGradient(width * 0.5, height * 0.5, coreRadius * 0.18, width * 0.5, height * 0.5, coreRadius * (3.8 + intensity));
    glow.addColorStop(0, `rgba(${colors.white}, ${0.9 - intensity * 0.12})`);
    glow.addColorStop(0.22, `rgba(${colors.cyan}, ${0.66 + intensity * 0.22})`);
    glow.addColorStop(1, `rgba(${colors.cyan}, 0)`);
    context.fillStyle = glow;
    context.beginPath();
    context.arc(width * 0.5, height * 0.5, coreRadius * (3.8 + intensity), 0, Math.PI * 2);
    context.fill();

    context.save();
    context.translate(width * 0.5, height * 0.5);
    context.rotate(elapsed * 0.00025);
    context.scale(pulse, pulse);
    context.beginPath();
    context.moveTo(0, -coreRadius * 1.75);
    context.lineTo(coreRadius * 0.92, 0);
    context.lineTo(0, coreRadius * 1.75);
    context.lineTo(-coreRadius * 0.92, 0);
    context.closePath();
    context.fillStyle = `rgba(${colors.cyan}, 0.68)`;
    context.fill();
    context.strokeStyle = `rgba(${colors.white}, ${0.85 + intensity * 0.14})`;
    context.lineWidth = 1.1;
    context.stroke();
    context.restore();

    const satellites = [
      { angle: elapsed * 0.00017 + 0.5, radius: 2.02, height: 0.28, color: colors.cyan },
      { angle: elapsed * -0.00013 + 2.7, radius: 1.92, height: -0.25, color: colors.violet },
      { angle: elapsed * 0.00015 + 4.6, radius: 2.15, height: 0.1, color: colors.shell },
    ];
    for (const satellite of satellites) {
      const point = project({
        x: Math.cos(satellite.angle) * satellite.radius,
        y: satellite.height,
        z: Math.sin(satellite.angle) * satellite.radius,
      }, elapsed);
      context.beginPath();
      context.fillStyle = `rgba(${satellite.color}, 0.96)`;
      context.arc(point.x, point.y, 2.8 * point.perspective, 0, Math.PI * 2);
      context.fill();
    }

  }

  function animate(now) {
    if (!active || document.hidden) return;
    draw(now);
    animationFrame = requestAnimationFrame(animate);
  }

  function start() {
    if (active) return;
    active = true;
    startedAt = performance.now();
    host.classList.add("scene-fallback");
    resize();
    if (!reduceMotion) animationFrame = requestAnimationFrame(animate);
  }

  function stop() {
    active = false;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  }

  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(resize);
    observer.observe(host);
  } else {
    window.addEventListener("resize", resize);
  }
  host.addEventListener("pointermove", (event) => {
    const rect = host.getBoundingClientRect();
    pointerX = ((event.clientX - rect.left) / rect.width - 0.5) * 0.2;
    pointerY = ((event.clientY - rect.top) / rect.height - 0.5) * 0.15;
  });
  host.addEventListener("pointerleave", () => { pointerX = 0; pointerY = 0; });
  window.addEventListener("submarine-load-update", (event) => {
    const value = Number(event.detail?.loadPercent);
    loadPercent = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  });
  window.addEventListener("submarine-themechange", () => {
    if (active) draw(performance.now());
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (host.classList.contains("scene-fallback")) start();
  });

  window.SubmarineFallbackScene = { start, stop };
  window.addEventListener("load", () => {
    window.setTimeout(() => {
      if (!host.classList.contains("is-rendered")) start();
    }, 2500);
  }, { once: true });
})();
