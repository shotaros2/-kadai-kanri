const ALLOWED_ORIGIN = 'kadai-kanri-zeta.vercel.app';

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send('url required');

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).send('invalid url');
  }

  if (parsed.hostname !== ALLOWED_ORIGIN) {
    return res.status(403).send('forbidden');
  }

  try {
    const r = await fetch(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`);
    const short = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(short.trim());
  } catch {
    res.status(500).send('error');
  }
}
