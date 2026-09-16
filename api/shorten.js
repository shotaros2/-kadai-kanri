export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send('url required');
  try {
    const r = await fetch(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`);
    const short = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(short.trim());
  } catch {
    res.status(500).send('error');
  }
}
