import QRCode from 'qrcode';

const DEEP_LINK_BASE = 'https://ashral-web.vercel.app/join';

const MARGIN = 3; // quiet zone in modules
const WHITE  = '\x1b[97m'; // bright white
const RESET  = '\x1b[0m';

/**
 * Renders the QR using half-block characters (▀ ▄ █).
 * Two QR rows are packed into one terminal row, so each module becomes
 * a perfect square: 1 char wide × ½ char tall × 2:1 terminal aspect ratio = 1:1.
 * Colors are inverted (white on dark) for dark terminals.
 */
function renderTerminalQr(url: string): void {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const { data, size } = qr.modules;

  const total = size + MARGIN * 2;

  function isDark(row: number, col: number): boolean {
    const r = row - MARGIN;
    const c = col - MARGIN;
    if (r < 0 || r >= size || c < 0 || c >= size) return false;
    return data[r * size + c] === 1;
  }

  const rows: string[] = [];

  for (let row = 0; row < total; row += 2) {
    let line = '';
    for (let col = 0; col < total; col++) {
      const top    = isDark(row, col);
      const bottom = (row + 1 < total) ? isDark(row + 1, col) : false;

      // Inverted: dark QR module → white glyph, light → terminal background
      if (top && bottom)       line += `${WHITE}█${RESET}`;
      else if (top && !bottom) line += `${WHITE}▀${RESET}`;
      else if (!top && bottom) line += `${WHITE}▄${RESET}`;
      else                     line += ' ';
    }
    rows.push(line);
  }

  // Border — total chars wide = total modules (1 char each) + 2 padding spaces each side
  const innerWidth = total + 4;
  const top    = '  ╭' + '─'.repeat(innerWidth) + '╮';
  const bottom = '  ╰' + '─'.repeat(innerWidth) + '╯';

  process.stderr.write(top + '\n');
  for (const row of rows) {
    process.stderr.write(`  │  ${row}  │\n`);
  }
  process.stderr.write(bottom + '\n');
}

export function showSessionQr(sessionId: string, sessionName?: string): void {
  const url   = `${DEEP_LINK_BASE}/${sessionId}`;
  const label = sessionName ? `"${sessionName}"` : sessionId;

  process.stderr.write(`\n  Scan with Ashral app → ${label}\n\n`);
  renderTerminalQr(url);
  process.stderr.write(`\n  ${url}\n\n`);
}
