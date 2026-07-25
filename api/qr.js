/**
 * Room invite QR, as an SVG. On a single-origin deploy the request Host header is the
 * address players should land on, so the QR is rebuilt from it (LAN IP / custom domain
 * included). PUBLIC_ORIGIN can override that if the frontend ever lives elsewhere.
 */
import QRCode from 'qrcode';

const CODE_RE = /^[A-Z0-9]{4}$/;
const HOST_RE = /^[a-zA-Z0-9.\-:[\]]{1,255}$/; // hostname[:port], incl. bracketed IPv6
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');

function text(res, status, body) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.status(status).send(body);
}

export default async function handler(req, res) {
  const code = String(req.query.room || '').toUpperCase();
  if (!CODE_RE.test(code)) return text(res, 400, 'Invalid room code.');

  let base;
  if (PUBLIC_ORIGIN) {
    base = PUBLIC_ORIGIN;
  } else {
    const host = req.headers.host;
    if (!host || !HOST_RE.test(host)) return text(res, 400, 'Bad host.');
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
    base = `${proto}://${host}`;
  }
  const url = `${base}/?room=${code}`;

  try {
    const svg = await QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      color: { dark: '#0b0e1a', light: '#ffffff' },
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(svg);
  } catch (err) {
    console.error('[qr] generation failed:', err.message);
    return text(res, 500, 'QR generation failed.');
  }
}
