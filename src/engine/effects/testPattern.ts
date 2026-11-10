/**
 * a neutral test card: gray checkerboard with a small colored cross in every square.
 * straight lines and even squares make every warp, shake and color change easy to read.
 * used for the effect thumbnails.
 */
const CROSS_COLORS = ['#f0a030', '#ff4040', '#e020a0', '#9040ff', '#3050e0', '#30d0e0', '#30e060', '#a0e030'];

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawTestPattern(ctx: Ctx, width: number, height: number, squaresAcross = 12): void {
  const cell = width / squaresAcross;
  const rows = Math.ceil(height / cell);
  const arm = cell * 0.13;
  ctx.save();
  ctx.lineWidth = Math.max(1, cell * 0.035);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < squaresAcross; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#3c3c3c' : '#8c8c8c';
      ctx.fillRect(Math.floor(x * cell), Math.floor(y * cell), Math.ceil(cell), Math.ceil(cell));
      const cx = (x + 0.5) * cell;
      const cy = (y + 0.5) * cell;
      ctx.strokeStyle = CROSS_COLORS[(x + y * 7) % CROSS_COLORS.length]!;
      ctx.beginPath();
      ctx.moveTo(cx - arm, cy);
      ctx.lineTo(cx + arm, cy);
      ctx.moveTo(cx, cy - arm);
      ctx.lineTo(cx, cy + arm);
      ctx.stroke();
    }
  }
  ctx.restore();
}
