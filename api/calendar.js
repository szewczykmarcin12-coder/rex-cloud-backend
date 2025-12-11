// api/calendar.js
// Backend API for REX Cloud - synchronizacja kalendarza z GitHub

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Konfiguracja GitHub - pobierana z Environment Variables
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO_OWNER = process.env.REPO_OWNER || 'marcin-12';
  const REPO_NAME = process.env.REPO_NAME || 'rex-calendar';
  const FILE_PATH = process.env.FILE_PATH || 'kalendarz.ics';

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GitHub token not configured' });
  }

  const githubApiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;

  try {
    // GET - Pobierz kalendarz z GitHub
    if (req.method === 'GET') {
      const response = await fetch(githubApiUrl, {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'REX-Cloud-Backend'
        }
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('GitHub API error:', error);
        return res.status(response.status).json({ error: 'Failed to fetch calendar from GitHub' });
      }

      const data = await response.json();
      
      // Dekoduj zawartość z base64
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      
      return res.status(200).json({
        success: true,
        content: content,
        sha: data.sha, // Potrzebne do aktualizacji
        lastModified: data.sha
      });
    }

    // POST - Zapisz kalendarz do GitHub
    if (req.method === 'POST') {
      const { content, sha, message } = req.body;

      if (!content) {
        return res.status(400).json({ error: 'Content is required' });
      }

      // Najpierw pobierz aktualny SHA jeśli nie podano
      let currentSha = sha;
      if (!currentSha) {
        const getResponse = await fetch(githubApiUrl, {
          headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'REX-Cloud-Backend'
          }
        });
        
        if (getResponse.ok) {
          const getData = await getResponse.json();
          currentSha = getData.sha;
        }
      }

      // Zakoduj zawartość do base64
      const encodedContent = Buffer.from(content, 'utf-8').toString('base64');

      const updateResponse = await fetch(githubApiUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'REX-Cloud-Backend'
        },
        body: JSON.stringify({
          message: message || 'Aktualizacja kalendarza z REX Cloud',
          content: encodedContent,
          sha: currentSha
        })
      });

      if (!updateResponse.ok) {
        const error = await updateResponse.text();
        console.error('GitHub API error:', error);
        return res.status(updateResponse.status).json({ error: 'Failed to update calendar on GitHub' });
      }

      const updateData = await updateResponse.json();

      return res.status(200).json({
        success: true,
        message: 'Calendar updated successfully',
        sha: updateData.content.sha
      });
    }

    // Nieobsługiwana metoda
    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}
