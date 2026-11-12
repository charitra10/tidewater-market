// Item names and small hand-drawn icons (inline SVG, so there are no image files).

export const TOKENS = ["kelp", "driftwood", "ore", "pearl", "rope", "pickaxe", "boat", "beacon"];

export const NAMES = {
  kelp: "Kelp",
  driftwood: "Driftwood",
  ore: "Ore",
  pearl: "Pearl",
  rope: "Rope",
  pickaxe: "Pickaxe",
  boat: "Boat",
  beacon: "Beacon lens",
};

export const BLURB = {
  kelp: "Washes up on the shore.",
  driftwood: "Sun-bleached and sturdy.",
  ore: "Hacked out of the cliffs.",
  pearl: "From the reef, if you're lucky.",
  pickaxe: "Lets you mine the cliffs. It can break.",
  boat: "Lets you row out to the reef.",
  beacon: "The heart of the lighthouse.",
};

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">${body}</svg>`;

export const ICONS = {
  kelp: svg(
    `<path d="M12 22C8 18 15 15 11 11C8 8 13 5 12 2" fill="none" stroke="#2f7d4f" stroke-width="3.2" stroke-linecap="round"/>
     <path d="M11 16c-3 0-5-1-6-3 3-1 5 0 6 2zM12 9c3 0 5-1 6-3-3-1-5 0-6 2z" fill="#4fa56b"/>`,
  ),
  driftwood: svg(
    `<rect x="2.5" y="8.5" width="19" height="7.5" rx="3.7" fill="#b08a5e" transform="rotate(-14 12 12)"/>
     <ellipse cx="19.6" cy="10.3" rx="2.1" ry="3.5" fill="#d9bc93" transform="rotate(-14 19.6 10.3)"/>
     <path d="M6 14.6l8-2M8 11.8l5-1.2" stroke="#8a6a45" stroke-width="1" stroke-linecap="round"/>`,
  ),
  ore: svg(
    `<path d="M4 17l2-8 6-4 7 3 2 8-5 4H8z" fill="#7d7f8a"/>
     <path d="M6 9l6-4 7 3-6 3z" fill="#a4a7b3"/>
     <circle cx="10" cy="14" r="1.6" fill="#f0b23c"/><circle cx="15.5" cy="15.5" r="1.2" fill="#f0b23c"/><circle cx="14" cy="10.5" r="1" fill="#ffd97a"/>`,
  ),
  pearl: svg(
    `<path d="M2.5 13.5c0 4.5 4.2 7 9.5 7s9.5-2.5 9.5-7z" fill="#e6b8a8"/>
     <path d="M2.5 13.5c2-6 5.5-9.5 9.5-9.5s7.5 3.5 9.5 9.5z" fill="#f3d3c6"/>
     <path d="M12 4v9.5M7 6.5l3 7M17 6.5l-3 7" stroke="#d9a593" stroke-width="1"/>
     <circle cx="12" cy="14.5" r="4" fill="#fdfdf8" stroke="#cfd3d6" stroke-width=".6"/><circle cx="10.6" cy="13.1" r="1.1" fill="#fff"/>`,
  ),
  rope: svg(
    `<ellipse cx="12" cy="13" rx="8.5" ry="6" fill="none" stroke="#c9a56a" stroke-width="3.4"/>
     <ellipse cx="12" cy="13" rx="4" ry="2.4" fill="none" stroke="#a9854d" stroke-width="2.4"/>
     <path d="M18 8l3-4" stroke="#c9a56a" stroke-width="3" stroke-linecap="round"/>`,
  ),
  pickaxe: svg(
    `<path d="M6 20L17 7" stroke="#9a6b3f" stroke-width="3" stroke-linecap="round"/>
     <path d="M8 4c5-1.5 10 0 13 5-3-2-6-2.5-9-1.5z" fill="#8f96a3"/>
     <path d="M8 4c2 1.5 3.3 3 4 3.5" stroke="#6d7480" stroke-width="1.2" fill="none"/>`,
  ),
  boat: svg(
    `<path d="M2 15h20l-3 5H5z" fill="#9a6b3f"/>
     <path d="M11.5 3v12" stroke="#6b4a2b" stroke-width="1.6"/>
     <path d="M12.6 4l7 9h-7z" fill="#f4ead2"/><path d="M10.4 6l-5 7h5z" fill="#e6d7b4"/>`,
  ),
  beacon: svg(
    `<circle cx="12" cy="12" r="9.5" fill="#c08a2c"/>
     <circle cx="12" cy="12" r="7.3" fill="#ffe08a"/>
     <circle cx="12" cy="12" r="4.4" fill="none" stroke="#fff6cf" stroke-width="1.6"/>
     <circle cx="12" cy="12" r="1.8" fill="#fffbe8"/>
     <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" stroke="#8c6218" stroke-width="1.4"/>`,
  ),
  coin: svg(
    `<circle cx="12" cy="12" r="9" fill="#e2a93b"/><circle cx="12" cy="12" r="6.6" fill="#f6cf6b"/>
     <path d="M12 7.5v9M9.5 9.8c0-1.6 5-1.6 5 0 0 2.2-5 1.2-5 3.6 0 1.7 5 1.7 5 0" fill="none" stroke="#b47d1c" stroke-width="1.3" stroke-linecap="round"/>`,
  ),
  energy: svg(`<path d="M13.5 2L5 13.5h5.5L9.5 22 19 9.5h-6z" fill="#f2b632" stroke="#c48a16" stroke-width=".8" stroke-linejoin="round"/>`),
};

/// The same icons as images, for drawing on the canvas.
const cache = {};
export function iconImage(name) {
  if (!cache[name]) {
    const img = new Image();
    img.src = "data:image/svg+xml," + encodeURIComponent(ICONS[name]);
    cache[name] = img;
  }
  return cache[name];
}
