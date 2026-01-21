export default async function handler(request, response) {
  // CORS
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO_OWNER = process.env.REPO_OWNER || 'szewczykmarcin12-coder';
  const REPO_NAME = process.env.REPO_NAME || 'rex-calendar';
  const FILE_PATH = process.env.FILE_PATH || 'kalendarz.ics';

  if (!GITHUB_TOKEN) {
    return response.status(500).json({ success: false, error: 'GitHub token not configured' });
  }

  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;

  try {
    if (request.method === 'GET') {
      const res = await fetch(url, {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'REX-Cloud'
        }
      });

      if (!res.ok) {
        const errorData = await res.text();
        return response.status(res.status).json({ success: false, error: 'GitHub fetch failed: ' + errorData });
      }

      const data = await res.json();
      const content = Buffer.from(data.content, 'base64').toString('utf-8');

      return response.status(200).json({
        success: true,
        content: content,
        sha: data.sha
      });
    }

    if (request.method === 'POST') {
      const { content, sha, message } = request.body;

      if (!content) {
        return response.status(400).json({ success: false, error: 'Content required' });
      }

      let currentSha = sha;
      if (!currentSha) {
        const getRes = await fetch(url, {
          headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'REX-Cloud'
          }
        });
        if (getRes.ok) {
          const getData = await getRes.json();
          currentSha = getData.sha;
        }
      }

      const updateRes = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'REX-Cloud'
        },
        body: JSON.stringify({
          message: message || 'Update from REX Cloud',
          content: Buffer.from(content, 'utf-8').toString('base64'),
          sha: currentSha
        })
      });

      if (!updateRes.ok) {
        const errorData = await updateRes.text();
        return response.status(updateRes.status).json({ success: false, error: 'GitHub update failed: ' + errorData });
      }

      const updateData = await updateRes.json();
      return response.status(200).json({
        success: true,
        sha: updateData.content.sha
      });
    }

    return response.status(405).json({ success: false, error: 'Method not allowed' });

  } catch (error) {
    return response.status(500).json({ success: false, error: error.message });
  }
}
