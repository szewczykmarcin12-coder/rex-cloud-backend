// REX Cloud - API dla kalendarza/zmian
// Endpoint: /api/calendar

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_OWNER = process.env.GITHUB_OWNER || 'twoj-username';
  const GITHUB_REPO = process.env.GITHUB_REPO || 'rex-cloud-data';
  const FILE_PATH = 'calendar.ics';

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ success: false, error: 'GITHUB_TOKEN not configured' });
  }

  const githubAPI = async (method, endpoint, body = null) => {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${endpoint}`;
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (body) options.body = JSON.stringify(body);
    return await fetch(url, options);
  };

  try {
    // GET - pobierz kalendarz
    if (req.method === 'GET') {
      const response = await githubAPI('GET', `/contents/${FILE_PATH}`);
      
      if (!response.ok) {
        const error = await response.json();
        return res.status(500).json({ success: false, error: error.message });
      }

      const data = await response.json();
      const content = Buffer.from(data.content, 'base64').toString('utf-8');

      return res.status(200).json({ 
        success: true, 
        content: content,
        sha: data.sha 
      });
    }

    // POST - zapisz kalendarz
    if (req.method === 'POST') {
      const { content, sha, message } = req.body;

      if (!content || !sha) {
        return res.status(400).json({ success: false, error: 'Missing content or sha' });
      }

      const response = await githubAPI('PUT', `/contents/${FILE_PATH}`, {
        message: message || 'Update calendar',
        content: Buffer.from(content).toString('base64'),
        sha: sha
      });

      if (!response.ok) {
        const error = await response.json();
        return res.status(500).json({ success: false, error: error.message });
      }

      const data = await response.json();

      return res.status(200).json({ 
        success: true,
        sha: data.content.sha 
      });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });

  } catch (error) {
    console.error('Calendar API Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
