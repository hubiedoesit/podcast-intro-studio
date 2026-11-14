// The show's identity, read from brand.json at the repo root. Everything has a default, so the pipeline runs
// on a fresh clone: League Gothic ships with HyperFrames and needs no font file.
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_BRAND = {
  show: "Your Show",
  // the words every take of the intro ends on ("welcome to the show"); new-episode.mjs splits takes on them
  ending: "",
  hostRole: "Host",
  colors: { ink: "#15202B", accent: "#FF6B35", cream: "#F6EFE6", paper: "#F7F5F2" },
  // files: { "700": "MyFont-Bold.otf" } in intro-template/assets/fonts/. Leave empty for a font HyperFrames bundles.
  font: { family: "League Gothic", files: {} },
  // a PNG in intro-template/assets/brand/, used by the optional end card and by tools/make-opener.mjs
  logo: null,
};

export function loadBrand(root) {
  let user = {};
  const file = path.join(root, "brand.json");
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    ...DEFAULT_BRAND, ...user,
    colors: { ...DEFAULT_BRAND.colors, ...user.colors },
    font: { ...DEFAULT_BRAND.font, ...user.font },
  };
}

// @font-face rules for the brand's own font files; nothing when the family is one HyperFrames bundles
export const fontFaces = (brand, dir = "assets/fonts/") =>
  Object.entries(brand.font.files ?? {}).map(([weight, file]) =>
    `@font-face { font-family: "${brand.font.family}"; font-weight: ${weight}; src: url("${dir}${file}"); }`).join("\n      ");

export const fontStack = (brand) => `"${brand.font.family}", "League Gothic", sans-serif`;
