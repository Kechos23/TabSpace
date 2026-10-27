// Render at the real 16px favicon grid, then scale by whole pixels for HiDPI.
// Two overlapping sheets: a tonal back and a framed front carrying our glyph.
export function spaceIconPixels(size, color, appearance) {
  const fill = color.match(/[a-f0-9]{2}/gi).map((hex) => parseInt(hex, 16));
  const contrast = appearance === "dark" ? [244, 248, 255] : [16, 35, 60];
  const edge = fill.map((channel, index) =>
    Math.round(channel * 0.62 + contrast[index] * 0.38),
  );
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = Math.floor((x * 16) / size),
        py = Math.floor((y * 16) / size);
      let rgb;
      if (px < 12 && py < 12) rgb = edge;
      if (px >= 3 && py >= 3) {
        rgb = fill;
        const sx = Math.floor(((px - 3) * 16) / 13),
          sy = Math.floor(((py - 3) * 16) / 13);
        if (
          (sx >= 5 && sx < 12 && sy >= 5 && sy < 7) ||
          (sx >= 5 && sx < 8 && sy >= 9 && sy < 12) ||
          (sx >= 10 && sx < 12 && sy >= 9 && sy < 12)
        )
          rgb = [255, 255, 255];
        if (px === 3 || px === 15 || py === 3 || py === 15) rgb = edge;
      }
      if (rgb) {
        const at = (y * size + x) * 4;
        data.set([...rgb, 255], at);
      }
    }
  return data;
}
