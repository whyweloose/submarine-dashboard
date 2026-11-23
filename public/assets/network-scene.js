const THREE_URL = "./vendor/three.module.js";

async function createScene() {
  const THREE = await import(THREE_URL);
  const canvas = document.querySelector("#networkScene");
  const host = canvas?.parentElement;
  if (!canvas || !host) return;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 40);
  camera.position.set(0, 0, 7.3);
  const network = new THREE.Group();
  scene.add(network);

  const globe = new THREE.Group();
  network.add(globe);

  const shell = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.28, 2),
    new THREE.MeshBasicMaterial({ color: 0x78baff, wireframe: true, transparent: true, opacity: 0.48 })
  );
  globe.add(shell);

  const innerSphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.12, 28, 20),
    new THREE.MeshBasicMaterial({ color: 0x102b4b, transparent: true, opacity: 0.66, depthWrite: false })
  );
  globe.add(innerSphere);

  const innerGrid = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.94, 1),
    new THREE.MeshBasicMaterial({ color: 0x6ce1e8, wireframe: true, transparent: true, opacity: 0.2 })
  );
  globe.add(innerGrid);

  const points = [];
  const pointCount = 58;
  for (let index = 0; index < pointCount; index++) {
    const y = 1 - (index / (pointCount - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const angle = Math.PI * (3 - Math.sqrt(5)) * index;
    points.push(new THREE.Vector3(Math.cos(angle) * radius * 1.52, y * 1.52, Math.sin(angle) * radius * 1.52));
  }

  const linePositions = [];
  for (let left = 0; left < points.length; left++) {
    for (let right = left + 1; right < points.length; right++) {
      if (points[left].distanceTo(points[right]) < 0.7) {
        linePositions.push(...points[left].toArray(), ...points[right].toArray());
      }
    }
  }
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
  const lineMaterial = new THREE.LineBasicMaterial({ color: 0x78baff, transparent: true, opacity: 0.26 });
  globe.add(new THREE.LineSegments(lineGeometry, lineMaterial));

  const pointGeometry = new THREE.BufferGeometry().setFromPoints(points);
  const pointColors = new Float32Array(pointCount * 3);
  const pointMaterial = new THREE.PointsMaterial({ vertexColors: true, size: 0.075, transparent: true, opacity: 0.96, sizeAttenuation: true });
  const pointCloud = new THREE.Points(pointGeometry, pointMaterial);
  globe.add(pointCloud);

  const core = new THREE.Group();
  const coreFill = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.35, 1),
    new THREE.MeshBasicMaterial({ color: 0x6ce1e8, transparent: true, opacity: 0.8 })
  );
  const coreWire = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.47, 1),
    new THREE.MeshBasicMaterial({ color: 0xd8f3ff, wireframe: true, transparent: true, opacity: 0.74 })
  );
  core.add(coreFill, coreWire);
  globe.add(core);

  const rings = new THREE.Group();
  const ringData = [
    { radius: 1.92, tube: 0.009, color: 0x6ce1e8, opacity: 0.78, rotation: [1.08, 0.18, -0.42] },
    { radius: 2.08, tube: 0.006, color: 0xb9a3ff, opacity: 0.62, rotation: [0.3, 1.12, 0.2] },
    { radius: 1.78, tube: 0.005, color: 0x78baff, opacity: 0.44, rotation: [1.44, 0.52, 0.68] },
  ];
  for (const item of ringData) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(item.radius, item.tube, 6, 180),
      new THREE.MeshBasicMaterial({ color: item.color, transparent: true, opacity: item.opacity })
    );
    ring.rotation.set(...item.rotation);
    rings.add(ring);
  }
  network.add(rings);

  const satelliteGeometry = new THREE.SphereGeometry(0.055, 12, 10);
  const satellites = [
    { angle: 0.4, height: 0.48, radius: 2.12, color: 0x6ce1e8 },
    { angle: 2.65, height: -0.32, radius: 1.98, color: 0xb9a3ff },
    { angle: 4.8, height: 0.14, radius: 2.2, color: 0x78baff },
  ].map((item) => {
    const material = new THREE.MeshBasicMaterial({ color: item.color, toneMapped: false });
    const mesh = new THREE.Mesh(satelliteGeometry, material);
    network.add(mesh);
    return { ...item, mesh };
  });

  const applyTheme = () => {
    const light = document.documentElement.dataset.theme === "light";
    const palette = light
      ? { shell: 0x4b8dca, sphere: 0xdceafa, grid: 0x38899a, line: 0x478acb, core: 0x2d80c5, wire: 0x286da9, nodes: [0x347fc9, 0x168c9b, 0x7356c4] }
      : { shell: 0x78baff, sphere: 0x102b4b, grid: 0x6ce1e8, line: 0x78baff, core: 0x6ce1e8, wire: 0xd8f3ff, nodes: [0x78baff, 0x6ce1e8, 0xb9a3ff] };
    shell.material.color.setHex(palette.shell);
    innerSphere.material.color.setHex(palette.sphere);
    innerGrid.material.color.setHex(palette.grid);
    lineMaterial.color.setHex(palette.line);
    coreFill.material.color.setHex(palette.core);
    coreWire.material.color.setHex(palette.wire);
    for (let index = 0; index < pointCount; index++) {
      const color = new THREE.Color(palette.nodes[index % palette.nodes.length]);
      color.toArray(pointColors, index * 3);
    }
    pointGeometry.setAttribute("color", new THREE.BufferAttribute(pointColors, 3));
    pointGeometry.attributes.color.needsUpdate = true;
  };
  applyTheme();
  window.addEventListener("submarine-themechange", applyTheme);
  let loadPercent = 0;
  window.addEventListener("submarine-load-update", (event) => {
    const value = Number(event.detail?.loadPercent);
    loadPercent = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  });

  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.position.z = width <= 112 ? 9.5 : width <= 160 ? 8.5 : 7.3;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  let pointerX = 0;
  let pointerY = 0;
  host.addEventListener("pointermove", (event) => {
    const rect = host.getBoundingClientRect();
    pointerX = ((event.clientX - rect.left) / rect.width - 0.5) * 0.24;
    pointerY = ((event.clientY - rect.top) / rect.height - 0.5) * 0.2;
  });
  host.addEventListener("pointerleave", () => { pointerX = 0; pointerY = 0; });

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clock = new THREE.Clock();
  let frame = null;
  function render() {
    frame = null;
    const elapsed = clock.getElapsedTime();
    if (!reduceMotion) {
      network.rotation.y += 0.0018;
      network.rotation.x += (pointerY - network.rotation.x) * 0.018;
      network.rotation.z += (pointerX - network.rotation.z) * 0.018;
      globe.rotation.y += 0.0012;
      core.rotation.y = elapsed * 0.32;
      core.rotation.x = Math.sin(elapsed * 0.38) * 0.18;
      const loadPulse = Math.min(1, Math.sqrt(loadPercent / 10));
      const pulse = 1 + (0.025 + loadPulse * 0.12) * Math.sin(elapsed * (2.2 + loadPulse * 4));
      core.scale.setScalar(pulse);
      coreFill.material.opacity = 0.68 + loadPulse * 0.25;
      rings.rotation.y = Math.sin(elapsed * 0.24) * 0.08;
      satellites.forEach((item, index) => {
        const angle = item.angle + elapsed * (index % 2 ? -0.12 : 0.12);
        item.mesh.position.set(Math.cos(angle) * item.radius, item.height + Math.sin(elapsed + index) * 0.08, Math.sin(angle) * item.radius);
      });
    }
    renderer.render(scene, camera);
    if (host.classList.contains("scene-fallback")) {
      window.SubmarineFallbackScene?.stop();
      host.classList.remove("scene-fallback");
    }
    host.classList.add("is-rendered");
    if (!reduceMotion && !document.hidden) frame = requestAnimationFrame(render);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    } else if (!document.hidden && !reduceMotion && frame === null) {
      frame = requestAnimationFrame(render);
    }
  });
  render();
}

createScene().catch((error) => {
  window.SubmarineFallbackScene?.start();
  console.error("Submarine 3D scene could not initialize", error);
});
